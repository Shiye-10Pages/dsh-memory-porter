/**
 * dsh-memory-porter · 记忆搬家（host 半）
 *
 * 把 Claude Code / Claude 导出 / ChatGPT 导出里的历史对话搬进 DSH。
 * 本文件只负责接缝：路由注册 + 调度连接器。解析脏活在 src/connectors/。
 *
 * 浏览器半（lib/client.js）由 dsh Web 的客户端模块系统按 dsh.client 声明加载。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { countAvailable, importPath, scanClaudeCode } from './connectors/index.ts'
import { estimateCost } from './cost.ts'
import { distill, renderConversation } from './distill.ts'
import { gate } from './gate.ts'
import { formatHits, RecallIndex } from './recall.ts'
import { MemoryStore } from './store.ts'
import type {
  Candidate,
  DefaultModelSlice,
  HostContext,
  LlmSlice,
  PorterConfig,
  RawConversation,
  ToolsSlice,
} from './types.ts'

export const name = 'memory-porter'

/**
 * **只声明真正必需的那一个。**
 *
 * 这版 Cordis 的 `inject` 没有可选语义：数组里的每一项都是硬依赖，等不到就
 * 永远停在 pending；对象形态会被当成「服务名 → 配置」的映射，写
 * `{required:[...], optional:[...]}` 会让它去等两个名叫 required / optional
 * 的服务（真机首次启动就是这么炸的）。
 *
 * 所以 `llm` / `agentDefaultModel` 在用的时候用 `ctx.get()` 现取，
 * `tools` 用 `ctx.inject()` 等它就绪后再注册——没有它们插件照样能扫描、能导入。
 */
export const inject = ['webServer']

/** 请求体上限：一份 ChatGPT 导出的路径 JSON 撑死几百字节，给足余量即可。 */
const MAX_BODY_BYTES = 64 * 1024

