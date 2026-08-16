/**
 * 提纯：对话原文 → 带逐字证据的候选记忆。
 *
 * 两条不能让步的规矩：
 * 1. **借宿主的模型**——用 `ctx.agentDefaultModel` 选出的 provider/model 走
 *    `ctx.llm.stream()`，用户不为本插件配任何 key。
 * 2. **逐字证据机械校验**——模型返回的 evidence 必须**确实逐字出现在原文里**，
 *    由代码核对，不信模型的自述。核不上就丢掉。这是硬防幻觉的那道闸，
 *    也是"带逐字证据"这句宣传语唯一站得住的理由。
 */
import type { Candidate, LlmSlice, MemoryType, RawConversation, SourcePointer } from './types.ts'

/** 保真契约 v1 允许的记忆类型，模型返回表外类型一律降级为「认知」。 */
const MEMORY_TYPES: readonly MemoryType[] = [
  '方法论', '决策', '经验', 'SOP', '认知', '反馈', '事实', '偏好', '关系',
]

/**
 * 单次喂给模型的原文字符预算。
 *
 * 2.4 万字符 ≈ 1.2 万 tokens，远低于上下文上限——留出余量是为了让模型
 * 有空间**逐字抄回证据**，而不是因为怕超长而概括。
 */
const CHUNK_CHARS = 24_000

/** 并发上限。提纯是花钱操作，宁可慢也不要一口气打满对方限流。 */
const CONCURRENCY = 3

const SYSTEM_PROMPT = `你是一个记忆提炼器。用户会给你一段他与 AI 的历史对话，你要从中挑出**值得长期记住**的结论。

四重提纯过滤器，四条**全部**满足才算数：
1. 洞察：是判断、结论或原则，不是流水账、不是当时的临时状态。
2. 行动：将来能指导做事，而不只是"知道了"。
3. 复用：换个场景仍然成立，不是一次性的具体操作。
4. 影响：动到了资源、方向或收入——这条为"是"时必须标记 impact=true。

硬性要求：
- evidence 必须从原文里**逐字复制**，一个字都不能改写、不能拼接、不能补标点。宁可少提，不许改写。
- 找不到能逐字支撑的原文，就不要产出这条。
- claim 要自包含：脱离上下文单独读也能读懂。
- 只提炼**用户的**判断与偏好，不要把 AI 说的话当成用户的结论。

只输出 JSON 数组，不要任何解释、不要 markdown 代码围栏。每项：
{"type":"方法论|决策|经验|SOP|认知|反馈|事实|偏好|关系","claim":"一句话结论","evidence":"逐字原文","context":"情境，可省略","impact":true|false}

没有任何值得记的，就输出 []。`

/** 把会话渲染成喂给模型的纯文本，同时作为逐字校验的比对基准。 */
export function renderConversation(turns: readonly { role: string; text: string }[]): string {
  return turns.map(t => `${t.role === 'user' ? '用户' : 'AI'}：${t.text}`).join('\n\n')
}

/**
 * 按字符预算切块，**只在消息边界切**——从一条消息中间切断会让证据没法逐字对上。
 * 单条消息本身超预算时独占一块（宁可超，也不切碎证据）。
 */
