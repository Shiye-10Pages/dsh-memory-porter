/**
 * 词典回归。
 *
 * 英文场（官方 Discussions、6 个 awesome 列表、Discord）是主要流量入口，
 * 界面漏一句中文就砍转化——所以中英键集必须一致，这条得机器守着。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { en, fallbackT, zh } from '../src/client/locales.ts'

const CLIENT_DIR = join(import.meta.dirname, '..', 'src', 'client')

describe('中英对齐', () => {
  it('键集完全一致 —— 少一个键，英文界面就露一句中文', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('没有空文案', () => {
    for (const [key, value] of Object.entries(zh)) expect(value, `zh.${key}`).not.toBe('')
    for (const [key, value] of Object.entries(en)) expect(value, `en.${key}`).not.toBe('')
  })

  it('占位符两侧一一对应 —— 否则某一种语言会漏掉数字', () => {
    const holders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]!).sort()
    for (const key of Object.keys(zh) as (keyof typeof zh)[]) {
      expect(holders(en[key]), `占位符不一致: ${key}`).toEqual(holders(zh[key]))
    }
  })

  it('每个入库依据都有对应文案 —— 否则面板上会显示原始机器键', () => {
    const reasons = [
      'auto-confidence', 'auto-multi-source', 'human-ai-inferred', 'human-high-impact',
      'human-conflict', 'human-low-confidence', 'human-user-choice',
    ]
    for (const reason of reasons) expect(zh).toHaveProperty(`reason.${reason}`)
  })

  it('英文文案不提封号 —— 英文场一律用 portability / vendor lock-in 的说法', () => {
    const banned = /banned|suspend|ban your account/i
    for (const [key, value] of Object.entries(en)) {
      expect(banned.test(value), `${key} 出现了封号措辞`).toBe(false)
    }
  })
})

describe('本地兜底', () => {
  it('宿主 locale 缺席时也能出文案，并替换占位符', () => {
    expect(fallbackT('card.score', { score: 1.5 })).toContain('1.5')
  })

  it('未知键不抛错（宿主与词典版本不同步时不能白屏）', () => {
    expect(() => fallbackT('reason.unknown-thing' as never)).not.toThrow()
  })
})

describe('组件里不许写死中文', () => {
  it('非注释代码中没有 CJK 字面量', () => {
    const files = ['Panel.tsx', 'PorterAction.tsx', 'SidebarEntry.tsx', 'index.tsx']
    for (const name of files) {
      const stripped = readFileSync(join(CLIENT_DIR, name), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
      expect(/[一-鿿]/.test(stripped), `${name} 里有写死的中文`).toBe(false)
    }
  })
})