export function apply(ctx: HostContext, config: PorterConfig = {}): void {
  const scanLimit = config.scanLimit ?? 100
  const store = new MemoryStore(config.dataDir, message => ctx.logger.warn(message))
  void store.load().then(() => {
    const summary = store.summary()
    ctx.logger.info(`memory-porter: ready (${summary.memories} 条记忆 · ${summary.pending} 条待确认)`)
  })

  /**
   * 检索索引。记忆库一变就作废，下次召回时重建——记忆量级小（几百到几千条），
   * 重建比维护增量索引便宜也不容易错。
   */
  let index: RecallIndex | undefined
  const invalidateIndex = (): void => {
    index = undefined
  }
  const currentIndex = (): RecallIndex => {
    if (index === undefined) index = new RecallIndex(store.all())
    return index
  }

  /** 过闸 + 落盘。候选来自提纯，或来自 Claude 云端记忆这类直采源。 */
  async function ingest(candidates: readonly Candidate[], byLlm: boolean) {
    const result = gate(candidates, {
      existing: store.all(),
      byLlm,
      reviewMode: config.reviewMode,
    })
    const written = await store.write(result.accepted, result.pending)
    invalidateIndex()
    return {
      accepted: written.accepted,
      pending: written.pending,
      skipped: written.skipped,
      rejected: result.rejected,
      merged: result.merged,
      nearPairs: result.nearPairs.length,
    }
  }

  function sendJson(res: ServerResponse, status: number, body: unknown, headOnly = false): void {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(Buffer.byteLength(payload)),
      'cache-control': 'no-store',
    })
    // HEAD 只回头部：带 body 违反 HTTP 语义。
    res.end(headOnly ? undefined : payload)
  }

  async function readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      const buf = chunk as Buffer
      size += buf.length
      if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
      chunks.push(buf)
    }
    if (chunks.length === 0) return {}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }

  /** 会话摘要——面板只需要知道搬到了什么，不需要把全文回传浏览器。 */
  function digest(conversations: { source: string; convId: string; title?: string; turns: unknown[] }[]) {
    return conversations.map(c => ({
      source: c.source,
      convId: c.convId,
      title: c.title ?? null,
      turns: c.turns.length,
    }))
  }

  /** 按请求体取一批会话：不给 path 就扫本机 Claude Code。 */
  async function collectConversations(body: { path?: unknown; limit?: unknown }): Promise<RawConversation[]> {
    if (typeof body?.path === 'string' && body.path !== '') {
      return (await importPath(body.path)).conversations
    }
    const limit = typeof body?.limit === 'number' ? body.limit : scanLimit
    return (await scanClaudeCode({ root: config.claudeCodeRoot, limitConversations: limit })).conversations
  }

  /**
   * 解析出宿主当前的 provider/model。
   *
   * 拿不到就说明这套 dsh 没挂 llm 或默认模型服务——如实回错，
   * 不去猜一个模型名替用户花钱。
   */
  /**
   * 定下这次提纯用哪个模型。优先级由近及远：
   * 面板这次选的 → `config.distillModel` → 宿主默认模型。
   *
   * 拿不到就如实报错，绝不猜一个模型名替用户花钱。
   */
  function resolveModel(
    override?: { provider?: unknown; model?: unknown },
  ): { provider: string; model: string; source: string; llm: LlmSlice } | { error: string } {
    const llm = ctx.get<LlmSlice>('llm')
    if (llm === undefined) return { error: '当前 dsh 没有挂载 llm 服务，无法提纯' }

    if (typeof override?.provider === 'string' && typeof override?.model === 'string'
      && override.provider !== '' && override.model !== '') {
      return { provider: override.provider, model: override.model, source: '本次选择', llm }
    }
    const configured = config.distillModel
    if (configured !== undefined && configured.provider !== '' && configured.model !== '') {
      return { ...configured, source: 'cordis.yml 的 distillModel', llm }
    }
    const selection = ctx.get<DefaultModelSlice>('agentDefaultModel')?.currentSelection()
    if (selection === undefined || selection.provider === '' || selection.model === '') {
      return { error: '读不到 dsh 的默认模型，请先在设置里选一个模型，或在面板上直接选一个' }
    }
    return { provider: selection.provider, model: selection.model, source: 'dsh 默认模型', llm }
  }

  /** 列出可选模型，供面板画选择器。发现失败的 provider 只跳过，不拖垮整张列表。 */
  async function listModels(): Promise<{ provider: string; id: string; name: string }[]> {
    const llm = ctx.get<LlmSlice>('llm')
    if (llm === undefined) return []
    const out: { provider: string; id: string; name: string }[] = []
    for (const provider of llm.listProviders()) {
      try {
        for (const model of await llm.listModels(provider.id)) {
          out.push({ provider: provider.id, id: model.id, name: model.name || model.id })
        }
      } catch (error) {
        ctx.logger.warn(`memory-porter: 列举 ${provider.id} 的模型失败：${String(error)}`)
      }
    }
    return out
  }

  async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const headOnly = req.method === 'HEAD'
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    try {
      if (req.method === 'GET' || headOnly) {
        // 开跑前先告诉用户"你有多少东西可搬"——这是第一屏的那个数字。
        if (pathname === '/memory-porter/api/available') {
          const total = await countAvailable(config.claudeCodeRoot)
          sendJson(res, 200, { claudeCode: total, scanLimit, ...store.summary() }, headOnly)
          return
        }
        if (pathname === '/memory-porter/api/queue') {
          sendJson(res, 200, { queue: store.queue() }, headOnly)
          return
        }
        // 可选模型清单 + 当前会用哪个、为什么是它，供面板画选择器。
        if (pathname === '/memory-porter/api/models') {
          const resolved = resolveModel()
          sendJson(res, 200, {
            models: await listModels(),
            current: 'error' in resolved
              ? undefined
              : { provider: resolved.provider, model: resolved.model, source: resolved.source },
          }, headOnly)
          return
        }
        if (pathname === '/memory-porter/api/memories') {
          sendJson(res, 200, { memories: store.all() }, headOnly)
          return
        }
        // 导出给其他记忆插件吃 —— 「做上游不做竞品」的物理实现。
        if (pathname === '/memory-porter/api/export') {
          const format = new URL(req.url ?? '/', 'http://localhost').searchParams.get('format')
          const jsonl = format === 'jsonl'
          const body = jsonl ? store.exportJsonl() : store.exportMarkdown()
          res.writeHead(200, {
            'content-type': jsonl ? 'application/x-ndjson; charset=utf-8' : 'text/markdown; charset=utf-8',
            'content-length': String(Buffer.byteLength(body)),
            'cache-control': 'no-store',
          })
          res.end(headOnly ? undefined : body)
          return
        }
        sendJson(res, 404, { error: 'not found' }, headOnly)
        return
      }

      if (req.method === 'POST') {
        // 扫描本机 Claude Code（免导出）。
        if (pathname === '/memory-porter/api/scan') {
          const body = (await readBody(req)) as { limit?: number }
          const limit = typeof body?.limit === 'number' ? body.limit : scanLimit
          const { conversations, result } = await scanClaudeCode({
            root: config.claudeCodeRoot,
            limitConversations: limit,
          })
          sendJson(res, 200, { result, conversations: digest(conversations) })
          return
        }
        // 导入一个本机路径：导出 zip / conversations.json / 已解压目录。
        if (pathname === '/memory-porter/api/import') {
          const body = (await readBody(req)) as { path?: unknown }
          if (typeof body?.path !== 'string' || body.path === '') {
            sendJson(res, 400, { error: '缺少 path' })
            return
          }
          const imported = await importPath(body.path)
          // Claude 云端记忆已经是结论，无需提纯，直接过闸落盘（零 token 成本）。
          const ingested = imported.candidates.length > 0
            ? await ingest(imported.candidates, false)
            : undefined
          sendJson(res, 200, {
            results: imported.results,
            conversations: digest(imported.conversations),
            candidates: imported.candidates.length,
            ingested,
          })
          return
        }
        // 开跑前的预估：花多少钱、现在跑还是等空闲时段跑。
        if (pathname === '/memory-porter/api/estimate') {
          const body = (await readBody(req)) as
            { path?: unknown; limit?: unknown; provider?: unknown; model?: unknown }
          const resolved = resolveModel(body)
          if ('error' in resolved) {
            sendJson(res, 409, { error: resolved.error })
            return
          }
          const conversations = await collectConversations(body)
          const texts = conversations.map(c => renderConversation(c.turns))
          sendJson(res, 200, {
            conversations: conversations.length,
            estimate: estimateCost(texts, resolved.model, Date.now()),
            provider: resolved.provider,
            // 模型是哪来的，明说 —— 花钱的决定不该靠猜。
            modelSource: resolved.source,
          })
          return
        }
        // 真花钱的那一步：用户在面板上看过预估、点了确认才会走到这里。
        if (pathname === '/memory-porter/api/distill') {
          const body = (await readBody(req)) as
            { path?: unknown; limit?: unknown; confirm?: unknown; provider?: unknown; model?: unknown }
          if (body?.confirm !== true) {
            sendJson(res, 400, { error: '缺少 confirm —— 提纯要花钱，必须先看预估再确认' })
            return
          }
          const resolved = resolveModel(body)
          if ('error' in resolved) {
            sendJson(res, 409, { error: resolved.error })
            return
          }
          const conversations = await collectConversations(body)
          const result = await distill(conversations, {
            llm: resolved.llm,
            provider: resolved.provider,
            model: resolved.model,
          })
          const ingested = await ingest(result.candidates, true)
          sendJson(res, 200, {
            conversations: conversations.length,
            candidates: result.candidates.length,
            rejectedNotVerbatim: result.rejectedNotVerbatim,
            usage: result.usage,
            errors: result.errors,
            ingested,
            model: resolved.model,
            modelSource: resolved.source,
          })
          return
        }
        // 逐条批准 / 丢弃。丢弃只记决定，那条候选不会再回到队列。
        if (pathname === '/memory-porter/api/decide') {
          const body = (await readBody(req)) as { id?: unknown; decision?: unknown }
          const id = typeof body?.id === 'string' ? body.id : ''
          const decision = body?.decision
          if (id === '' || (decision !== 'approved' && decision !== 'discarded')) {
            sendJson(res, 400, { error: '需要 id 与 decision(approved|discarded)' })
            return
          }
          const ok = await store.decide(id, decision)
          if (ok) invalidateIndex()
          sendJson(res, ok ? 200 : 404, ok ? store.summary() : { error: '队列里没有这条' })
          return
        }
        // 面板里试召回，验证"搬进来的东西真的能被找到"。
        if (pathname === '/memory-porter/api/recall') {
          const body = (await readBody(req)) as { query?: unknown; topk?: unknown }
          const query = typeof body?.query === 'string' ? body.query : ''
          const topk = typeof body?.topk === 'number' ? body.topk : 6
          await store.load()
          const hits = currentIndex().search(query, topk)
          sendJson(res, 200, {
            count: hits.length,
            hits: hits.map(hit => ({ score: hit.score, ...hit.item })),
          })
          return
        }
        sendJson(res, 404, { error: 'not found' })
        return
      }

      sendJson(res, 405, { error: 'method not allowed' })
    } catch (error) {
      // 搬家失败不该把船弄沉：如实回错，不抛出到宿主。
      ctx.logger.warn(`memory-porter: api error: ${String(error)}`)
      sendJson(res, 500, { error: String(error) })
    }
  }

  ctx.effect(
    () => ctx.webServer.register({
      name: 'memory-porter-api',
      kind: 'prefix',
      path: '/memory-porter/api',
      handler,
    }),
    'memory-porter: api route',
  )

  // 把 recall_memory 注册成原生工具，模型可以直接调用。
  // 用 ctx.inject 等 tools 就绪：宿主没挂 tools 时这段永远不跑，插件本身照常激活
  // （面板可用，用户还能靠 MCP 桥接上主库）。
  ctx.inject(['tools'], toolCtx => {
    const tools = toolCtx.get<ToolsSlice>('tools')
    if (tools === undefined) return
    toolCtx.effect(
      () => tools.register({
        name: 'recall_memory',
        description:
          '从「记忆搬家」库里召回相关的长期记忆（决策 / 偏好 / 方法论 / 经验等），'
          + '返回带【逐字证据 + 来源 + 置信度】的记忆原子。'
          + '在需要回顾过往决定、了解用户既定偏好与业务背景、避免重复决策时调用。'
          + '标记为「待核」的条目尚未经用户确认，不得当成既定事实。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '自然语言问题或主题' },
            topk: { type: 'integer', description: '返回条数，默认 6', minimum: 1, maximum: 20 },
          },
          required: ['query'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              count: { type: 'integer' },
            },
            required: ['text', 'count'],
            additionalProperties: false,
          },
          render: (_args, value) => [{
            type: 'text',
            text: String((value as { text?: unknown })?.text ?? ''),
          }],
        },
        timeoutMs: 10_000,
        execute: async args => {
          const input = args as { query?: unknown; topk?: unknown }
          const query = typeof input?.query === 'string' ? input.query : ''
          const topk = typeof input?.topk === 'number' ? Math.min(20, Math.max(1, input.topk)) : 6
          await store.load()
          const hits = currentIndex().search(query, topk)
          return { text: formatHits(hits), count: hits.length }
        },
      }),
      'memory-porter: recall_memory tool',
    )
    toolCtx.logger.info('memory-porter: recall_memory 已注册')
  })

  ctx.logger.info(
    `memory-porter: ready (scanLimit=${scanLimit}, reviewMode=${config.reviewMode ?? 'balanced'})`,
  )
}
