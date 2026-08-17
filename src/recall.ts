/**
 * 召回：本地 BM25 检索，零依赖零 key。
 *
 * 为什么不做向量：DeepSeek 不提供嵌入接口，要语义召回就得让用户再配一家
 * 别的 provider——那就破坏了「装上就能用、一个字都不用填」的底线。
 * BM25 在"找回自己说过的话"这个场景里足够好用，因为用户查询词与原文高度重合。
 *
 * 中文没有词边界，所以切分用**字符二元组**：与 gate.ts 的判同主题同一套思路，
 * 对中文稳、零依赖、不需要词典。
 */
import { GATE_REASON_LABELS } from './gate.ts'
import type { MemoryItem } from './types.ts'

/** BM25 参数，用通行默认值。 */
const K1 = 1.5
const B = 0.75

/**
 * 切成检索词元：CJK 走字符二元组，拉丁与数字按词切。
 *
 * 混排（"用 MIT 协议"）两条规则各切各的，合起来就是这条记忆的词元集。
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  const lowered = text.toLowerCase()
  // 拉丁字母 / 数字连续段整体成词。
  for (const match of lowered.matchAll(/[a-z0-9]+/g)) tokens.push(match[0])
  // CJK 连续段切二元组；单字段落保留单字。
  for (const match of lowered.matchAll(/[一-鿿぀-ヿ가-힯]+/g)) {
    const run = [...match[0]]
    if (run.length === 1) {
      tokens.push(run[0]!)
      continue
    }
    for (let i = 0; i < run.length - 1; i++) tokens.push(run[i]! + run[i + 1]!)
  }
  return tokens
}

/** 一条记忆参与检索的正文：结论 + 证据 + 情境。 */
function documentText(item: MemoryItem): string {
  return [item.claim, item.evidence, item.context ?? ''].join('\n')
}

interface Document {
  item: MemoryItem
  /** 词元 → 该词在本文档出现次数 */
  freq: Map<string, number>
  length: number
}

/** 预先建好的检索索引。记忆库变动后重建即可（量级小，重建很便宜）。 */
export class RecallIndex {
  private readonly documents: Document[] = []
  private readonly documentFreq = new Map<string, number>()
  private averageLength = 0

  constructor(items: readonly MemoryItem[]) {
    for (const item of items) {
      const tokens = tokenize(documentText(item))
      const freq = new Map<string, number>()
      for (const token of tokens) freq.set(token, (freq.get(token) ?? 0) + 1)
      for (const token of freq.keys()) {
        this.documentFreq.set(token, (this.documentFreq.get(token) ?? 0) + 1)
      }
      this.documents.push({ item, freq, length: tokens.length })
    }
    const total = this.documents.reduce((sum, doc) => sum + doc.length, 0)
    this.averageLength = this.documents.length === 0 ? 0 : total / this.documents.length
  }

  get size(): number {
    return this.documents.length
  }

  /** 逆文档频率，用带平滑的 BM25 变体，避免高频词拿到负分。 */
  private idf(token: string): number {
    const n = this.documentFreq.get(token) ?? 0
    if (n === 0) return 0
    return Math.log(1 + (this.documents.length - n + 0.5) / (n + 0.5))
  }

  /**
   * 检索。返回按相关度降序的记忆及其得分。
   *
   * 已失效的记忆（`status === '已失效'`）默认排除——召回它们会让模型
   * 拿着过期结论办事，比召不回更糟。
   */
  search(query: string, topK = 6, includeExpired = false): { item: MemoryItem; score: number }[] {
    const queryTokens = tokenize(query)
    if (queryTokens.length === 0 || this.documents.length === 0) return []
    const unique = [...new Set(queryTokens)]

    const scored: { item: MemoryItem; score: number }[] = []
    for (const doc of this.documents) {
      if (!includeExpired && doc.item.status === '已失效') continue
      let score = 0
      for (const token of unique) {
        const tf = doc.freq.get(token)
        if (tf === undefined) continue
        const norm = tf * (K1 + 1) / (tf + K1 * (1 - B + B * (doc.length / (this.averageLength || 1))))
        score += this.idf(token) * norm
      }
      if (score > 0) scored.push({ item: doc.item, score: Number(score.toFixed(4)) })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, topK)
  }
}

/**
 * 把召回结果渲染成给模型看的文本。
 *
 * 每条都带**逐字证据 + 来源 + 入库依据**——模型（和读日志的人）据此判断
 * 该信到什么程度。待确认的条目会被明确标出来，不能被当成既定事实。
 */
export function formatHits(hits: readonly { item: MemoryItem; score: number }[]): string {
  if (hits.length === 0) {
    return '（没召回到相关记忆——库里可能没有，或相关度都太低。请勿据此臆断。）'
  }
  return hits.map((hit, index) => {
    const item = hit.item
    const pendingTag = item.status === '已应用' ? '' : '[待核·未经人工确认] '
    const sources = item.sources.map(s => `${s.source}:${s.convId}`).join('、')
    const lines = [
      `[${index + 1}] ${pendingTag}【${item.type}】(相关度 ${hit.score}，置信度 ${item.confidence}，${item.validFrom} 起，来源 ${sources})`,
    ]
    if (item.context !== undefined) lines.push(`情境: ${item.context}`)
    lines.push(`结论: ${item.claim}`)
    lines.push(`证据(逐字): ${item.evidence}`)
    lines.push(`入库依据: ${GATE_REASON_LABELS[item.gateReason] ?? item.gateReason}`)
    return lines.join('\n')
  }).join('\n\n')
}
