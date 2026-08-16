/**
 * 面板与 host 半之间的调用。
 *
 * 全部走同源 `/memory-porter/api/*`，没有任何外部请求——
 * 面板本身不联网，唯一的出网发生在 host 侧调用宿主已配的模型。
 */

/** 与 host 侧 MemoryItem 对齐的浏览器视图（字段子集，够画就行）。 */
export interface MemoryView {
  id: string
  type: string
  claim: string
  evidence: string
  context?: string
  sources: { source: string; convId: string; uri?: string }[]
  confidence: number
  validFrom: string
  status: string
  gateReason: string
  links: string[]
}

export interface Available {
  claudeCode: number
  scanLimit: number
  memories: number
  pending: number
  decided: number
  bySource: Record<string, number>
  byReason: Record<string, number>
}

export interface Estimate {
  inputTokens: number
  outputTokens: number
  cny: number
  offPeakCny: number
  model: string
  peak: boolean
  repriced: boolean
}

export interface ModelChoice {
  provider: string
  id: string
  name: string
}

export interface DistillReport {
  conversations: number
  candidates: number
  rejectedNotVerbatim: number
  usage: { inputTokens: number; outputTokens: number }
  errors: { uri: string; message: string }[]
  model?: string
  modelSource?: string
  ingested?: {
    accepted: number
    pending: number
    skipped: number
    rejected: number
    merged: number
    nearPairs: number
  }
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/memory-porter/api/${path}`, body === undefined
    ? undefined
    : {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
  const data: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const message = (data as { error?: unknown })?.error
    throw new Error(typeof message === 'string' ? message : `HTTP ${response.status}`)
  }
  return data as T
}

export const api = {
  available: () => call<Available>('available'),
  queue: () => call<{ queue: MemoryView[] }>('queue'),
  memories: () => call<{ memories: MemoryView[] }>('memories'),
  localScan: () => call<{
    conversations: number
    userTurns: number
    found: number
    ingested: { accepted: number; pending: number; skipped: number }
  }>('local-scan', {}),
  models: () => call<{
    models: ModelChoice[]
    current?: { provider: string; model: string; source: string }
  }>('models'),
  estimate: (pick?: { provider: string; model: string }) =>
    call<{ conversations: number; estimate: Estimate; provider: string; modelSource: string }>(
      'estimate',
      { ...pick },
    ),
  distill: (pick?: { provider: string; model: string }) =>
    call<DistillReport>('distill', { ...pick, confirm: true }),
  importPath: (path: string) => call<unknown>('import', { path }),
  decide: (id: string, decision: 'approved' | 'discarded') => call<Available>('decide', { id, decision }),
  recall: (query: string, topk = 6) =>
    call<{ count: number; hits: (MemoryView & { score: number })[] }>('recall', { query, topk }),
}
