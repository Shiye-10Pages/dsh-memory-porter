/**
 * 本地规则抽取：不用模型、不联网、不花钱，200 毫秒出结果。
 *
 * 为什么要有这条路：
 * 1. **把 aha 提到付费之前**——装上就能看到"自己说过的话被翻出来了"，
 *    而不是先掏钱再等几分钟。
 * 2. **给不愿把对话发给云端的人一条完整的降级路径**——全程离线。
 * 3. **宿主没挂 llm 时插件第一屏也有东西**。
 *
 * 保真上它其实比 LLM 提纯更硬：证据就是那句原话本身，幻觉概率为零。
 * 契约的可信阶梯本来就写着「规则/结构化字段 > LLM 推断」，
 * `confidence()` 给规则抽取的 extraction_method 是 0.9、给 LLM 的是 0.75。
 *
 * 代价是召回率低——只抓显式的决断句式，抓不到隐含结论。所以产物一律标明
 * 来自规则抽取、并走人工闸，不冒充完整提纯。
 */
import type { Candidate, MemoryType, RawConversation, SourcePointer } from './types.ts'

/** 一组标记词 → 一个契约类型。先长后短匹配，避免「决定」抢走「我决定不做」。 */
interface MarkerGroup {
  type: MemoryType
  markers: readonly string[]
}

/**
 * 高精度标记词表。**宁可漏，不可噪**——规则抽取一旦噪声大，
 * 用户第一屏看到的就是垃圾，比什么都不显示更糟。
 */
const MARKER_GROUPS: readonly MarkerGroup[] = [
  {
    type: '决策',
    markers: ['我决定', '就定', '定了', '最终选', '改成', '改为', '放弃', '不做了', '砍掉', '优先做', '先做'],
  },
  {
    type: 'SOP',
    markers: ['以后都', '以后一律', '从今天起', '不要再', '别再', '一律', '千万不要', '务必', '记住', '每次都要'],
  },
  {
    type: '偏好',
    markers: ['我喜欢', '我不喜欢', '我倾向', '我更喜欢', '我习惯', '我讨厌', '我受不了'],
  },
  {
    type: '经验',
    markers: ['教训', '踩坑', '踩过坑', '下次注意', '吃过亏', '坑在', '血泪'],
  },
  {
    type: '认知',
    markers: ['原则上', '本质上', '关键在于', '关键是', '核心是', '结论是', '说白了'],
  },
]

/** 命中这些词的句子额外标 impact，交人工闸把关（与 gate.ts 的业务词表同源）。 */
const IMPACT_MARKERS: readonly string[] = [
  '定价', '价格', '收入', '营收', '客单', '商业模式', '变现', '方向', '战略', '融资', '付费', '订阅',
]

/** 单句长度窗口。短于 8 字过不了逐字校验闸，长于 120 字多半是整段而非结论。 */
const MIN_CHARS = 8
const MAX_CHARS = 120

/**
 * 连接器把上传附件的正文拼在这个标记之后（见 claude-web.ts）。
 *
 * 那部分对 LLM 提纯有价值（是他当时喂进去的资料），但**对规则抽取必须切掉**——
 * 这一层承诺的是"你自己说过的话"，附件是别人写的、或 AI 生成的文档。
 * 真实导出上就栽在这里：挑出来的 6 句里有 4 句出自两个附件。
 */
const ATTACHMENT_MARKER = '[上传附件正文]'

/** 只保留他自己敲进输入框的那部分。 */
export function typedPart(text: string): string {
  const at = text.indexOf(ATTACHMENT_MARKER)
  return at === -1 ? text : text.slice(0, at)
}

/**
 * 切句。中英标点都切，并且**先剥掉代码块**——
 * Claude Code 的 transcript 里大半是代码，代码里的「必须」「一律」不是人的判断。
 */
