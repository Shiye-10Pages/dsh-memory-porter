/**
 * 召回层回归。
 *
 * 场景假设：用户查的是**自己说过的话**，所以查询词与原文高度重合——
 * 这正是 BM25 的强项，也是不上向量还能用的原因。
 */
import { describe, expect, it } from 'vitest'
import { formatHits, RecallIndex, tokenize } from '../src/recall.ts'
import type { MemoryItem } from '../src/types.ts'

function item(id: string, claim: string, evidence: string, overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id,
    type: '决策',
    claim,
    evidence,
    sources: [{ source: 'claude-code', convId: 'C1' }],
    confidence: 0.56,
    validFrom: '2026-08-16',
    validUntil: null,
    status: '已应用',
    reviewDate: '2026-08-30',
    links: [],
    contentHash: id,
    gateReason: '自动入库·置信达标',
    ...overrides,
  }
}

const LIBRARY = [
  item('a', '插件用 MIT 协议发布', '我决定这个插件用 MIT 协议发布，主库继续 PolyForm'),
  item('b', '小红书是主战场', '内容渠道以小红书优先，其他平台是补充'),
  item('c', '不做 awesome 列表方向', '调研结论：awesome 列表已经红海，不做'),
]

describe('切词', () => {
  it('中文切二元组，英文数字整体成词', () => {
    // 「用」被空格隔成独立的单字段落，按规则保留为单字。
    expect(tokenize('用 MIT 协议')).toEqual(['mit', '用', '协议'])
    expect(tokenize('小红书渠道')).toEqual(['小红', '红书', '书渠', '渠道'])
  })

  it('单个汉字保留为单字', () => {
    expect(tokenize('好 abc')).toEqual(['abc', '好'])
  })

  it('空串不炸', () => {
    expect(tokenize('')).toEqual([])
  })
})

describe('检索', () => {
  const index = new RecallIndex(LIBRARY)

  it('查得到自己说过的话', () => {
    const hits = index.search('插件用什么协议')
    expect(hits[0]?.item.id).toBe('a')
  })

  it('按相关度排序，无关的不返回', () => {
    const hits = index.search('小红书')
    expect(hits[0]?.item.id).toBe('b')
    expect(hits.every(hit => hit.score > 0)).toBe(true)
  })

  it('完全无关的查询返回空，而不是硬凑', () => {
    expect(index.search('量子力学薛定谔方程')).toEqual([])
  })

  it('topK 生效', () => {
    expect(index.search('协议 小红书 awesome', 2).length).toBeLessThanOrEqual(2)
  })

  it('已失效的记忆默认不召回 —— 拿过期结论办事比召不回更糟', () => {
    const withExpired = new RecallIndex([
      ...LIBRARY,
      item('d', '定价定在 299 元', '定价就 299', { status: '已失效' }),
    ])
    expect(withExpired.search('定价 299')).toEqual([])
    expect(withExpired.search('定价 299', 6, true)).toHaveLength(1)
  })

  it('空库与空查询都安全', () => {
    expect(new RecallIndex([]).search('任何东西')).toEqual([])
    expect(index.search('')).toEqual([])
  })
})

describe('给模型看的渲染', () => {
  it('每条都带逐字证据、来源与入库依据', () => {
    const text = formatHits(new RecallIndex(LIBRARY).search('插件协议'))
    expect(text).toContain('结论: 插件用 MIT 协议发布')
    expect(text).toContain('证据(逐字): 我决定这个插件用 MIT 协议发布')
    expect(text).toContain('来源 claude-code:C1')
    expect(text).toContain('入库依据: 自动入库·置信达标')
  })

  it('未经确认的条目明确标出「待核」，不能被当成既定事实', () => {
    const pending = new RecallIndex([item('p', '待确认的结论', '原文证据在这里', { status: '待验证' })])
    expect(formatHits(pending.search('待确认的结论'))).toContain('[待核·未经人工确认]')
  })

  it('已确认的条目不加待核标记', () => {
    expect(formatHits(new RecallIndex(LIBRARY).search('插件协议'))).not.toContain('待核')
  })

  it('召不回时明说，并劝阻臆断', () => {
    expect(formatHits([])).toContain('请勿据此臆断')
  })
})
