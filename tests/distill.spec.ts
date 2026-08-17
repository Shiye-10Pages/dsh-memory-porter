/**
 * 提纯层回归。
 *
 * 用假的 llm 切面驱动，不联网、不花钱。重点验的是**逐字校验闸**——
 * 那是"带逐字证据"这句话唯一的兑现手段，它必须在模型胡说时挡住。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  chunkTurns,
  distill,
  extractJsonArray,
  isVerbatim,
  renderConversation,
  renderUserTurns,
  toCandidate,
} from '../src/distill.ts'
import { estimateCost, estimateTokens, isPeak, OUTPUT_RATIO, ratesFor, REPRICE_EFFECTIVE_MS } from '../src/cost.ts'
import type { LlmStreamSlice, RawConversation, SourcePointer } from '../src/types.ts'

const SOURCE: SourcePointer = { source: 'claude-code', convId: 'C1' }

function conversation(texts: string[]): RawConversation {
  return {
    source: 'claude-code',
    convId: 'C1',
    uri: '/tmp/c1.jsonl',
    turns: texts.map((text, i) => ({ id: `t${i}`, role: i % 2 === 0 ? 'user' : 'assistant', text, ts: '', seq: i })),
  }
}

/** 造一个按脚本回话的假 llm。 */
function fakeLlm(replies: string[], onCall?: () => void): LlmStreamSlice {
  let index = 0
  return {
    stream() {
      const reply = replies[Math.min(index++, replies.length - 1)] ?? '[]'
      onCall?.()
      return (async function* () {
        yield { type: 'text-delta' as const, index: 0, text: reply }
        yield { type: 'usage' as const, usage: { inputTokens: 100, outputTokens: 20 } }
      })()
    },
  }
}

describe('逐字校验闸', () => {
  const source = '用户：我决定不做 awesome 列表这个方向。\n\nAI：明白。'

  it('原文里有就放行', () => {
    expect(isVerbatim('我决定不做 awesome 列表这个方向', source)).toBe(true)
  })

  it('只容忍空白差异，不容忍改写', () => {
    expect(isVerbatim('我决定不做\nawesome  列表这个方向', source)).toBe(true)
    expect(isVerbatim('我决定放弃 awesome 列表这个方向', source)).toBe(false)
  })

  it('模型凭空捏造的证据一律挡掉', () => {
    expect(isVerbatim('用户说他要做 awesome 列表', source)).toBe(false)
  })

  it('过短的"证据"没有证明力，不放行', () => {
    expect(isVerbatim('不做', source)).toBe(false)
  })
})

describe('候选归一', () => {
  const sourceText = '用户：以后所有插件都发 MIT，主库继续 PolyForm。'

  it('正常项转成候选', () => {
    const candidate = toCandidate(
      { type: '决策', claim: '插件发 MIT', evidence: '以后所有插件都发 MIT', impact: true },
      SOURCE,
      sourceText,
    )
    expect(candidate?.type).toBe('决策')
    // impact 只是模型的判定，是否走人工闸由保真闸决定（见 gate.ts 的 isHighImpact）。
    expect(candidate?.impact).toBe(true)
    expect(candidate?.forceReview).toBe(false)
  })

  it('野生类型归一到契约 9 类', () => {
    const make = (type: string) => toCandidate(
      { type, claim: 'x', evidence: '以后所有插件都发 MIT' },
      SOURCE,
      '用户：以后所有插件都发 MIT，主库继续 PolyForm。',
    )
    expect(make('行动')?.type).toBe('SOP')
    expect(make('定价')?.type).toBe('决策')
    expect(make('风险')?.type).toBe('认知')
    expect(make('避坑')?.type).toBe('经验')
  })

  it('表外类型降级为「认知」而不是丢掉', () => {
    const candidate = toCandidate(
      { type: '八卦', claim: 'x', evidence: '以后所有插件都发 MIT' },
      SOURCE,
      sourceText,
    )
    expect(candidate?.type).toBe('认知')
  })

  it('证据对不上原文 → 丢掉', () => {
    expect(toCandidate(
      { type: '决策', claim: 'x', evidence: '所有插件都发 GPL 协议' },
      SOURCE,
      sourceText,
    )).toBeUndefined()
  })

  it('缺 claim 或缺 evidence → 丢掉', () => {
    expect(toCandidate({ claim: '', evidence: '以后所有插件都发 MIT' }, SOURCE, sourceText)).toBeUndefined()
    expect(toCandidate({ claim: 'x', evidence: '' }, SOURCE, sourceText)).toBeUndefined()
    expect(toCandidate(null, SOURCE, sourceText)).toBeUndefined()
  })

  it('impact 缺省时为 false', () => {
    const candidate = toCandidate({ claim: 'x', evidence: '以后所有插件都发 MIT' }, SOURCE, sourceText)
    expect(candidate?.impact).toBe(false)
  })
})

