/**
 * 四道保真闸回归。
 *
 * 这层没有 IO、没有模型，全是纯逻辑——所以它必须被测死：
 * 它决定什么进你的记忆库、什么需要你亲自看一眼。
 */
import { describe, expect, it } from 'vitest'
import {
  AUTO_SAME,
  claimId,
  confidence,
  gate,
  isHighImpact,
  LOW_CONFIDENCE,
  normalize,
  passesProvenance,
  similarity,
  topicOverlap,
} from '../src/gate.ts'
import type { Candidate, MemoryItem } from '../src/types.ts'

const NOW = Date.UTC(2026, 7, 16, 12, 0, 0)

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    type: '决策',
    claim: '插件用 MIT 协议发布',
    evidence: '我决定这个插件用 MIT 协议发布，主库继续 PolyForm',
    source: { source: 'claude-code', convId: 'C1', uri: '/tmp/c1.jsonl' },
    impact: false,
    forceReview: false,
    ...overrides,
  }
}

describe('溯源闸', () => {
  it('有证据有来源 → 放行', () => {
    expect(passesProvenance(candidate())).toBe(true)
  })

  it('空证据 / 空结论 / 无来源 → 拒收', () => {
    expect(passesProvenance(candidate({ evidence: '   ' }))).toBe(false)
    expect(passesProvenance(candidate({ claim: '' }))).toBe(false)
    expect(passesProvenance(candidate({ source: { source: 'claude-code', convId: '' } }))).toBe(false)
  })

  it('被拒的条数如实计入 rejected', () => {
    const result = gate([candidate(), candidate({ evidence: '' })], { now: NOW })
    expect(result.rejected).toBe(1)
    expect(result.accepted.length + result.pending.length).toBe(1)
  })
})

describe('相似度与结论 id', () => {
  it('结论 id 忽略空白与大小写，保证跨批次幂等', () => {
    expect(claimId('插件用 MIT 协议')).toBe(claimId('插件用MIT协议'))
    expect(normalize(' A  b ')).toBe('ab')
  })

  it('同一句相似度为 1，无关句接近 0', () => {
    expect(similarity('插件用 MIT 协议发布', '插件用MIT协议发布')).toBe(1)
    expect(similarity('插件用 MIT 协议发布', '今天天气不错适合出门')).toBeLessThan(0.1)
  })

  it('改写过的同主题句落在中间带', () => {
    const score = similarity('插件用 MIT 协议发布', '插件用 MIT 协议发布到 npm')
    expect(score).toBeGreaterThan(0.4)
    expect(score).toBeLessThan(AUTO_SAME)
  })

  it('过短文本不炸', () => {
    expect(similarity('好', '好')).toBe(1)
    expect(similarity('', 'abc')).toBe(0)
    expect(topicOverlap('', 'abc')).toBe(0)
  })

  /**
   * 真矛盾对的标定基线 —— 这几个数字就是 NEAR_LO 取 0.4 的依据。
   * 三元组在这些例子上分辨不出来（最低只有 0.09），所以矛盾提名必须用二元组重叠。
   */
  it('二元组重叠能把真矛盾对与无关句拉开距离', () => {
    expect(topicOverlap('定价定在 299 元', '定价定在 599 元')).toBeGreaterThan(0.6)
    expect(topicOverlap('我决定做记忆搬家这个方向', '我决定放弃记忆搬家这个方向')).toBeGreaterThan(0.6)
    expect(topicOverlap('优先做小红书渠道', '优先做视频号渠道')).toBeGreaterThan(0.4)
    expect(topicOverlap('今天天气不错', '插件用 MIT 协议发布')).toBe(0)
  })

  it('同一组例子上三元组分辨不出来（记录这个事实，防止有人改回去）', () => {
    expect(similarity('优先做小红书渠道', '优先做视频号渠道')).toBeLessThan(0.15)
  })
})

describe('去重合并闸', () => {
  it('同批次里同结论合并成一条并累计来源', () => {
    const result = gate([
      candidate({ source: { source: 'claude-code', convId: 'C1' } }),
      candidate({ source: { source: 'chatgpt', convId: 'G1' } }),
    ], { now: NOW })
    const all = [...result.accepted, ...result.pending]
    expect(all).toHaveLength(1)
    expect(all[0]?.sources).toHaveLength(2)
    expect(result.merged).toBe(1)
  })

  it('合并时保留更长的那份证据', () => {
    const result = gate([
      candidate({ evidence: '我决定这个插件用 MIT' }),
      candidate({ evidence: '我决定这个插件用 MIT 协议发布，主库继续 PolyForm' }),
    ], { now: NOW })
    const all = [...result.accepted, ...result.pending]
    expect(all[0]?.evidence).toContain('主库继续 PolyForm')
  })

  it('与库内几乎同句 → 并进旧条，不插新条', () => {
    const existing: MemoryItem[] = [{
      id: claimId('插件用 MIT 协议发布'),
      type: '决策',
      claim: '插件用 MIT 协议发布',
      evidence: '旧证据',
      sources: [{ source: 'claude-code', convId: 'OLD' }],
      confidence: 0.5,
      validFrom: '2026-08-01',
      validUntil: null,
      status: '待验证',
      reviewDate: '2026-08-15',
      links: [],
      contentHash: 'x',
      gateReason: 'auto-confidence',
    }]
    const result = gate([candidate()], { existing, now: NOW })
    expect(result.accepted).toHaveLength(0)
    expect(result.pending).toHaveLength(0)
    expect(result.merged).toBe(1)
    expect(existing[0]?.sources).toHaveLength(2)
    expect(existing[0]?.confidence).toBeGreaterThan(0.5)
  })
})

