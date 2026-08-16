/**
 * 连接器调度：用户丢进来一个东西，这里决定它是什么、交给谁解析。
 *
 * 支持的投喂形态：
 * - 整个导出 zip（Claude 或 ChatGPT）—— 自动在包里找 conversations*.json / memories.json
 * - 单个 conversations.json / memories.json
 * - 一个已解压的导出目录
 *
 * 判别只看内容特征，不看文件名：Claude 导出是扁平 `chat_messages`，
 * ChatGPT 导出是树状 `mapping`。两家都叫 conversations.json，靠名字分不开。
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { unzipSync } from 'fflate'
import type { Candidate, RawConversation, ScanResult } from '../types.ts'
import { parseChatGPT } from './chatgpt.ts'
import { parseClaudeMemories } from './claude-memories.ts'
import { parseClaudeWeb } from './claude-web.ts'

export { countAvailable, defaultRoot, extractTurn, parseTranscript, scanClaudeCode } from './claude-code.ts'
export { parseChatGPT } from './chatgpt.ts'
export { parseClaudeMemories, splitSections } from './claude-memories.ts'
export { parseClaudeWeb } from './claude-web.ts'

/** 一次导入的完整产出：会话（待提纯）+ 候选（已是结论，直接进闸）。 */
export interface ImportResult {
  conversations: RawConversation[]
  /** 目前只有 Claude 云端记忆走这条——它已经是提炼过的结论。 */
  candidates: Candidate[]
  results: ScanResult[]
}

const EMPTY: ImportResult = { conversations: [], candidates: [], results: [] }

/**
 * 判别一份 conversations.json 出自哪家。
 *
 * 只取第一个非空会话做特征判断即可——同一份导出不会混两家格式。
 */
export function detectConversationsFormat(data: unknown): 'claude-web' | 'chatgpt' | 'unknown' {
  const convs: any[] = Array.isArray(data)
    ? data
    : Array.isArray((data as any)?.conversations)
      ? (data as any).conversations
      : []
  for (const conv of convs) {
    if (conv === null || typeof conv !== 'object') continue
    if (conv.mapping !== null && typeof conv.mapping === 'object') return 'chatgpt'
    if (Array.isArray(conv.chat_messages) || Array.isArray(conv.messages)) return 'claude-web'
  }
  return 'unknown'
}

/** 解析一份 JSON 文本（已知是 conversations 或 memories）。 */
function parseJsonPayload(text: string, uri: string): ImportResult {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (error) {
    return {
      ...EMPTY,
      results: [{
        source: 'claude-web',
        conversations: 0,
        turns: 0,
        skipped: 0,
        errors: [{ uri, message: `不是合法 JSON：${String(error)}` }],
      }],
    }
  }

  // memories.json 的特征字段，与 conversations.json 完全不重叠。
  const asObject: any = Array.isArray(data) ? data[0] : data
  const looksLikeMemories =
    asObject !== null &&
    typeof asObject === 'object' &&
    ('conversations_memory' in asObject || 'project_memories' in asObject || 'memory_files' in asObject)
  if (looksLikeMemories) {
    const candidates = parseClaudeMemories(data, uri)
    return {
      conversations: [],
      candidates,
      results: [{
        source: 'claude-memory',
        conversations: 0,
        turns: candidates.length,
        skipped: 0,
        errors: [],
      }],
    }
  }

  const format = detectConversationsFormat(data)
  if (format === 'chatgpt') {
    const { conversations, result } = parseChatGPT(data, uri)
    return { conversations, candidates: [], results: [result] }
  }
  if (format === 'claude-web') {
    const { conversations, result } = parseClaudeWeb(data, uri)
    return { conversations, candidates: [], results: [result] }
  }
  return {
    ...EMPTY,
    results: [{
      source: 'claude-web',
      conversations: 0,
      turns: 0,
      skipped: 0,
      errors: [{ uri, message: '认不出这份 JSON —— 既不像 Claude 导出，也不像 ChatGPT 导出' }],
    }],
  }
}

/** 该文件名是否值得解析（导出包里绝大多数文件都不是我们要的）。 */
function isInteresting(name: string): boolean {
  const base = basename(name).toLowerCase()
  return base.startsWith('conversations') && base.endsWith('.json') || base === 'memories.json'
}

function merge(target: ImportResult, add: ImportResult): void {
  target.conversations.push(...add.conversations)
  target.candidates.push(...add.candidates)
  target.results.push(...add.results)
}

/** 解析一个导出 zip 的字节内容。 */
export function importZip(bytes: Uint8Array, uri = 'export.zip'): ImportResult {
  const out: ImportResult = { conversations: [], candidates: [], results: [] }
  let files: Record<string, Uint8Array>
  try {
    // 只解压我们要的成员——导出包里常有几百兆的图片附件，全解会炸内存。
    files = unzipSync(bytes, { filter: file => isInteresting(file.name) })
  } catch (error) {
    out.results.push({
      source: 'claude-web',
      conversations: 0,
      turns: 0,
      skipped: 0,
      errors: [{ uri, message: `解压失败：${String(error)}` }],
    })
    return out
  }
  const names = Object.keys(files).sort()
  if (names.length === 0) {
    out.results.push({
      source: 'claude-web',
      conversations: 0,
      turns: 0,
      skipped: 0,
      errors: [{ uri, message: '压缩包里没找到 conversations*.json 或 memories.json' }],
    })
    return out
  }
  const decoder = new TextDecoder('utf-8')
  for (const name of names) {
    const bytes = files[name]
    if (bytes === undefined) continue
    merge(out, parseJsonPayload(decoder.decode(bytes), `${uri}!${name}`))
  }
  return out
}

/**
 * 导入一个本机路径：zip / json 单文件 / 已解压目录都吃。
 *
 * 目录会递归找分片（大账号的 ChatGPT 导出会切成 conversations-1.json…）。
 */
export async function importPath(path: string): Promise<ImportResult> {
  const info = await stat(path)
  if (info.isDirectory()) {
    const out: ImportResult = { conversations: [], candidates: [], results: [] }
    for (const entry of await readdir(path, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile() || !isInteresting(entry.name)) continue
      const full = join(entry.parentPath ?? path, entry.name)
      merge(out, parseJsonPayload(await readFile(full, 'utf8'), full))
    }
    if (out.results.length === 0) {
      out.results.push({
        source: 'claude-web',
        conversations: 0,
        turns: 0,
        skipped: 0,
        errors: [{ uri: path, message: '目录里没找到 conversations*.json 或 memories.json' }],
      })
    }
    return out
  }
  if (path.toLowerCase().endsWith('.zip')) {
    return importZip(new Uint8Array(await readFile(path)), path)
  }
  return parseJsonPayload(await readFile(path, 'utf8'), path)
}