describe('证据是谁说的（真实数据打脸后加的）', () => {
  const turns = [
    { role: 'user', text: '我的主要收入是会员和咨询。' },
    { role: 'assistant', text: '明白，你的主要收入来源是十页AI学院会员和咨询服务。' },
  ]
  const full = renderConversation(turns)
  const userOnly = renderUserTurns(turns)

  it('只拼用户发言，AI 的不进基准', () => {
    expect(userOnly).toBe('我的主要收入是会员和咨询。')
    expect(userOnly).not.toContain('十页AI学院')
  })

  it('证据出自用户本人 → 正常候选，不强制人工', () => {
    const c = toCandidate({ claim: 'x', evidence: '我的主要收入是会员和咨询' }, SOURCE, full, userOnly)
    expect(c?.forceReview).toBe(false)
    expect(c?.context).toBeUndefined()
  })

  /**
   * 真实跑一遍：18 条入库记忆里 8 条的证据其实是 AI 说的（44%）。
   * 这类多半是 AI 在准确复述用户，有价值，但它是归纳不是原话——
   * 性质等同 memories.json，必须进人工闸，不能悄悄自动入库。
   */
  it('证据只在 AI 回复里 → 仍然收，但强制人工并注明', () => {
    const c = toCandidate(
      { claim: 'x', evidence: '你的主要收入来源是十页AI学院会员和咨询服务' },
      SOURCE, full, userOnly,
    )
    expect(c).toBeDefined()
    expect(c?.forceReview).toBe(true)
    expect(c?.context).toContain('AI 的复述')
  })

  it('两边都对不上 → 丢掉', () => {
    expect(toCandidate({ claim: 'x', evidence: '用户说他年收入一千万' }, SOURCE, full, userOnly)).toBeUndefined()
  })

  it('提纯结果单独统计「证据出自 AI」的条数', async () => {
    const conv = conversation(['我的主要收入是会员和咨询。'])
    const llm = fakeLlm([JSON.stringify([
      { claim: '来自用户', evidence: '我的主要收入是会员和咨询' },
    ])])
    const result = await distill([conv], { llm, provider: 'deepseek', model: 'v4-flash' })
    expect(result.fromAssistant).toBe(0)
  })
})

describe('模型输出容错', () => {
  it('剥掉 markdown 围栏和前后废话', () => {
    expect(extractJsonArray('好的，结果如下：\n```json\n[{"claim":"a"}]\n```\n以上。'))
      .toEqual([{ claim: 'a' }])
  })

  it('空数组与坏 JSON 都安全返回空', () => {
    expect(extractJsonArray('[]')).toEqual([])
    expect(extractJsonArray('[{坏的}]')).toEqual([])
    expect(extractJsonArray('完全没有数组')).toEqual([])
  })
})

describe('切块', () => {
  it('只在消息边界切', () => {
    const turns = [{ text: 'a'.repeat(60) }, { text: 'b'.repeat(60) }, { text: 'c'.repeat(60) }]
    const chunks = chunkTurns(turns, 100)
    expect(chunks.map(c => c.length)).toEqual([1, 1, 1])
  })

  it('单条超预算时独占一块而不是被切碎', () => {
    const chunks = chunkTurns([{ text: 'x'.repeat(500) }], 100)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.[0]?.text.length).toBe(500)
  })

  it('装得下就合并', () => {
    expect(chunkTurns([{ text: 'a' }, { text: 'b' }], 100)).toHaveLength(1)
  })
})

