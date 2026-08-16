/**
 * 记忆存储：只追加 JSONL（呼应宿主"只追加会话日志"的哲学），启动时装载重建内存态。
 *
 * 三个文件，各自只追加、互不覆写：
 * - `memories.jsonl` —— 已入库的记忆
 * - `pending.jsonl`  —— 待你确认的候选
 * - `decisions.jsonl`—— 你的批准 / 丢弃决定
 *
 * 为什么决定单独记一份：**被你丢弃的候选不能复活**。下次再导入同一份对话时，
 * 同一条结论会再被提出来——decisions 是那道记住"你已经说过不要"的记忆。
 * 主库踩过这个坑（被拒候选反复回到队列），这里从一开始就避开。
 */
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { MemoryItem } from './types.ts'

/** 用户对一条候选的处置。 */
export type Decision = 'approved' | 'discarded'

interface DecisionRow {
  id: string
  decision: Decision
  at: string
}

/** 默认数据目录：与宿主同处 ~/.dsh 之下，不往用户项目里塞文件。 */
export function defaultDataDir(): string {
  return join(homedir(), '.dsh', 'memory-porter')
}

/** 逐行解析 JSONL，坏行跳过——一行写坏不该让整个记忆库打不开。 */
function parseLines<T>(text: string, onBad: (line: string) => void): T[] {
  const out: T[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      out.push(JSON.parse(line) as T)
    } catch {
      onBad(line)
    }
  }
  return out
}

async function readIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

export class MemoryStore {
  private readonly dir: string
  private readonly warn: (message: string) => void
  /** id → 已入库记忆。 */
  private readonly memories = new Map<string, MemoryItem>()
  /** id → 待确认候选。 */
  private readonly pending = new Map<string, MemoryItem>()
  /** id → 已做过的处置。被丢弃过的 id 永不再进队列。 */
  private readonly decisions = new Map<string, Decision>()
  private loaded = false

  constructor(dataDir: string | undefined, warn: (message: string) => void) {
    this.dir = dataDir ?? defaultDataDir()
    this.warn = warn
  }

  private path(name: string): string {
    return join(this.dir, name)
  }

  /** 装载磁盘状态。重复调用是安全的（只装载一次）。 */
  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    let bad = 0
    const onBad = (): void => {
      bad++
    }
    for (const row of parseLines<DecisionRow>(await readIfExists(this.path('decisions.jsonl')), onBad)) {
      if (row?.id !== undefined) this.decisions.set(row.id, row.decision)
    }
    for (const item of parseLines<MemoryItem>(await readIfExists(this.path('memories.jsonl')), onBad)) {
      if (item?.id !== undefined) this.memories.set(item.id, item)
    }
    for (const item of parseLines<MemoryItem>(await readIfExists(this.path('pending.jsonl')), onBad)) {
      // 已处置过的不再回到队列。
      if (item?.id !== undefined && !this.decisions.has(item.id)) this.pending.set(item.id, item)
    }
    if (bad > 0) this.warn(`memory-porter: 跳过 ${bad} 行损坏的存储记录`)
  }

  private async append(name: string, rows: readonly unknown[]): Promise<void> {
    if (rows.length === 0) return
    await mkdir(this.dir, { recursive: true })
    const payload = rows.map(row => JSON.stringify(row)).join('\n') + '\n'
    await appendFile(this.path(name), payload, 'utf8')
  }

  /** 库内全部记忆，供保真闸做跨批次去重与矛盾检出。 */
  all(): MemoryItem[] {
    return [...this.memories.values()]
  }

  /** 待确认队列，按置信度从低到高——最需要你看一眼的排在前面。 */
  queue(): MemoryItem[] {
    return [...this.pending.values()].sort((a, b) => a.confidence - b.confidence)
  }

  /** 这条是否已被处置过（用于过闸前预筛，避免重复打扰）。 */
  decided(id: string): boolean {
    return this.decisions.has(id)
  }

  /** 写入一批过闸结果。已处置过的 id 会被静默跳过。 */
  async write(accepted: readonly MemoryItem[], pending: readonly MemoryItem[]): Promise<{
    accepted: number
    pending: number
    skipped: number
  }> {
    await this.load()
    let skipped = 0
    const freshAccepted: MemoryItem[] = []
    const freshPending: MemoryItem[] = []

    for (const item of accepted) {
      if (this.decisions.has(item.id) || this.memories.has(item.id)) {
        skipped++
        continue
      }
      this.memories.set(item.id, item)
      freshAccepted.push(item)
    }
    for (const item of pending) {
      if (this.decisions.has(item.id) || this.memories.has(item.id) || this.pending.has(item.id)) {
        skipped++
        continue
      }
      this.pending.set(item.id, item)
      freshPending.push(item)
    }

    await this.append('memories.jsonl', freshAccepted)
    await this.append('pending.jsonl', freshPending)
    return { accepted: freshAccepted.length, pending: freshPending.length, skipped }
  }

  /**
   * 处置一条待确认候选。
   *
   * 批准 → 落进记忆库；丢弃 → 只记决定，**不再复活**。
   * 两种情况都把决定写进 decisions.jsonl，这是幂等与"不复活"的唯一依据。
   */
  async decide(id: string, decision: Decision, now = new Date()): Promise<boolean> {
    await this.load()
    const item = this.pending.get(id)
    if (item === undefined) return false
    this.pending.delete(id)
    this.decisions.set(id, decision)
    if (decision === 'approved') {
      const approved: MemoryItem = { ...item, status: '已应用' }
      this.memories.set(id, approved)
      await this.append('memories.jsonl', [approved])
    }
    await this.append('decisions.jsonl', [{ id, decision, at: now.toISOString() }])
    return true
  }

  /** 面板顶部的那几个数字。 */
  summary(): { memories: number; pending: number; decided: number; bySource: Record<string, number> } {
    const bySource: Record<string, number> = {}
    for (const item of this.memories.values()) {
      for (const source of item.sources) {
        bySource[source.source] = (bySource[source.source] ?? 0) + 1
      }
    }
    return {
      memories: this.memories.size,
      pending: this.pending.size,
      decided: this.decisions.size,
      bySource,
    }
  }

  /**
   * 导出为通用 Markdown —— **这是"做上游不做竞品"策略的物理实现**：
   * 生态里其他记忆插件能直接吃这份产物。
   */
  exportMarkdown(): string {
    const lines = ['# 记忆搬家导出', '']
    for (const item of this.memories.values()) {
      lines.push(`## ${item.claim}`, '')
      lines.push(`- 类型：${item.type}`)
      lines.push(`- 置信度：${item.confidence}`)
      lines.push(`- 生效：${item.validFrom}${item.validUntil === null ? '（现行）' : ` → ${item.validUntil}`}`)
      lines.push(`- 来源：${item.sources.map(s => `${s.source}:${s.convId}`).join('、')}`)
      if (item.context !== undefined) lines.push(`- 情境：${item.context}`)
      lines.push('', '> ' + item.evidence.split('\n').join('\n> '), '')
    }
    return lines.join('\n')
  }

  /** 导出为 JSONL，一行一条，喂给别的插件最省事。 */
  exportJsonl(): string {
    return this.all().map(item => JSON.stringify(item)).join('\n')
  }

  /**
   * 原子写出一份导出文件：先写临时文件再 rename，
   * 避免用户在写到一半时读到半截文件。
   */
  async exportTo(path: string, format: 'md' | 'jsonl'): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.tmp`
    await writeFile(temporary, format === 'md' ? this.exportMarkdown() : this.exportJsonl(), 'utf8')
    await rename(temporary, path)
  }
}