export function chunkTurns<T extends { text: string }>(turns: readonly T[], budget = CHUNK_CHARS): T[][] {
  const chunks: T[][] = []
  let current: T[] = []
  let size = 0
  for (const turn of turns) {
    const length = turn.text.length
    if (current.length > 0 && size + length > budget) {
      chunks.push(current)
      current = []
      size = 0
    }
    current.push(turn)
    size += length
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/**
 * 从模型输出里抠出 JSON 数组。
 *
 * 模型时不时会套一层 ```json 围栏或在前后加话，这里按最外层方括号截取，
 * 而不是要求它守规矩——守不守规矩不该决定用户的记忆能不能搬成。
 */
export function extractJsonArray(text: string): unknown[] {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end === -1 || end <= start) return []
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * 归一化空白后判断证据是否逐字出现在原文里。
 *
 * 只容忍空白差异（模型常把换行吃成空格），**不容忍任何字符增删改**。
 * 这是我们唯一放宽的一处，放宽它是因为换行差异不改变"他确实这么说过"。
 */
export function isVerbatim(evidence: string, source: string): boolean {
  const normalize = (s: string): string => s.replace(/\s+/g, '')
  const needle = normalize(evidence)
  if (needle.length < 8) return false // 太短的"证据"没有证明力，也极易碰巧命中
  return normalize(source).includes(needle)
}

/** 把模型返回的一项转成候选；任何一步不合格就返回 undefined（宁可丢掉）。 */
export function toCandidate(item: unknown, source: SourcePointer, sourceText: string): Candidate | undefined {
  if (item === null || typeof item !== 'object') return undefined
  const record = item as Record<string, unknown>
  const claim = typeof record.claim === 'string' ? record.claim.trim() : ''
  const evidence = typeof record.evidence === 'string' ? record.evidence.trim() : ''
  if (claim === '' || evidence === '') return undefined
  if (!isVerbatim(evidence, sourceText)) return undefined

  const rawType = typeof record.type === 'string' ? record.type.trim() : ''
  const type = (MEMORY_TYPES as readonly string[]).includes(rawType) ? (rawType as MemoryType) : '认知'
  const context = typeof record.context === 'string' && record.context.trim() !== ''
    ? record.context.trim()
    : undefined

  return {
    type,
    claim,
    evidence,
    context,
    source,
    // 命中影响过滤器 → 契约要求必须走人工闸。
    forceReview: record.impact === true,
  }
}

/** 一次提纯的产出与账单。 */
export interface DistillResult {
  candidates: Candidate[]
  /** 模型报回的真实用量（有多少算多少，拿不到就是 0）。 */
  usage: { inputTokens: number; outputTokens: number }
  /** 逐字校验没通过而被丢掉的条数——这个数字要显示给用户看，它证明闸门在工作。 */
  rejectedNotVerbatim: number
  errors: { uri: string; message: string }[]
}

/** 读完一次流式响应，拼出文本并收集用量。 */
async function collect(stream: AsyncIterable<any>): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  let text = ''
  let inputTokens = 0
  let outputTokens = 0
  for await (const chunk of stream) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text
    } else if (chunk?.type === 'usage' && chunk.usage !== undefined) {
      inputTokens = Number(chunk.usage.inputTokens ?? 0) || 0
      outputTokens = Number(chunk.usage.outputTokens ?? 0) || 0
    }
  }
  return { text, inputTokens, outputTokens }
}

/** 简单的并发闸：按 limit 分批跑，够用且好读。 */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += limit) {
    out.push(...await Promise.all(items.slice(i, i + limit).map(fn)))
  }
  return out
}

export interface DistillOptions {
  llm: LlmSlice
  provider: string
  model: string
  signal?: AbortSignal
  /** 单次喂入的原文字符预算，默认 24000。 */
  chunkChars?: number
  /** 并发上限，默认 3。 */
  concurrency?: number
  /** 每完成一块回调一次，供面板画进度条。 */
  onProgress?: (done: number, total: number) => void
}

/**
 * 提纯一批会话。
 *
 * 单块失败只记错、不中断整轮——搬到一半因为一条网络抖动全废，是最劝退的体验。
 */
export async function distill(
  conversations: readonly RawConversation[],
  options: DistillOptions,
): Promise<DistillResult> {
  const chunkChars = options.chunkChars ?? CHUNK_CHARS
  const concurrency = options.concurrency ?? CONCURRENCY

  const jobs: { conversation: RawConversation; turns: RawConversation['turns'] }[] = []
  for (const conversation of conversations) {
    for (const turns of chunkTurns(conversation.turns, chunkChars)) {
      jobs.push({ conversation, turns })
    }
  }

  const result: DistillResult = {
    candidates: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    rejectedNotVerbatim: 0,
    errors: [],
  }
  let done = 0

  const parts = await mapLimit(jobs, concurrency, async job => {
    const sourceText = renderConversation(job.turns)
    const source: SourcePointer = {
      source: job.conversation.source,
      convId: job.conversation.convId,
      uri: job.conversation.uri,
      seq: job.turns[0]?.seq,
      ts: job.turns[0]?.ts,
    }
    try {
      const { text, inputTokens, outputTokens } = await collect(options.llm.stream({
        provider: options.provider,
        model: options.model,
        system: SYSTEM_PROMPT,
        messages: [{
          id: `porter-${job.conversation.convId}-${job.turns[0]?.seq ?? 0}`,
          role: 'user',
          content: [{ type: 'text', text: sourceText }],
        }],
        temperature: 0,
        signal: options.signal,
      }))
      const candidates: Candidate[] = []
      let rejected = 0
      for (const item of extractJsonArray(text)) {
        const candidate = toCandidate(item, source, sourceText)
        if (candidate === undefined) rejected++
        else candidates.push(candidate)
      }
      return { candidates, rejected, inputTokens, outputTokens, error: undefined }
    } catch (error) {
      return {
        candidates: [],
        rejected: 0,
        inputTokens: 0,
        outputTokens: 0,
        error: { uri: job.conversation.uri ?? job.conversation.convId, message: String(error) },
      }
    } finally {
      done++
      options.onProgress?.(done, jobs.length)
    }
  })

  for (const part of parts) {
    result.candidates.push(...part.candidates)
    result.rejectedNotVerbatim += part.rejected
    result.usage.inputTokens += part.inputTokens
    result.usage.outputTokens += part.outputTokens
    if (part.error !== undefined) result.errors.push(part.error)
  }
  return result
}