describe('矛盾闸', () => {
  const existing = (claim: string): MemoryItem[] => [{
    id: claimId(claim),
    type: '决策',
    claim,
    evidence: '旧证据原文',
    sources: [{ source: 'claude-code', convId: 'OLD' }],
    confidence: 0.6,
    validFrom: '2026-08-01',
    validUntil: null,
    status: '待验证',
    reviewDate: '2026-08-15',
    links: [],
    contentHash: 'x',
    gateReason: 'auto-confidence',
  }]

  it('近义但不同结论 → 两条都留、互链、交人工裁决', () => {
    const stored = existing('插件用 MIT 协议发布到 npm 仓库')
    const result = gate([candidate({ claim: '插件用 MIT 协议发布到 GitHub 仓库' })], { existing: stored, now: NOW })
    expect(result.nearPairs).toHaveLength(1)
    // 不替用户判谁对：新条进人工闸，旧条原样保留且未被置失效。
    expect(result.pending).toHaveLength(1)
    expect(stored[0]?.status).toBe('待验证')
    expect(stored[0]?.validUntil).toBeNull()
  })

  it('互链是双向的', () => {
    const stored = existing('插件用 MIT 协议发布到 npm 仓库')
    const result = gate([candidate({ claim: '插件用 MIT 协议发布到 GitHub 仓库' })], { existing: stored, now: NOW })
    const fresh = result.pending[0]!
    expect(fresh.links).toContain(stored[0]?.id)
    expect(stored[0]?.links).toContain(fresh.id)
  })

  it('毫不相干的旧条不产生近义对', () => {
    const result = gate([candidate()], { existing: existing('今天天气不错适合出门散步'), now: NOW })
    expect(result.nearPairs).toHaveLength(0)
    expect(result.accepted).toHaveLength(1)
  })
})

describe('人工闸', () => {
  it('高影响要求命中 ≥2 个业务词，单个词不算', () => {
    expect(isHighImpact(candidate({ impact: true, claim: '换个方向做', evidence: '换个方向做' }))).toBe(false)
    expect(isHighImpact(candidate({
      impact: true,
      claim: '放弃这个方向，改做付费课程',
      evidence: '放弃这个方向，改做付费课程',
    }))).toBe(true)
  })

  it('impact 为假时，命中再多业务词也不算高影响', () => {
    expect(isHighImpact(candidate({
      impact: false,
      claim: '放弃这个方向，改做付费课程',
      evidence: '放弃这个方向，改做付费课程',
    }))).toBe(false)
  })

  it('来源要求人工（Claude 云端记忆）→ 一律进待确认', () => {
    const result = gate([candidate({ forceReview: true, source: { source: 'claude-memory', convId: 'M1' } })], { now: NOW })
    expect(result.pending).toHaveLength(1)
    expect(result.accepted).toHaveLength(0)
  })

  it('普通高置信候选直接入库', () => {
    const result = gate([candidate()], { now: NOW })
    expect(result.accepted).toHaveLength(1)
    expect(result.pending).toHaveLength(0)
  })
})

describe('置信度', () => {
  it('按来源分级：本机 transcript > 网页导出', () => {
    expect(confidence('claude-code', 1, true)).toBeGreaterThan(confidence('chatgpt', 1, true))
  })

  it('直采比 LLM 抽取更可信', () => {
    expect(confidence('claude-memory', 1, false)).toBeGreaterThan(confidence('claude-memory', 1, true))
  })

  it('多源印证加成，且封顶 25%', () => {
    const one = confidence('claude-code', 1, true)
    expect(confidence('claude-code', 3, true)).toBeGreaterThan(one)
    expect(confidence('claude-code', 100, true)).toBeCloseTo(one * 1.25, 3)
  })

  /**
   * ⚠️ 刀刃上的标定，故意把数值钉死：
   * 网页导出（0.60）经 LLM 抽取（0.75）= 0.45，**正好等于**人工闸下限。
   * 人工闸判据是 `< LOW_CONFIDENCE`，所以它刚好自动入库、不进队列。
   * 而网页导出恰恰是本插件最主要的来源（Claude / ChatGPT 搬家）——
   * 任何一侧常数动 0.01，主用例的行为就整体翻转。改这几个数前先看这条测试。
   */
  it('网页导出单源恰好落在人工闸下限上（刀刃标定，勿随手改）', () => {
    expect(confidence('chatgpt', 1, true)).toBe(0.45)
    expect(LOW_CONFIDENCE).toBe(0.45)
    expect(confidence('chatgpt', 1, true) < LOW_CONFIDENCE).toBe(false)
  })

  it('本机 transcript 稳稳高于下限', () => {
    expect(confidence('claude-code', 1, true)).toBeGreaterThan(LOW_CONFIDENCE)
  })
})

describe('入库字段', () => {
  it('按契约填好状态机与再审日期', () => {
    const item = gate([candidate()], { now: NOW }).accepted[0]!
    expect(item.status).toBe('待验证')
    expect(item.validFrom).toBe('2026-08-16')
    expect(item.validUntil).toBeNull()
    expect(item.reviewDate).toBe('2026-08-30')
    expect(item.id).toBe(item.contentHash)
  })
})
