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
import type { HostContext, PorterConfig } from './types.ts'

export const name = 'memory-porter'

export const inject = ['webServer']

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
