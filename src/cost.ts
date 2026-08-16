/**
 * 提纯成本预估。
 *
 * 搬家要把对话原文喂给模型，一次全量扫描是真花钱的——**开跑前必须把数字
 * 摆在用户面前**。本机实测：agentic 会话约 2 万 tokens/个，100 个会话
 * ≈ 200 万 tokens 输入。
 *
 * 价目表来源：DeepSeek 官方 2026-08-13 调价公告，2026-08-17 00:00(北京) 生效。
 * ⚠️ 这是**涨价**而非"空闲时段打折"：新的空闲价仍高于调价前的平价。
 * 改价只动这个文件；一切金额都在查询时现算，不固化。
 */

/** 单模型价目：每百万 tokens 的人民币价。 */
export interface Rates {
  /** 输入・缓存命中 */
  hit: number
  /** 输入・缓存未命中 */
  miss: number
  /** 输出 */
  out: number
}

export interface PricingEntry {
  /** 模型 id 匹配串（小写包含匹配，先长后短） */
  match: string
  /** 2026-08-17 之前的平价 */
  before: Rates
  /** 2026-08-17 起的高峰价 */
  peak: Rates
  /** 2026-08-17 起的空闲价（按官方公布值直写，不用系数推导） */
  offPeak: Rates
}

/** 价目表核对日期。 */
export const PRICING_VERSION = '2026-08-16'

/** 调价与错峰生效时刻：北京时间 2026-08-17 00:00 = UTC 2026-08-16 16:00。 */
export const REPRICE_EFFECTIVE_MS = Date.UTC(2026, 7, 16, 16, 0, 0)

/**
 * 高峰时段（UTC 小时区间，[start, end)）：
 * 北京 9:00-12:00 → UTC 1:00-4:00；北京 14:00-18:00 → UTC 6:00-10:00。
 */
export const PEAK_WINDOWS_UTC: readonly (readonly [number, number])[] = [
  [1, 4],
  [6, 10],
]

export const PRICING_TABLE: readonly PricingEntry[] = [
  {
    match: 'v4-flash',
    before: { hit: 0.02, miss: 1, out: 2 },
    peak: { hit: 0.1, miss: 3, out: 9 },
    offPeak: { hit: 0.05, miss: 1.5, out: 4.5 },
  },
  {
    match: 'v4-pro',
    before: { hit: 0.025, miss: 3, out: 6 },
    peak: { hit: 0.3, miss: 9, out: 27 },
    offPeak: { hit: 0.15, miss: 4.5, out: 13.5 },
  },
  // 旧模型名兜底（V3.2 时代统一价），错峰不适用。
  {
    match: 'deepseek-chat',
    before: { hit: 0.2, miss: 2, out: 3 },
    peak: { hit: 0.2, miss: 2, out: 3 },
    offPeak: { hit: 0.2, miss: 2, out: 3 },
  },
]

/** 该时刻是否处于高峰时段。调价生效前一律平价，谈不上高峰。 */
export function isPeak(atMs: number): boolean {
  if (atMs < REPRICE_EFFECTIVE_MS) return false
  const hour = new Date(atMs).getUTCHours()
  return PEAK_WINDOWS_UTC.some(([start, end]) => hour >= start && hour < end)
}

/** 取某模型在某时刻适用的价目。未知模型按表首估（会低估，面板需注明"估算"）。 */
export function ratesFor(model: string, atMs: number): Rates {
  const id = model.toLowerCase()
  const entry =
    [...PRICING_TABLE].sort((a, b) => b.match.length - a.match.length).find(e => id.includes(e.match)) ??
    PRICING_TABLE[0]!
  if (atMs < REPRICE_EFFECTIVE_MS) return entry.before
  return isPeak(atMs) ? entry.peak : entry.offPeak
}

/**
 * 粗估 token 数：中日韩字符 ≈ 0.6 token，其余 ≈ 0.3 token。
 *
 * 这是**估算**，只用来给用户一个量级判断；真实用量以模型返回的 usage 为准。
 */
export function estimateTokens(text: string): number {
  let cjk = 0
  let total = 0
  for (const ch of text) {
    total++
    const code = ch.codePointAt(0) ?? 0
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0x3400 && code <= 0x4dbf)
    ) {
      cjk++
    }
  }
  return Math.ceil(cjk * 0.6 + (total - cjk) * 0.3)
}

export interface CostEstimate {
  inputTokens: number
  /** 提纯的输出远小于输入，按输入的 8% 估。 */
  outputTokens: number
  /** 人民币，现算 */
  cny: number
  model: string
  peak: boolean
  /** 调价是否已生效——面板据此提示"现在跑还是等空闲时段跑" */
  repriced: boolean
  /** 同样的量放到空闲时段要多少钱，用来支撑"等半夜跑省一半"的提示 */
  offPeakCny: number
}

/** 估一次提纯要花多少钱。`atMs` 由调用方传入，便于测试与「如果半夜跑」对比。 */
export function estimateCost(texts: readonly string[], model: string, atMs: number): CostEstimate {
  const inputTokens = texts.reduce((sum, text) => sum + estimateTokens(text), 0)
  const outputTokens = Math.ceil(inputTokens * 0.08)
  const price = (rates: Rates): number =>
    Math.round(((inputTokens * rates.miss + outputTokens * rates.out) / 1_000_000) * 10_000) / 10_000

  const id = model.toLowerCase()
  const entry =
    [...PRICING_TABLE].sort((a, b) => b.match.length - a.match.length).find(e => id.includes(e.match)) ??
    PRICING_TABLE[0]!
  const repriced = atMs >= REPRICE_EFFECTIVE_MS

  return {
    inputTokens,
    outputTokens,
    cny: price(ratesFor(model, atMs)),
    offPeakCny: price(repriced ? entry.offPeak : entry.before),
    model,
    peak: isPeak(atMs),
    repriced,
  }
}