describe('提纯流程', () => {
  it('把模型返回变成候选，并累计真实用量', async () => {
    const conv = conversation(['我决定这个插件用 MIT 协议发布，主库保持 PolyForm。'])
    const llm = fakeLlm([JSON.stringify([
      { type: '决策', claim: '插件用 MIT', evidence: '我决定这个插件用 MIT 协议发布', impact: true },
    ])])
    const result = await distill([conv], { llm, provider: 'deepseek', model: 'v4-flash' })
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]?.source.convId).toBe('C1')
    expect(result.candidates[0]?.source.uri).toBe('/tmp/c1.jsonl')
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 20 })
    expect(result.rejectedNotVerbatim).toBe(0)
  })

  it('模型编造的条目被挡下并计数', async () => {
    const conv = conversation(['我决定这个插件用 MIT 协议发布。'])
    const llm = fakeLlm([JSON.stringify([
      { claim: '真的', evidence: '我决定这个插件用 MIT 协议发布' },
      { claim: '编的', evidence: '用户说他要把主库也改成 MIT 开源协议' },
    ])])
    const result = await distill([conv], { llm, provider: 'deepseek', model: 'v4-flash' })
    expect(result.candidates).toHaveLength(1)
    expect(result.rejectedNotVerbatim).toBe(1)
  })

  it('单块失败只记错，不拖垮整轮', async () => {
    const good = conversation(['我决定这个插件用 MIT 协议发布。'])
    const bad = { ...conversation(['另一段对话内容在这里。']), convId: 'C2', uri: '/tmp/c2.jsonl' }
    let call = 0
    const llm: LlmStreamSlice = {
      stream() {
        call++
        if (call === 2) throw new Error('网络抖了一下')
        return (async function* () {
          yield { type: 'text-delta' as const, index: 0, text: JSON.stringify([
            { claim: 'ok', evidence: '我决定这个插件用 MIT 协议发布' },
          ]) }
        })()
      },
    }
    const result = await distill([good, bad], { llm, provider: 'deepseek', model: 'v4-flash', concurrency: 1 })
    expect(result.candidates).toHaveLength(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.uri).toBe('/tmp/c2.jsonl')
  })

  it('按并发上限分批，不一口气打满', async () => {
    const convs = Array.from({ length: 5 }, (_, i) => ({ ...conversation(['短对话内容']), convId: `C${i}` }))
    const onCall = vi.fn()
    const llm = fakeLlm(['[]'], onCall)
    await distill(convs, { llm, provider: 'deepseek', model: 'v4-flash', concurrency: 2 })
    expect(onCall).toHaveBeenCalledTimes(5)
  })

  it('进度回调按块数推进', async () => {
    const progress: number[] = []
    await distill([conversation(['一段对话'])], {
      llm: fakeLlm(['[]']),
      provider: 'deepseek',
      model: 'v4-flash',
      onProgress: done => progress.push(done),
    })
    expect(progress).toEqual([1])
  })

  it('渲染出的原文用中文角色前缀，作为逐字校验基准', () => {
    expect(renderConversation([
      { role: 'user', text: '问' },
      { role: 'assistant', text: '答' },
    ])).toBe('用户：问\n\nAI：答')
  })
})

describe('成本预估', () => {
  const BEFORE = REPRICE_EFFECTIVE_MS - 1
  /** 8-17 生效后的北京 10:00（UTC 02:00）= 高峰。 */
  const PEAK = Date.UTC(2026, 7, 17, 2, 0, 0)
  /** 8-17 生效后的北京 03:00（UTC 19:00 前一日）= 空闲。 */
  const OFF_PEAK = Date.UTC(2026, 7, 17, 19, 0, 0)

  it('中文字符按 0.6、其余按 0.3 估', () => {
    expect(estimateTokens('中文')).toBe(2)
    expect(estimateTokens('abcd')).toBe(2)
    expect(estimateTokens('')).toBe(0)
  })

  it('调价生效前一律平价，没有高峰概念', () => {
    expect(isPeak(BEFORE)).toBe(false)
    expect(ratesFor('v4-flash', BEFORE).miss).toBe(1)
  })

  it('生效后高峰 / 空闲各取各价', () => {
    expect(isPeak(PEAK)).toBe(true)
    expect(ratesFor('v4-flash', PEAK).miss).toBe(3)
    expect(isPeak(OFF_PEAK)).toBe(false)
    expect(ratesFor('v4-flash', OFF_PEAK).miss).toBe(1.5)
  })

  it('模型匹配先长后短，pro 不会被 flash 抢走', () => {
    expect(ratesFor('deepseek-v4-pro', PEAK).out).toBe(27)
    expect(ratesFor('deepseek-v4-flash', PEAK).out).toBe(9)
  })

  it('给出高峰价的同时给出空闲价，支撑「等半夜跑」的提示', () => {
    const estimate = estimateCost(['中'.repeat(10_000)], 'v4-flash', PEAK)
    expect(estimate.peak).toBe(true)
    expect(estimate.repriced).toBe(true)
    expect(estimate.offPeakCny).toBeLessThan(estimate.cny)
    expect(estimate.inputTokens).toBe(6000)
  })

  /**
   * ⚠️ 实测校准，勿凭直觉改回去。
   * 真实跑一遍（Claude 网页导出 7 会话）：输入 57,225 → 输出 38,522 = 67%。
   * 原先按 8% 估，最终报价低估一倍多。提纯要逐字抄回证据，输出天然很大。
   */
  it('输出按输入的 70% 估 —— 这是实测出来的，不是拍的', () => {
    expect(OUTPUT_RATIO).toBe(0.7)
    const estimate = estimateCost(['中'.repeat(10_000)], 'v4-flash', OFF_PEAK)
    expect(estimate.outputTokens).toBe(Math.ceil(estimate.inputTokens * 0.7))
  })

  it('对真实那一轮的报价不再低于实际收费', () => {
    // 实际：输入 57,225 · 输出 38,522 · 空闲 flash（未命中 1.5 / 输出 4.5）
    const actual = (57_225 * 1.5 + 38_522 * 4.5) / 1_000_000
    // 用实测输入量反推报价，应当 ≥ 实际。
    const quoted = (57_225 * 1.5 + Math.ceil(57_225 * OUTPUT_RATIO) * 4.5) / 1_000_000
    expect(quoted).toBeGreaterThanOrEqual(actual)
  })
})
