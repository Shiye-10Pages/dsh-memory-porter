/**
 * 四道保真闸（保真契约 v1 · CONTRACT.md）
 *
 * 1. **溯源闸** —— 无逐字证据 + 来源指针 → 拒收。
 * 2. **去重合并闸** —— 精确哈希 + 近重复两层；同结论多源 → 合并、累计 sources、升 confidence。
 * 3. **矛盾闸** —— 找到近义旧条则两条都留、互链，**不替用户判谁对**，交人工裁决。
 * 4. **人工闸** —— 高影响或低置信 → 进待确认队列，其余直接入库。
 *
 * 与主库的一处刻意差异：主库用向量嵌入做近重复与矛盾判别，插件版**不依赖嵌入**
 * （DeepSeek 不提供嵌入，强行要求就破坏零配置）。这里用三元组 Jaccard 相似度替代——
 * 纯本地、零依赖、对中文有效。代价是召回率不如向量，所以近似对一律交人工，
 * 而不是自动判成同义或矛盾。
 */
import { createHash } from 'node:crypto'
import type { Candidate, MemoryItem, MemoryType, SourceKind, SourcePointer } from './types.ts'

/** 判为「几乎同一句」的阈值（三元组 Jaccard），达到即自动并源。 */
export const AUTO_SAME = 0.9

/**
 * 判为「同主题、值得让人看一眼」的下限（二元组重叠系数）。
 *
 * 阈值是拿真实中文结论标定出来的，不是拍脑袋：
 * `定价定在 299 元` ⟷ `定价定在 599 元` = 0.71、
 * `优先做小红书渠道` ⟷ `优先做视频号渠道` = 0.43、
 * 无关句 = 0.00。0.4 能把矛盾对捞出来而不把无关条拖下水。
 */
export const NEAR_LO = 0.4

/** 低于此置信度一律进人工闸。 */
export const LOW_CONFIDENCE = 0.45

/** 再审间隔（天）。 */
const REVIEW_DAYS = 14

/**
 * 来源可信阶梯（CONTRACT：第一方结构化源 > 导出文件 > AI 推断）。
 * 数值移植自主库 gate.py 的 SR_BY_SOURCE。
 */
const SOURCE_RELIABILITY: Readonly<Record<SourceKind, number>> = {
  'claude-code': 0.75,
  'claude-memory': 0.7,
  chatgpt: 0.6,
  'claude-web': 0.6,
}

const SR_DEFAULT = 0.65

/**
 * 业务关键词——命中它们才可能算「高影响」。
 *
 * ⚠️ 必须命中**≥2 个不同**词才算数。主库的教训：单个高频词（方向 / 课程 / 付费）
 * 偶然出现就把普通候选刷进人工闸，一度积压 672 条，人工闸等于废掉。
 */
const BUSINESS_KEYWORDS: readonly string[] = [
  '定价', '价格', '收入', '营收', '销售', '客单', '单价', '商业模式', '变现',
  '方向', '放弃', '战略', '融资', '招聘', '离职', '找工作', '课程', '付费', '订阅价',
]

/** 归一化：去掉全部空白并转小写。用于哈希与相似度，不用于存储。 */
export function normalize(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase()
}

/** 结论哈希——同一结论在任何一次导入里都得到同一个 id，写库天然幂等。 */
export function claimId(claim: string): string {
  return createHash('sha256').update(normalize(claim), 'utf8').digest('hex').slice(0, 16)
}

/** 取字符 n 元组集合。中文没有词边界，n 元组比分词稳，且零依赖。 */
export function ngrams(text: string, n: number): Set<string> {
  const chars = [...normalize(text)]
  const out = new Set<string>()
  if (chars.length < n) {
    if (chars.length > 0) out.add(chars.join(''))
    return out
  }
  for (let i = 0; i <= chars.length - n; i++) out.add(chars.slice(i, i + n).join(''))
  return out
}

function intersectionSize(a: Set<string>, b: Set<string>): number {
  let shared = 0
  for (const gram of a) if (b.has(gram)) shared++
  return shared
}

/**
 * 三元组 Jaccard 相似度 0..1 —— 用于**判同**（要高精度，宁可漏不可错）。
 */
export function similarity(a: string, b: string): number {
  const setA = ngrams(a, 3)
  const setB = ngrams(b, 3)
  if (setA.size === 0 || setB.size === 0) return 0
  const shared = intersectionSize(setA, setB)
  return shared / (setA.size + setB.size - shared)
}

/**
 * 二元组重叠系数 0..1 —— 用于**判同主题**（要高召回，用来提名可能矛盾的对）。
 *
 * 为什么不复用上面那个：实测两条真矛盾的结论三元组 Jaccard 低到辨不出来
 * （`优先做小红书渠道` ⟷ `优先做视频号渠道` 只有 0.09，和无关句几乎一样）——
 * 改几个字就把大部分三元组打散了。换成二元组 + 重叠系数（除以较短的那个集合）
 * 后同一对是 0.43，与无关句的 0.00 拉开了距离。
 */
export function topicOverlap(a: string, b: string): number {
  const setA = ngrams(a, 2)
  const setB = ngrams(b, 2)
  if (setA.size === 0 || setB.size === 0) return 0
  return intersectionSize(setA, setB) / Math.min(setA.size, setB.size)
}

/**
 * 复合置信度 = 源可信 × 抽取法 × 证据 × 跨源印证。
 *
 * **刻意不含时效衰减**（沿用主库的决定）：freshness 只回答"还新不新"，不该决定
 * 一条洞见值不值得保留——否则一年前的好方法会因为"老"被埋没。时效语义由
 * validUntil / status 承载。
 */
