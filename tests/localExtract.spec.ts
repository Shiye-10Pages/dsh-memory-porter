/**
 * 本地规则抽取回归。
 *
 * 这层的成败标准和 LLM 提纯不同：**宁可漏，不可噪**。
 * 它是用户装完插件看到的第一屏，噪声大比什么都不显示更糟。
 */
import { describe, expect, it } from 'vitest'
import { classify, localExtract, looksLikePaste, sentences } from '../src/localExtract.ts'
import type { RawConversation } from '../src/types.ts'

function conv(texts: { role: 'user' | 'assistant'; text: string }[]): RawConversation {
  return {
    source: 'claude-code',
    convId: 'C1',
    uri: '/tmp/c1.jsonl',
    turns: texts.map((t, i) => ({ id: `t${i}`, role: t.role, text: t.text, ts: '', seq: i })),
  }
}

describe('切句', () => {
  it('中英标点都切', () => {
    expect(sentences('第一句。第二句！第三句?')).toEqual(['第一句', '第二句', '第三句'])
  })

  it('先剥代码块 —— 代码里的「必须」不是人的判断', () => {
    const text = '我决定用 MIT。\n```ts\n// 一律必须校验\nconst x = 1\n```\n就这样'
    const out = sentences(text)
    expect(out.some(s => s.includes('一律必须校验'))).toBe(false)
    expect(out.some(s => s.includes('我决定用 MIT'))).toBe(true)
  })

  it('行内代码也剥掉', () => {
    expect(sentences('看 `一律必须` 这个变量').join('')).not.toContain('一律必须')
  })
})

describe('判定', () => {
  it('抓得到显式决断，并归到对的类型', () => {
    expect(classify('我决定这个插件用 MIT 协议发布')).toBe('决策')
    expect(classify('以后都不要在生产库上直接跑迁移')).toBe('SOP')
    expect(classify('我不喜欢那种一上来就堆功能的做法')).toBe('偏好')
    expect(classify('这次的教训是不该在发版当天改价目表')).toBe('经验')
    expect(classify('关键在于先把冷启动的第一屏做出来')).toBe('认知')
  })

  it('疑问句是在问不是在定', () => {
    expect(classify('我决定用哪个协议比较好呢？')).toBeUndefined()
  })

  it('给 AI 的祈使指令不算他自己的长期判断', () => {
    expect(classify('帮我决定一下用哪个协议吧')).toBeUndefined()
    expect(classify('你来决定用什么方案就行')).toBeUndefined()
  })

  it('太短撑不起证据，太长多半是整段', () => {
    expect(classify('我决定了')).toBeUndefined()
    expect(classify('我决定' + '啊'.repeat(200))).toBeUndefined()
  })

  it('没有标记词的普通句子不抓 —— 宁可漏不可噪', () => {
    expect(classify('今天天气不错，出门走了走挺舒服的')).toBeUndefined()
    expect(classify('这个函数返回一个数组，里面是解析出来的对象')).toBeUndefined()
  })

  /** 以下几条都是真机跑出来的噪声，逐条钉住，防止回潮。 */
  it('markdown 结构行不是人话', () => {
    expect(classify('- 主标题改成《DeepSeek 今天涨价》这样更好')).toBeUndefined()
    expect(classify('**代码块的已知坑与对策**：一律先转义再入库')).toBeUndefined()
    expect(classify('3. 我决定先做小红书这个渠道试试水')).toBeUndefined()
  })

  it('表格行不是人话', () => {
    expect(classify('| 模型下线 | 一律以 config.json 为唯一来源 |')).toBeUndefined()
  })

  it('带字面转义符的是数据不是发言', () => {
    expect(classify('\\n - openingStyle 改为用一个具体钩子开场')).toBeUndefined()
  })
})

describe('整段粘贴识别', () => {
  it('结构化行占比高的整段文档判为粘贴', () => {
    expect(looksLikePaste([
      '# 内容引擎规范',
      '- 讲人话：术语出现即翻译',
      '- 克制的网感：一篇两三处',
      '- 一律不要满屏玩梗',
      '正文段落在这里',
    ].join('\n'))).toBe(true)
  })

  it('正常多行发言不算粘贴', () => {
    expect(looksLikePaste([
      '我决定这个插件用 MIT 协议发布。',
      '主库继续 PolyForm 不动。',
      '另外以后都不要在发版当天改价目表。',
      '就这样吧。',
    ].join('\n'))).toBe(false)
  })

  it('短发言不判粘贴', () => {
    expect(looksLikePaste('- 我决定用 MIT')).toBe(false)
  })

  it('贴进来的文档里的决断句被整条丢掉', () => {
    const pasted = ['# 规范', '- 一律必须校验参数', '- 以后都不要直接改库', '- 必须先跑测试', '- 记住这几条'].join('\n')
    expect(localExtract([conv([{ role: 'user', text: pasted }])]).candidates).toHaveLength(0)
  })
})

describe('抽取', () => {
  it('只看用户说的话，AI 说的不算他的结论', () => {
    const { candidates } = localExtract([conv([
      { role: 'user', text: '我决定这个插件用 MIT 协议发布。' },
      { role: 'assistant', text: '我决定帮你把协议改成 Apache 2.0。' },
    ])])
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.evidence).toContain('MIT')
  })

  it('claim 就是原句本身 —— 不替用户改写，这才是幻觉为零的原因', () => {
    const { candidates } = localExtract([conv([
      { role: 'user', text: '以后都不要在发版当天改价目表。' },
    ])])
    expect(candidates[0]?.claim).toBe('以后都不要在发版当天改价目表')
    expect(candidates[0]?.claim).toBe(candidates[0]?.evidence)
  })

  it('一律走人工闸，不自动入库', () => {
    const { candidates } = localExtract([conv([{ role: 'user', text: '我决定先做小红书这个渠道。' }])])
    expect(candidates.every(c => c.forceReview)).toBe(true)
    expect(candidates[0]?.context).toContain('规则抽取')
  })

  it('命中业务词时标 impact', () => {
    const { candidates } = localExtract([conv([
      { role: 'user', text: '我决定把定价定在 299，先不做付费社群。' },
    ])])
    expect(candidates[0]?.impact).toBe(true)
  })

  it('同一句在多处出现只留一条', () => {
    const { candidates } = localExtract([
      conv([{ role: 'user', text: '我决定用 MIT 协议发布这个插件。' }]),
      { ...conv([{ role: 'user', text: '我决定用 MIT  协议发布这个插件。' }]), convId: 'C2' },
    ])
    expect(candidates).toHaveLength(1)
  })

  it('带上溯源指针，能回到原文', () => {
    const { candidates } = localExtract([conv([{ role: 'user', text: '我决定先做小红书这个渠道。' }])])
    expect(candidates[0]?.source).toMatchObject({ source: 'claude-code', convId: 'C1', uri: '/tmp/c1.jsonl', seq: 0 })
  })

  it('统计扫了多少条用户发言', () => {
    const { scanned } = localExtract([conv([
      { role: 'user', text: '第一句' },
      { role: 'assistant', text: '回答' },
      { role: 'user', text: '第二句' },
    ])])
    expect(scanned).toBe(2)
  })

  it('上限生效，不会一次灌爆队列', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      role: 'user' as const,
      text: `我决定第 ${i} 个方案就这么定了。`,
    }))
    expect(localExtract([conv(many)], 10).candidates).toHaveLength(10)
  })
})