export function sentences(text: string): string[] {
  const withoutCode = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
  return withoutCode
    .split(/[。！？!?\n]+/)
    .map(s => s.trim())
    .filter(s => s !== '')
}

/**
 * 这一整条发言是不是"贴进来的文档"而非"他在说话"。
 *
 * 真实数据上最大的噪声源就是这个：用户把技能文件、方案 markdown、表格
 * 整段贴给 AI，里面自然有一堆「一律」「必须」「改成」——那是文档的措辞，
 * 不是他此刻下的判断。整条发言先判一次，比逐句去猜准得多。
 */
export function looksLikePaste(text: string): boolean {
  const lines = text.split('\n')
  if (lines.length < 4) return false
  let structural = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    // markdown 列表 / 表格 / 标题 / 引用 / 有序列表
    if (/^([-*>#|]|\d+[.)])/.test(trimmed)) structural++
  }
  const nonEmpty = lines.filter(l => l.trim() !== '').length
  return nonEmpty > 0 && structural / nonEmpty >= 0.3
}

/** 这句话像不像一条"他自己下的判断"；像就返回类型，不像返回 undefined。 */
export function classify(sentence: string): MemoryType | undefined {
  const length = [...sentence].length
  if (length < MIN_CHARS || length > MAX_CHARS) return undefined
  // 疑问句是在问，不是在定。
  if (/[?？]$/.test(sentence)) return undefined
  // 祈使给 AI 的指令（"帮我…"/"你来…"）不是关于他自己的长期判断。
  if (/^(帮我|你来|请你|麻烦你|继续|再来)/.test(sentence)) return undefined
  // markdown 结构行（列表项 / 表格行 / 标题 / 引用）是文档的骨架，不是人话。
  if (/^([-*>#|]|\d+[.)]|\*\*)/.test(sentence)) return undefined
  if (sentence.includes('|')) return undefined
  // 字面的 \n / \t —— 来自被转义过的 JSON 或代码，说明这是数据不是发言。
  if (/\\[nrt]/.test(sentence)) return undefined

  for (const group of MARKER_GROUPS) {
    for (const marker of group.markers) {
      if (sentence.includes(marker)) return group.type
    }
  }
  return undefined
}

/**
 * 从一批会话里抽出候选。
 *
 * **只看用户说的话**——AI 说的不是他的结论，这一条和 LLM 提纯的提示词要求一致。
 */
export function localExtract(
  conversations: readonly RawConversation[],
  limit = 200,
): { candidates: Candidate[]; scanned: number } {
  const candidates: Candidate[] = []
  const seen = new Set<string>()
  let scanned = 0

  for (const conversation of conversations) {
    for (const turn of conversation.turns) {
      if (turn.role !== 'user') continue
      scanned++
      // 先切掉上传附件正文，只留他自己敲的那部分。
      const typed = typedPart(turn.text)
      // 整段贴进来的文档再整条否掉——这两条是同一个病根的两种形态。
      if (looksLikePaste(typed)) continue
      for (const sentence of sentences(typed)) {
        if (candidates.length >= limit) return { candidates, scanned }
        const type = classify(sentence)
        if (type === undefined) continue
        const key = sentence.replace(/\s+/g, '')
        if (seen.has(key)) continue
        seen.add(key)

        const source: SourcePointer = {
          source: conversation.source,
          convId: conversation.convId,
          uri: conversation.uri,
          seq: turn.seq,
          ts: turn.ts,
        }
        candidates.push({
          type,
          // 规则抽取给不出提炼过的结论，claim 就用原句本身 ——
          // 不替用户改写，这正是它幻觉为零的原因。
          claim: sentence,
          evidence: sentence,
          context: '本地规则抽取（未经模型提纯）',
          source,
          impact: IMPACT_MARKERS.some(marker => sentence.includes(marker)),
          // 规则抽取召回率低、噪声不可避免，一律交人工确认，不自动入库。
          forceReview: true,
        })
      }
    }
  }
  return { candidates, scanned }
}
