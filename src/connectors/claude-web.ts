/**
 * 连接器 · claude.ai 账号级导出（conversations.json）
 *
 * 拿法：claude.ai → Settings → Privacy → Export data → 邮件收到 zip。
 * 结构是**扁平的 chat_messages 数组**（区别于 ChatGPT 的树状 mapping）。
 *
 * 解析规则逐条移植自 MemoryHub 主库 scripts/ingest_claude_web.py。
 */
import { createHash } from 'node:crypto'
import type { RawConversation, RawTurn, ScanResult } from '../types.ts'

const ROLE: Record<string, 'user' | 'assistant' | undefined> = {
  human: 'user',
  user: 'user',
  assistant: 'assistant',
}

function sha16(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 16)
}

/**
 * 取消息正文：兼容旧版 `text` 与新版 `content: [{type:'text', text}]`。
 *
 * 上传附件的正文（Claude 已提取的 `extracted_content`）会被救回来拼在后面——
 * 那常常是整段会话里信息密度最高的部分，漏掉等于把用户当初喂进去的资料丢了。
 */
export function textOf(m: any): string {
  let text = ''
  if (typeof m?.text === 'string' && m.text.trim() !== '') {
    text = m.text.trim()
  } else if (Array.isArray(m?.content)) {
    text = m.content
      .filter((c: any) => c !== null && typeof c === 'object' && typeof c.text === 'string')
      .map((c: any) => c.text)
      .join('\n')
      .trim()
  }
  const attachments = (Array.isArray(m?.attachments) ? m.attachments : [])
    .map((a: any) => String(a?.extracted_content ?? '').trim())
    .filter((s: string) => s !== '')
  if (attachments.length > 0) {
    const blob = attachments.join('\n\n')
    text = text === '' ? blob : `${text}\n\n[上传附件正文]\n${blob}`
  }
  return text
}

/**
 * 解析一份 claude.ai 导出的 conversations.json。
 *
 * 顶层既可能是数组，也可能是 `{ conversations: [...] }`——两种都见过，都收。
 */
export function parseClaudeWeb(
  data: unknown,
  uri = 'conversations.json',
): { conversations: RawConversation[]; result: ScanResult } {
  const result: ScanResult = {
    source: 'claude-web',
    conversations: 0,
    turns: 0,
    skipped: 0,
    errors: [],
  }
  const convs: any[] = Array.isArray(data)
    ? data
    : Array.isArray((data as any)?.conversations)
      ? (data as any).conversations
      : []
  if (convs.length === 0) {
    result.errors.push({ uri, message: '文件里没有会话数组——确认这是 claude.ai 导出的 conversations.json' })
    return { conversations: [], result }
  }

  const conversations: RawConversation[] = []
  for (const conv of convs) {
    const convId =
      String(conv?.uuid ?? '') ||
      String(conv?.id ?? '') ||
      sha16(`${conv?.name ?? ''}${conv?.created_at ?? ''}`)
    const messages: any[] = Array.isArray(conv?.chat_messages)
      ? conv.chat_messages
      : Array.isArray(conv?.messages)
        ? conv.messages
        : []
    const turns: RawTurn[] = []
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]
      const role = ROLE[String(m?.sender ?? m?.role ?? '')]
      if (role === undefined) {
        result.skipped++
        continue
      }
      const text = textOf(m)
      if (text === '') {
        result.skipped++
        continue
      }
      const msgId = String(m?.uuid ?? '') || sha16(text)
      turns.push({
        id: `cw_${sha16(`${convId}|${msgId}`)}`,
        role,
        text,
        ts: String(m?.created_at ?? conv?.created_at ?? '').slice(0, 19),
        seq: i,
      })
    }
    if (turns.length === 0) continue
    conversations.push({
      source: 'claude-web',
      convId,
      title: typeof conv?.name === 'string' ? conv.name : undefined,
      uri,
      turns,
    })
    result.conversations++
    result.turns += turns.length
  }
  return { conversations, result }
}
