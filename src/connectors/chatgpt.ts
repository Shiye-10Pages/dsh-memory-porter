/**
 * 连接器 · ChatGPT 账号级导出（conversations.json）
 *
 * 拿法：ChatGPT → Settings → Data controls → Export data → 邮件收到 zip。
 * 结构是**树状 mapping**（节点 DAG），不是数组——这是这份格式最容易踩的坑。
 *
 * 解析规则移植自 MemoryHub 主库 scripts/ingest_chatgpt.py：不做 DAG 回溯选主干，
 * 而是取全部 user/assistant 节点后按 create_time 排序。代价是重生成/编辑过的分支
 * 会同时出现；这对提取记忆是可接受的——多一份佐证，重复由去重合并闸吃掉。
 */
import { createHash } from 'node:crypto'
import type { RawConversation, RawTurn, ScanResult } from '../types.ts'

function sha(input: string, n: number): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, n)
}

/** 从 message.content 取纯文本（兼容 text / multimodal / code：只收字符串 part）。 */
export function textOf(m: any): string {
  const parts = m?.content?.parts
  if (!Array.isArray(parts)) return ''
  return parts
    .filter((p: any) => typeof p === 'string' && p.trim() !== '')
    .join('\n')
    .trim()
}

/** 展开一个会话的 mapping → 按时间排序的消息列表。 */
export function messagesOf(conv: any): { id: string; role: 'user' | 'assistant'; text: string; ct: number }[] {
  const mapping = conv?.mapping
  if (mapping === null || typeof mapping !== 'object') return []
  const out: { id: string; role: 'user' | 'assistant'; text: string; ct: number }[] = []
  for (const node of Object.values<any>(mapping)) {
    const m = node?.message
    if (m === null || m === undefined) continue
    const role = m?.author?.role
    if (role !== 'user' && role !== 'assistant') continue
    const text = textOf(m)
    if (text === '') continue
    const ct = Number(m?.create_time ?? conv?.create_time ?? 0)
    out.push({
      id: String(m?.id ?? node?.id ?? sha(text, 16)),
      role,
      text,
      ct: Number.isFinite(ct) ? ct : 0,
    })
  }
  out.sort((a, b) => a.ct - b.ct)
  return out
}

/** Unix 秒 → ISO 8601（UTC，秒级）。拿不到就给空串，不猜。 */
function iso(ct: number): string {
  if (!Number.isFinite(ct) || ct <= 0) return ''
  try {
    return `${new Date(ct * 1000).toISOString().slice(0, 19)}Z`
  } catch {
    return ''
  }
}

/**
 * 解析一份或多份 ChatGPT 导出的 conversations.json。
 *
 * 大账号的导出会被切成 `conversations.json` / `conversations-1.json` 等分片，
 * 调用方把每片解析结果合并即可；本函数一次吃一片。
 */
export function parseChatGPT(
  data: unknown,
  uri = 'conversations.json',
): { conversations: RawConversation[]; result: ScanResult } {
  const result: ScanResult = {
    source: 'chatgpt',
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
    result.errors.push({ uri, message: '文件里没有会话数组——确认这是 ChatGPT 导出的 conversations.json' })
    return { conversations: [], result }
  }

  const conversations: RawConversation[] = []
  for (const conv of convs) {
    const convId =
      String(conv?.conversation_id ?? '') ||
      String(conv?.id ?? '') ||
      sha(`${conv?.title ?? ''}${conv?.create_time ?? ''}`, 16)
    const messages = messagesOf(conv)
    const turns: RawTurn[] = messages.map((m, i) => ({
      id: `gpt_${sha(`${convId}|${m.id}`, 20)}`,
      role: m.role,
      text: m.text,
      ts: iso(m.ct),
      seq: i,
    }))
    if (turns.length === 0) continue
    conversations.push({
      source: 'chatgpt',
      convId,
      title: typeof conv?.title === 'string' ? conv.title : undefined,
      uri,
      turns,
    })
    result.conversations++
    result.turns += turns.length
  }
  return { conversations, result }
}
