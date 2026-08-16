/**
 * 连接器 · Claude 云端记忆（导出 zip 里的 memories.json）
 *
 * 这是 Claude **对你的 AI 推断记忆**，本身已经是提炼过的结论——所以它直接产出
 * 候选，不经过 LLM 提纯（省掉这部分 token，是整条导入链路里唯一零成本的来源）。
 *
 * ⚠️ 代价是它并非"你逐字说过的话"，而是模型的归纳。因此：
 * - `forceReview` 一律为 true，全部进人工闸等你确认，绝不自动入库；
 * - evidence 记的是 memories.json 里的原文（"Claude 确实这么写过"），
 *   不冒充"你确实这么说过"——两者的区别就是这个产品的信任基础。
 *
 * 解析规则移植自 MemoryHub 主库 scripts/ingest_claude_memories.py。
 */
import type { Candidate, SourcePointer } from '../types.ts'

/** 按顶层 `**标题**` 行切分正文 → [标题, 正文]。 */
export function splitSections(text: string): { title: string; body: string }[] {
  const out: { title: string; body: string }[] = []
  let title: string | undefined
  let buf: string[] = []
  const flush = (): void => {
    if (title !== undefined && buf.join('\n').trim() !== '') {
      out.push({ title, body: buf.join('\n').trim() })
    }
  }
  for (const line of text.split('\n')) {
    const m = /^\*\*(.+?)\*\*$/.exec(line.trim())
    if (m !== null && m[1] !== undefined) {
      flush()
      title = m[1]
      buf = []
    } else {
      buf.push(line)
    }
  }
  flush()
  return out
}

/**
 * 解析 memories.json → 候选列表。
 *
 * 三个字段各自成段：`conversations_memory`（按小节切）、`project_memories`
 * （每项一条）、`memory_files`（Claude 整理的 /areas/*.md 结构化记忆）。
 */
export function parseClaudeMemories(data: unknown, uri = 'memories.json'): Candidate[] {
  const m: any = Array.isArray(data) ? data[0] : data
  if (m === null || typeof m !== 'object') return []

  const source = (convId: string): SourcePointer => ({ source: 'claude-memory', convId, uri })
  const out: Candidate[] = []

  for (const { title, body } of splitSections(String(m.conversations_memory ?? ''))) {
    out.push({
      type: '认知',
      claim: `Claude 记忆 · ${title}`,
      evidence: body,
      context: 'claude.ai 云端记忆 · conversations_memory',
      source: source(`conv:${title}`),
      forceReview: true,
    })
  }

  const projects = m.project_memories
  if (projects !== null && typeof projects === 'object' && !Array.isArray(projects)) {
    for (const [key, value] of Object.entries<any>(projects)) {
      if (typeof value !== 'string' || value.trim() === '') continue
      out.push({
        type: '认知',
        claim: `Claude 项目记忆 · ${key.slice(0, 8)}`,
        evidence: value.trim(),
        context: 'claude.ai 云端记忆 · project_memories',
        source: source(`proj:${key}`),
        forceReview: true,
      })
    }
  }

  if (Array.isArray(m.memory_files)) {
    for (const file of m.memory_files) {
      const path = String(file?.path ?? '').trim()
      const content = String(file?.content ?? '').trim()
      if (content === '') continue
      out.push({
        type: '认知',
        claim: `Claude 记忆文件 · ${path === '' ? '(未命名)' : path}`,
        evidence: content,
        context: `claude.ai 云端记忆 · memory_files${path === '' ? '' : ` · ${path}`}`,
        source: source(`file:${path}`),
        forceReview: true,
      })
    }
  }

  return out
}
