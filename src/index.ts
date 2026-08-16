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
import type { HostContext, PorterConfig, RawConversation } from './types.ts'

export const name = 'memory-porter'

/**
 * `webServer` 必需；`llm` / `agentDefaultModel` 走可选注入 ——
 * 没挂载时插件照常提供扫描与导入，只是提纯那步如实报错，而不是整个插件加载失败。
 */
export const inject = { required: ['webServer'], optional: ['llm', 'agentDefaultModel'] }

/** 请求体上限：一份 ChatGPT 导出的路径 JSON 撑死几百字节，给足余量即可。 */
const MAX_BODY_BYTES = 64 * 1024

export function apply(ctx: HostContext, config: PorterConfig = {}): void {
  const scanLimit = config.scanLimit ?? 100

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
  function resolveModel(): { provider: string; model: string } | { error: string } {
    if (ctx.llm === undefined) return { error: '当前 dsh 没有挂载 llm 服务，无法提纯' }
    const selection = ctx.agentDefaultModel?.currentSelection()
    if (selection === undefined || selection.provider === '' || selection.model === '') {
      return { error: '读不到 dsh 的默认模型，请先在设置里选一个模型' }
    }
    return { provider: selection.provider, model: selection.model }
  }

  async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const headOnly = req.method === 'HEAD'
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    try {
      if (req.method === 'GET' || headOnly) {
        // 开跑前先告诉用户"你有多少东西可搬"——这是第一屏的那个数字。
        if (pathname === '/memory-porter/api/available') {
          const total = await countAvailable(config.claudeCodeRoot)
          sendJson(res, 200, { claudeCode: total, scanLimit }, headOnly)
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
          sendJson(res, 200, {
            results: imported.results,
            conversations: digest(imported.conversations),
            candidates: imported.candidates.length,
          })
          return
        }
        // 开跑前的预估：花多少钱、现在跑还是等空闲时段跑。
        if (pathname === '/memory-porter/api/estimate') {
          const body = (await readBody(req)) as { path?: unknown; limit?: unknown }
          const resolved = resolveModel()
          if ('error' in resolved) {
            sendJson(res, 409, { error: resolved.error })
            return
          }
          const conversations = await collectConversations(body)
          const texts = conversations.map(c => renderConversation(c.turns))
          sendJson(res, 200, {
            conversations: conversations.length,
            estimate: estimateCost(texts, resolved.model, Date.now()),
          })
          return
        }
        // 真花钱的那一步：用户在面板上看过预估、点了确认才会走到这里。
        if (pathname === '/memory-porter/api/distill') {
          const body = (await readBody(req)) as { path?: unknown; limit?: unknown; confirm?: unknown }
          if (body?.confirm !== true) {
            sendJson(res, 400, { error: '缺少 confirm —— 提纯要花钱，必须先看预估再确认' })
            return
          }
          const resolved = resolveModel()
          if ('error' in resolved) {
            sendJson(res, 409, { error: resolved.error })
            return
          }
          const conversations = await collectConversations(body)
          const result = await distill(conversations, {
            llm: ctx.llm!,
            provider: resolved.provider,
            model: resolved.model,
          })
          sendJson(res, 200, {
            conversations: conversations.length,
            candidates: result.candidates.length,
            rejectedNotVerbatim: result.rejectedNotVerbatim,
            usage: result.usage,
            errors: result.errors,
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

  ctx.logger.info(`memory-porter: ready (scanLimit=${scanLimit})`)
}