export function confidence(source: SourceKind, sourceCount: number, byLlm: boolean): number {
  const sr = SOURCE_RELIABILITY[source] ?? SR_DEFAULT
  // 直采连接器（如 Claude 云端记忆）不经 LLM 抽取，抽取法更可信。
  const em = byLlm ? 0.75 : 0.9
  const cross = 1 + Math.min(0.25, 0.05 * (sourceCount - 1))
  return Math.max(0, Math.min(1, Number((sr * em * cross).toFixed(4))))
}

/** 高影响判定：模型说有影响 **且** 命中至少两个不同业务词。 */
export function isHighImpact(candidate: Candidate): boolean {
  if (!candidate.impact) return false
  const blob = normalize(candidate.claim) + normalize(candidate.evidence)
  let hits = 0
  for (const keyword of BUSINESS_KEYWORDS) {
    if (blob.includes(normalize(keyword))) hits++
    if (hits >= 2) return true
  }
  return false
}

/** 溯源闸：无逐字证据或无来源指针 → 拒收。 */
export function passesProvenance(candidate: Candidate): boolean {
  if (candidate.claim.trim() === '' || candidate.evidence.trim() === '') return false
  const source: SourcePointer | undefined = candidate.source
  return source !== undefined && source.convId !== ''
}

function isoDate(atMs: number, plusDays = 0): string {
  return new Date(atMs + plusDays * 86_400_000).toISOString().slice(0, 10)
}

/** 一次过闸的产出。 */
export interface GateResult {
  /** 直接入库的记忆。 */
  accepted: MemoryItem[]
  /** 进待确认队列，等用户逐条批准。 */
  pending: MemoryItem[]
  /** 被溯源闸拒收的条数——要显示给用户，它证明闸门在工作。 */
  rejected: number
  /** 被合并掉的重复条数。 */
  merged: number
  /** 检出的近义对（两条都留、已互链），交用户裁决。 */
  nearPairs: { a: string; b: string; score: number }[]
}

export interface GateOptions {
  /** 库里已有的记忆，用于跨批次去重与矛盾检出。 */
  existing?: readonly MemoryItem[]
  /** 候选是否来自 LLM 提纯（影响置信度的抽取法项）。默认 true。 */
  byLlm?: boolean
  /** 当前时刻，注入以便测试。 */
  now?: number
}

/**
 * 让候选过四道闸。
 *
 * 顺序即优先级：先拒收没证据的，再合并重复的，再检出矛盾的，最后决定谁需要人看。
 */
export function gate(candidates: readonly Candidate[], options: GateOptions = {}): GateResult {
  const byLlm = options.byLlm ?? true
  const now = options.now ?? Date.now()
  const result: GateResult = { accepted: [], pending: [], rejected: 0, merged: 0, nearPairs: [] }

  // ① 溯源闸
  const survived = candidates.filter(candidate => {
    if (passesProvenance(candidate)) return true
    result.rejected++
    return false
  })

  // ② 去重合并闸 · 第一层：结论精确哈希
  const byId = new Map<string, { candidate: Candidate; sources: SourcePointer[] }>()
  for (const candidate of survived) {
    const id = claimId(candidate.claim)
    const seen = byId.get(id)
    if (seen === undefined) {
      byId.set(id, { candidate, sources: [candidate.source] })
      continue
    }
    result.merged++
    // 同结论多源 → 累计来源；证据取更长的那条（信息量更大）。
    seen.sources.push(candidate.source)
    if (candidate.evidence.length > seen.candidate.evidence.length) seen.candidate = candidate
  }

  const existing = [...(options.existing ?? [])]

  for (const [id, group] of byId) {
    const { candidate, sources } = group

    // ② 第二层：与库内已有条目的近重复
    let mergedIntoExisting = false
    for (const item of existing) {
      if (similarity(candidate.claim, item.claim) >= AUTO_SAME) {
        // 几乎同一句 → 并源、升置信度，不再插新条。
        item.sources.push(...sources)
        item.confidence = confidence(candidate.source.source, item.sources.length, byLlm)
        result.merged++
        mergedIntoExisting = true
        break
      }
      // ③ 矛盾闸：同主题但结论不同 —— 两条都留、互链，**不替用户判谁对**。
      const overlap = topicOverlap(candidate.claim, item.claim)
      if (overlap >= NEAR_LO) {
        result.nearPairs.push({ a: id, b: item.id, score: Number(overlap.toFixed(3)) })
      }
    }
    if (mergedIntoExisting) continue

    const score = confidence(candidate.source.source, sources.length, byLlm)
    const linked = result.nearPairs.filter(pair => pair.a === id).map(pair => pair.b)
    const item: MemoryItem = {
      id,
      type: candidate.type as MemoryType,
      claim: candidate.claim,
      evidence: candidate.evidence,
      context: candidate.context,
      sources,
      confidence: score,
      validFrom: isoDate(now),
      validUntil: null,
      status: '待验证',
      reviewDate: isoDate(now, REVIEW_DAYS),
      links: linked,
      contentHash: id,
    }
    // 互链是双向的：旧条也要记住有新条在争。
    for (const otherId of linked) {
      const other = existing.find(e => e.id === otherId)
      if (other !== undefined && !other.links.includes(id)) other.links.push(id)
    }

    // ④ 人工闸
    const needsHuman = candidate.forceReview || isHighImpact(candidate) || score < LOW_CONFIDENCE || linked.length > 0
    if (needsHuman) result.pending.push(item)
    else result.accepted.push(item)
    existing.push(item)
  }

  return result
}
