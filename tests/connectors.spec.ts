/**
 * 连接器层回归。
 *
 * fixture 全部是**手写的合成数据**，覆盖三家格式里真实踩过的坑；
 * 真人数据只进本机（scripts/scan-local.ts），绝不进仓库。
 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractTurn, parseTranscript, scanClaudeCode } from '../src/connectors/claude-code.ts'
import { messagesOf, parseChatGPT, textOf as gptTextOf } from '../src/connectors/chatgpt.ts'
import { parseClaudeWeb, textOf as claudeTextOf } from '../src/connectors/claude-web.ts'
import { parseClaudeMemories, splitSections } from '../src/connectors/claude-memories.ts'
import { detectConversationsFormat } from '../src/connectors/index.ts'

describe('Claude Code transcript', () => {
  it('收 user 的字符串正文', () => {
    expect(extractTurn({ type: 'user', message: { content: '  你好  ' } }))
      .toEqual({ role: 'user', text: '你好' })
  })

  it('assistant 只取 text 块，丢掉 thinking 与 tool_use', () => {
    const turn = extractTurn({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: '内心戏不该进记忆' },
          { type: 'text', text: '第一段' },
          { type: 'tool_use', name: 'Bash', input: {} },
          { type: 'text', text: '第二段' },
        ],
      },
    })
    expect(turn).toEqual({ role: 'assistant', text: '第一段\n第二段' })
  })

  it('跳过 isMeta、tool_result 与空正文', () => {
    expect(extractTurn({ type: 'user', message: { content: 'x' }, isMeta: true })).toBeUndefined()
    expect(extractTurn({ type: 'system', message: { content: 'x' } })).toBeUndefined()
    // tool_result 的 user 行：content 是数组而非字符串，不算对话。
    expect(extractTurn({ type: 'user', message: { content: [{ type: 'tool_result' }] } })).toBeUndefined()
    expect(extractTurn({ type: 'assistant', message: { content: [{ type: 'text', text: '   ' }] } }))
      .toBeUndefined()
  })

  it('解析整份 transcript：取 sessionId/cwd，坏行不中断', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'porter-'))
    const file = join(dir, 'session.jsonl')
    await writeFile(file, [
      JSON.stringify({ type: 'user', sessionId: 'S1', cwd: '/repo', timestamp: '2026-08-01T00:00:00Z', message: { content: '问题' } }),
      '{ 这行不是合法 JSON',
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '回答' }] }, timestamp: '2026-08-01T00:00:01Z' }),
      '',
    ].join('\n'), 'utf8')

    const { conversation, skipped } = await parseTranscript(file)
    expect(conversation?.convId).toBe('S1')
    expect(conversation?.project).toBe('/repo')
    expect(conversation?.uri).toBe(file)
    expect(conversation?.turns.map(t => t.role)).toEqual(['user', 'assistant'])
    // seq 是行号，坏行占位后 assistant 落在第 3 行（索引 2）。
    expect(conversation?.turns[1]?.seq).toBe(2)
    expect(skipped).toBe(1)
  })

  it('消息 id 对同一条消息稳定复现', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'porter-'))
    const file = join(dir, 'a.jsonl')
    await writeFile(file, JSON.stringify({ type: 'user', sessionId: 'S', message: { content: '同一句话' } }), 'utf8')
    const first = await parseTranscript(file)
    const second = await parseTranscript(file)
    expect(first.conversation?.turns[0]?.id).toBe(second.conversation?.turns[0]?.id)
  })

  it('默认不收子代理 sidechain，开关打开才收', async () => {
    const root = await mkdtemp(join(tmpdir(), 'porter-root-'))
    const project = join(root, '-Users-x-repo')
    await mkdir(join(project, 'sess', 'subagents'), { recursive: true })
    const main = JSON.stringify({ type: 'user', sessionId: 'main', message: { content: '主会话' } })
    const sub = JSON.stringify({ type: 'user', sessionId: 'agent', message: { content: '子代理' } })
    await writeFile(join(project, 'sess.jsonl'), main, 'utf8')
    await writeFile(join(project, 'sess', 'subagents', 'agent-1.jsonl'), sub, 'utf8')

    const shallow = await scanClaudeCode({ root })
    expect(shallow.result.conversations).toBe(1)

    const deep = await scanClaudeCode({ root, includeSubagents: true })
    expect(deep.result.conversations).toBe(2)
  })
})

describe('claude.ai 导出', () => {
  it('兼容 text 与 content[].text 两种形态', () => {
    expect(claudeTextOf({ text: ' 旧版 ' })).toBe('旧版')
    expect(claudeTextOf({ content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] })).toBe('A\nB')
  })

  it('救回上传附件的正文', () => {
    const text = claudeTextOf({
      text: '看看这份文档',
      attachments: [{ file_name: 'a.md', extracted_content: '文档正文在这' }],
    })
    expect(text).toContain('看看这份文档')
    expect(text).toContain('[上传附件正文]')
    expect(text).toContain('文档正文在这')
  })

  it('只有附件没有正文时也要收', () => {
    expect(claudeTextOf({ attachments: [{ extracted_content: '只有附件' }] })).toBe('只有附件')
  })

  it('human 映射成 user，空消息被跳过', () => {
    const { conversations, result } = parseClaudeWeb([{
      uuid: 'C1',
      name: '一次对话',
      created_at: '2026-08-01T10:00:00.000Z',
      chat_messages: [
        { uuid: 'M1', sender: 'human', text: '问题' },
        { uuid: 'M2', sender: 'assistant', text: '' },
        { uuid: 'M3', sender: 'assistant', text: '回答' },
      ],
    }])
    expect(result.conversations).toBe(1)
    expect(result.skipped).toBe(1)
    expect(conversations[0]?.title).toBe('一次对话')
    expect(conversations[0]?.turns.map(t => t.role)).toEqual(['user', 'assistant'])
    expect(conversations[0]?.turns[0]?.ts).toBe('2026-08-01T10:00:00')
  })

  it('认不出的 JSON 如实报错而不是静默返回空', () => {
    const { result } = parseClaudeWeb({ nope: true })
    expect(result.errors).toHaveLength(1)
  })
})

describe('ChatGPT 导出', () => {
  it('只收字符串 part，多模态占位被丢掉', () => {
    // 只 trim 整体两端，不动 part 内部的空白 —— 逐字证据不该被我们改写，
    // 这也与主库 ingest_chatgpt.py 的行为一致（便于两版交叉核对）。
    expect(gptTextOf({ content: { parts: ['一段', { image: 'x' }, ' 二段 '] } })).toBe('一段\n 二段')
    expect(gptTextOf({ content: { parts: [] } })).toBe('')
    expect(gptTextOf({ content: { parts: ['  ', '   '] } })).toBe('')
  })

  it('mapping 是无序 DAG，按 create_time 排出顺序', () => {
    const messages = messagesOf({
      mapping: {
        n3: { message: { id: 'm3', author: { role: 'assistant' }, create_time: 300, content: { parts: ['第三'] } } },
        n1: { message: { id: 'm1', author: { role: 'user' }, create_time: 100, content: { parts: ['第一'] } } },
        nSys: { message: { id: 'ms', author: { role: 'system' }, create_time: 50, content: { parts: ['系统节点'] } } },
        n2: { message: { id: 'm2', author: { role: 'assistant' }, create_time: 200, content: { parts: ['第二'] } } },
        nEmpty: { message: null },
      },
    })
    expect(messages.map(m => m.text)).toEqual(['第一', '第二', '第三'])
  })

  it('create_time 变成 ISO 时间戳', () => {
    const { conversations } = parseChatGPT([{
      conversation_id: 'G1',
      title: '标题',
      mapping: { a: { message: { id: 'm', author: { role: 'user' }, create_time: 1755302400, content: { parts: ['问'] } } } },
    }])
    expect(conversations[0]?.turns[0]?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })

  it('会话 id 缺失时由标题+时间兜底，不丢会话', () => {
    const { conversations } = parseChatGPT([{
      title: '无 id 会话',
      create_time: 1,
      mapping: { a: { message: { id: 'm', author: { role: 'user' }, create_time: 1, content: { parts: ['问'] } } } },
    }])
    expect(conversations).toHaveLength(1)
    expect(conversations[0]?.convId).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('Claude 云端记忆 memories.json', () => {
  it('按 **标题** 切小节', () => {
    expect(splitSections('**偏好**\n爱用中文\n\n**决策**\n不做 X')).toEqual([
      { title: '偏好', body: '爱用中文' },
      { title: '决策', body: '不做 X' },
    ])
  })

  it('三个字段各自成候选，且一律 forceReview', () => {
    const candidates = parseClaudeMemories({
      conversations_memory: '**偏好**\n爱用中文',
      project_memories: { abcdef123456: '这个项目在做记忆搬家' },
      memory_files: [{ path: '/areas/work.md', content: '工作区记忆' }],
    })
    expect(candidates).toHaveLength(3)
    expect(candidates.every(c => c.forceReview)).toBe(true)
    // AI 推断来的东西，evidence 必须是 memories.json 里的原文，不能为空。
    expect(candidates.every(c => c.evidence.trim() !== '')).toBe(true)
    expect(candidates.every(c => c.source.source === 'claude-memory')).toBe(true)
  })

  it('导出被包成数组时取第一个元素', () => {
    expect(parseClaudeMemories([{ conversations_memory: '**A**\n内容' }])).toHaveLength(1)
  })
})

describe('格式判别', () => {
  it('靠内容特征分开两家同名的 conversations.json', () => {
    expect(detectConversationsFormat([{ mapping: { a: {} } }])).toBe('chatgpt')
    expect(detectConversationsFormat([{ chat_messages: [] }])).toBe('claude-web')
    expect(detectConversationsFormat([{ 什么都不像: 1 }])).toBe('unknown')
  })

  it('顶层是 { conversations: [...] } 时同样认得出', () => {
    expect(detectConversationsFormat({ conversations: [{ mapping: {} }] })).toBe('chatgpt')
  })
})
