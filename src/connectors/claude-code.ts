/**
 * 连接器 · Claude Code 本机 transcript（免导出）
 *
 * 读 ~/.claude/projects/<项目目录>/<会话>.jsonl。这是**封号后依然留在你硬盘上**
 * 的那份数据——绝大多数人不知道它还在，这个连接器是整个插件最强的单点。
 *
 * 解析规则逐条移植自 MemoryHub 主库 scripts/ingest.py（已在真实数据上跑了半年）：
 * - 只收真实对话：user 的字符串内容 / assistant 的 text 块
 * - 跳过 tool_use / tool_result / thinking / isMeta 等噪声
 * - 故意只扫单层，排除 <session>/subagents/agent-*.jsonl 子代理 sidechain（低价值）
 */
import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { RawConversation, RawTurn, ScanResult } from '../types.ts'

/** 本机 Claude Code 会话根目录。 */
export function defaultRoot(): string {
  return join(homedir(), '.claude', 'projects')
}

/**
 * 消息 id：与主库 ingest.py 的 event_id() 同构，便于两版交叉核对条数。
 * 取 sha256 前 24 位十六进制。
 */
function turnId(convId: string, seq: number, role: string, text: string): string {
  return createHash('sha256')
    .update(`claude-code|${convId}|${seq}|${role}|${text}`, 'utf8')
    .digest('hex')
    .slice(0, 24)
}

/**
 * 一行 transcript → 对话轮次；非对话或空正文返回 undefined。
 *
 * assistant 的 content 是分块数组，只取 `type === 'text'` 的块并按行拼接——
 * thinking 块和 tool_use 块在这里被丢掉，它们不是"用户说过的话"。
 */
export function extractTurn(o: any): { role: 'user' | 'assistant'; text: string } | undefined {
  const t = o?.type
  if ((t !== 'user' && t !== 'assistant') || o?.isMeta === true) return undefined
  const content = o?.message?.content
  if (t === 'user') {
    if (typeof content === 'string' && content.trim() !== '') {
      return { role: 'user', text: content.trim() }
    }
    return undefined
  }
  if (!Array.isArray(content)) return undefined
  const text = content
    .filter((b: any) => b !== null && typeof b === 'object' && b.type === 'text')
    .map((b: any) => (typeof b.text === 'string' ? b.text : ''))
    .filter((s: string) => s !== '')
    .join('\n')
    .trim()
  return text === '' ? undefined : { role: 'assistant', text }
}

/** 把一个 transcript 文件解析成一个会话。空会话返回 undefined。 */
export async function parseTranscript(
  filePath: string,
): Promise<{ conversation?: RawConversation; skipped: number }> {
  const raw = await readFile(filePath, 'utf8')
  const lines = raw.split('\n')
  const turns: RawTurn[] = []
  let skipped = 0
  let convId = basename(filePath).replace(/\.jsonl$/, '')
  let project: string | undefined

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined || line.trim() === '') continue
    let o: any
    try {
      o = JSON.parse(line)
    } catch {
      skipped++
      continue
    }
    // sessionId / cwd 在任意一行出现即可采信，取第一次见到的。
    if (typeof o?.sessionId === 'string' && o.sessionId !== '') convId = o.sessionId
    if (project === undefined && typeof o?.cwd === 'string' && o.cwd !== '') project = o.cwd

    const turn = extractTurn(o)
    if (turn === undefined) {
      skipped++
      continue
    }
    turns.push({
      id: turnId(convId, i, turn.role, turn.text),
      role: turn.role,
      text: turn.text,
      ts: typeof o?.timestamp === 'string' ? o.timestamp : '',
      seq: i,
    })
  }

  if (turns.length === 0) return { skipped }
  return {
    conversation: { source: 'claude-code', convId, title: undefined, uri: filePath, project, turns },
    skipped,
  }
}

/**
 * 扫描本机全部 Claude Code 会话。
 *
 * `limitConversations` 控制单次处理量——默认只取**最近修改的 100 个会话**。
 * 这不是性能保护，是**成本保护**：后面每个会话都要过一次 LLM 提纯，
 * 8-17 涨价后无节制全量扫描会给用户一笔意外账单。
 */
export async function scanClaudeCode(options: {
  root?: string
  limitConversations?: number
  /**
   * 是否连子代理 sidechain（<会话>/subagents/agent-*.jsonl）一起收。
   *
   * 默认 false，与 MemoryHub 主库一致：子代理日志量常是主会话的十倍以上
   * （本机实测 7 : 89），但里面是工具流水而非"用户说过的话"，提纯性价比极低。
   */
  includeSubagents?: boolean
} = {}): Promise<{ conversations: RawConversation[]; result: ScanResult }> {
  const root = options.root ?? defaultRoot()
  const limit = options.limitConversations ?? 100
  const includeSubagents = options.includeSubagents ?? false
  const result: ScanResult = {
    source: 'claude-code',
    conversations: 0,
    turns: 0,
    skipped: 0,
    errors: [],
  }

  let projectDirs: string[]
  try {
    const entries = await readdir(root, { withFileTypes: true })
    projectDirs = entries.filter(e => e.isDirectory()).map(e => join(root, e.name))
  } catch (error) {
    result.errors.push({ uri: root, message: `无法读取 ${root}：${String(error)}` })
    return { conversations: [], result }
  }

  // 默认只取单层 *.jsonl，跳过 subagents/ 等子目录。
  const files: { path: string; mtimeMs: number }[] = []
  for (const dir of projectDirs) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true, recursive: includeSubagents })
    } catch (error) {
      result.errors.push({ uri: dir, message: String(error) })
      continue
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      const path = join(entry.parentPath ?? dir, entry.name)
      try {
        files.push({ path, mtimeMs: (await stat(path)).mtimeMs })
      } catch (error) {
        result.errors.push({ uri: path, message: String(error) })
      }
    }
  }

  // 最近修改的优先——用户最想搬的是近期的记忆。
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const picked = limit > 0 ? files.slice(0, limit) : files

  const conversations: RawConversation[] = []
  for (const file of picked) {
    try {
      const { conversation, skipped } = await parseTranscript(file.path)
      result.skipped += skipped
      if (conversation === undefined) continue
      conversations.push(conversation)
      result.conversations++
      result.turns += conversation.turns.length
    } catch (error) {
      result.errors.push({ uri: file.path, message: String(error) })
    }
  }
  return { conversations, result }
}

/** 本机可搬的会话总量——面板在开跑前先告诉用户"你有多少东西可搬"。 */
export async function countAvailable(root = defaultRoot()): Promise<number> {
  let total = 0
  try {
    const entries = await readdir(root, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const inner = await readdir(join(root, entry.name), { withFileTypes: true })
      total += inner.filter(e => e.isFile() && e.name.endsWith('.jsonl')).length
    }
  } catch {
    return 0
  }
  return total
}
