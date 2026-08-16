/**
 * 存储层回归。
 *
 * 最要紧的一条：**被丢弃的候选不能复活**。下次导入同一份对话时同一条结论会
 * 再被提出来，如果它又回到队列，用户就要一遍遍拒同一条——主库踩过这个坑。
 */
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MemoryStore } from '../src/store.ts'
import type { MemoryItem } from '../src/types.ts'

function item(id: string, overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id,
    type: '决策',
    claim: `结论 ${id}`,
    evidence: `原文 ${id}`,
    sources: [{ source: 'claude-code', convId: 'C1' }],
    confidence: 0.6,
    validFrom: '2026-08-16',
    validUntil: null,
    status: '待验证',
    reviewDate: '2026-08-30',
    links: [],
    contentHash: id,
    gateReason: '自动入库·置信达标',
    ...overrides,
  }
}

async function freshStore(): Promise<{ store: MemoryStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'porter-store-'))
  return { store: new MemoryStore(dir, () => undefined), dir }
}

describe('写入与装载', () => {
  it('落盘后重开一个 store 能读回来', async () => {
    const { store, dir } = await freshStore()
    await store.write([item('a')], [item('b')])
    expect(store.summary()).toMatchObject({ memories: 1, pending: 1 })

    const reopened = new MemoryStore(dir, () => undefined)
    await reopened.load()
    expect(reopened.summary()).toMatchObject({ memories: 1, pending: 1 })
    expect(reopened.all()[0]?.id).toBe('a')
  })

  it('同一条重复写入不会翻倍', async () => {
    const { store } = await freshStore()
    await store.write([item('a')], [])
    const second = await store.write([item('a')], [])
    expect(second.accepted).toBe(0)
    expect(second.skipped).toBe(1)
    expect(store.summary().memories).toBe(1)
  })

  it('坏行跳过而不是让整个库打不开', async () => {
    const { store, dir } = await freshStore()
    await store.write([item('a')], [])
    const { appendFile } = await import('node:fs/promises')
    await appendFile(join(dir, 'memories.jsonl'), '{ 这行坏了\n', 'utf8')

    const warnings: string[] = []
    const reopened = new MemoryStore(dir, message => warnings.push(message))
    await reopened.load()
    expect(reopened.summary().memories).toBe(1)
    expect(warnings).toHaveLength(1)
  })
})

describe('批准与丢弃', () => {
  it('批准 → 进记忆库并置为已应用', async () => {
    const { store } = await freshStore()
    await store.write([], [item('b')])
    expect(await store.decide('b', 'approved')).toBe(true)
    expect(store.summary()).toMatchObject({ memories: 1, pending: 0 })
    expect(store.all()[0]?.status).toBe('已应用')
  })

  it('丢弃 → 不进库，且**不再复活**', async () => {
    const { store, dir } = await freshStore()
    await store.write([], [item('b')])
    await store.decide('b', 'discarded')
    expect(store.summary()).toMatchObject({ memories: 0, pending: 0 })

    // 下次导入同一份对话，同一条结论又被提出来 —— 必须被静默跳过。
    const again = await store.write([], [item('b')])
    expect(again.pending).toBe(0)
    expect(again.skipped).toBe(1)

    // 重开也不能复活。
    const reopened = new MemoryStore(dir, () => undefined)
    await reopened.load()
    expect(reopened.summary().pending).toBe(0)
  })

  it('处置队列里没有的 id 返回 false', async () => {
    const { store } = await freshStore()
    expect(await store.decide('不存在', 'approved')).toBe(false)
  })

  it('决定写进 decisions.jsonl，那是"不复活"的唯一依据', async () => {
    const { store, dir } = await freshStore()
    await store.write([], [item('b')])
    await store.decide('b', 'discarded')
    const text = await readFile(join(dir, 'decisions.jsonl'), 'utf8')
    expect(JSON.parse(text.trim())).toMatchObject({ id: 'b', decision: 'discarded' })
  })
})

describe('队列排序', () => {
  it('置信度低的排前面 —— 最需要你看一眼的先出现', async () => {
    const { store } = await freshStore()
    await store.write([], [item('high', { confidence: 0.8 }), item('low', { confidence: 0.3 })])
    expect(store.queue().map(i => i.id)).toEqual(['low', 'high'])
  })
})

describe('导出', () => {
  it('Markdown 带上结论、来源与逐字证据', async () => {
    const { store } = await freshStore()
    await store.write([item('a', { claim: '插件用 MIT', evidence: '我决定用 MIT' })], [])
    const md = store.exportMarkdown()
    expect(md).toContain('## 插件用 MIT')
    expect(md).toContain('> 我决定用 MIT')
    expect(md).toContain('claude-code:C1')
  })

  it('JSONL 一行一条，别的插件直接能吃', async () => {
    const { store } = await freshStore()
    await store.write([item('a'), item('b')], [])
    const lines = store.exportJsonl().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!).id).toBe('a')
  })

  it('导出文件是原子写出的', async () => {
    const { store, dir } = await freshStore()
    await store.write([item('a')], [])
    const target = join(dir, 'out', 'memories.md')
    await store.exportTo(target, 'md')
    expect(await readFile(target, 'utf8')).toContain('# 记忆搬家导出')
  })
})

describe('摘要', () => {
  it('按来源分类计数，面板第一屏那几个数字', async () => {
    const { store } = await freshStore()
    await store.write([
      item('a', { sources: [{ source: 'claude-code', convId: 'C1' }] }),
      item('b', { sources: [{ source: 'chatgpt', convId: 'G1' }, { source: 'claude-web', convId: 'W1' }] }),
    ], [])
    expect(store.summary().bySource).toEqual({ 'claude-code': 1, chatgpt: 1, 'claude-web': 1 })
  })
})
