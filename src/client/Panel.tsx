/**
 * 记忆搬家面板：搬家 / 待确认 / 记忆库 三页。
 *
 * 贯穿三页的一条规矩：**每条记忆都要说清自己是怎么进来的**。
 * 入库依据（gateReason）随条目一起显示，档位选择摆在搬家页而不是设置深处——
 * 用户要能一眼看出"哪些自动进了库、为什么"，然后自己决定松紧。
 *
 * 所有用户可见文案走 `useT()`，不写死中文——英文场（官方 Discussions、
 * awesome 列表）是主要流量入口，界面漏中文会直接砍掉转化。
 */
import { useCallback, useEffect, useState } from 'react'
import {
  api,
  type Available,
  type DistillReport,
  type Estimate,
  type MemoryView,
  type ModelChoice,
} from './api.ts'
import type { PorterKey } from './locales.ts'
import { useT, type Translate } from './t.ts'

type Tab = 'port' | 'pending' | 'library'

const MODES = [
  { id: 'strict', name: 'mode.strict', desc: 'mode.strictDesc' },
  { id: 'balanced', name: 'mode.balanced', desc: 'mode.balancedDesc' },
  { id: 'trusting', name: 'mode.trusting', desc: 'mode.trustingDesc' },
] as const

/** 入库依据是 host 侧的稳定键，到这里才翻成人话。 */
function reasonText(t: Translate, reason: string): string {
  return t(`reason.${reason}` as PorterKey)
}

function ReasonTag({ reason }: { reason: string }): React.JSX.Element {
  const t = useT()
  const auto = reason.startsWith('auto-')
  return <span className={`mp-reason ${auto ? 'auto' : 'human'}`}>{reasonText(t, reason)}</span>
}

function MemoryCard({
  item,
  onDecide,
}: {
  item: MemoryView & { score?: number }
  onDecide?: (decision: 'approved' | 'discarded') => void
}): React.JSX.Element {
  const t = useT()
  return (
    <div className="mp-item">
      <div className="mp-item-top">
        <span className="mp-type">{item.type}</span>
        <ReasonTag reason={item.gateReason} />
        {item.links.length > 0
          && <span className="mp-reason human">{t('card.related', { count: item.links.length })}</span>}
        {item.score !== undefined && <span className="mp-meta">{t('card.score', { score: item.score })}</span>}
      </div>
      <div className="mp-claim">{item.claim}</div>
      <div className="mp-evidence">{item.evidence}</div>
      <div className="mp-meta">
        {t('card.meta', {
          confidence: item.confidence,
          date: item.validFrom,
          sources: item.sources.map(s => `${s.source}:${s.convId.slice(0, 8)}`).join('、'),
        })}
        {item.context !== undefined && ` · ${item.context}`}
      </div>
      {onDecide !== undefined && (
        <div className="mp-item-actions">
          <button className="mp-btn" onClick={() => onDecide('approved')}>{t('card.approve')}</button>
          <button className="mp-btn plain" onClick={() => onDecide('discarded')}>{t('card.discard')}</button>
        </div>
      )}
    </div>
  )
}

function PortTab({
  available,
  mode,
  onMode,
  onDone,
}: {
  available: Available | undefined
  mode: string
  onMode: (mode: string) => void
  onDone: () => void
}): React.JSX.Element {
  const t = useT()
  const [estimate, setEstimate] = useState<
    { conversations: number; estimate: Estimate; modelSource: string } | undefined
  >()
  const [report, setReport] = useState<DistillReport | undefined>()
  const [busy, setBusy] = useState<'' | 'local' | 'stats' | 'import' | 'estimate' | 'distill'>('')
  const [error, setError] = useState<string | undefined>()
  const [local, setLocal] = useState<{ userTurns: number; found: number } | undefined>()
  const [stats, setStats] = useState<
    { conversations: number; messages: number; userTurns: number; chars: number; earliest: string } | undefined
  >()
  const [importPath, setImportPath] = useState('')
  const [imported, setImported] = useState<{ conversations: number; candidates: number } | undefined>()
  const [models, setModels] = useState<ModelChoice[]>([])
  /** 空串 = 跟随宿主默认；否则是 "provider::model"。 */
  const [pick, setPick] = useState('')
  const [defaultLabel, setDefaultLabel] = useState<string | undefined>()
  const [ticks, setTicks] = useState<{ done: number; total: number } | undefined>()

  useEffect(() => {
    void api.models()
      .then(data => {
        setModels(data.models)
        if (data.current !== undefined) setDefaultLabel(`${data.current.model}（${data.current.source}）`)
      })
      .catch(() => undefined)
  }, [])

  // 提纯是分块跑的长任务（实测 7 个会话近 5 分钟），跑的时候轮询进度，
  // 否则用户面对一个不动的「正在搬…」会以为卡死。
  useEffect(() => {
    if (busy !== 'distill') {
      setTicks(undefined)
      return
    }
    const timer = setInterval(() => {
      void api.progress()
        .then(p => {
          if (p.total > 0) setTicks({ done: p.done, total: p.total })
        })
        .catch(() => undefined)
    }, 2000)
    return () => clearInterval(timer)
  }, [busy])

  const picked = (): { provider: string; model: string } | undefined => {
    if (pick === '') return undefined
    const [provider, model] = pick.split('::')
    return provider !== undefined && model !== undefined ? { provider, model } : undefined
  }

  const run = async (kind: 'local' | 'stats' | 'import' | 'estimate' | 'distill'): Promise<void> => {
    setBusy(kind)
    setError(undefined)
    try {
      if (kind === 'stats') setStats(await api.stats())
      else if (kind === 'import') {
        const result = await api.importPath(importPath.trim())
        const conversations = result.results.reduce((n, r) => n + r.conversations, 0)
        setImported({ conversations, candidates: result.candidates })
        onDone()
      } else if (kind === 'local') {
        setLocal(await api.localScan())
        onDone()
      } else if (kind === 'estimate') setEstimate(await api.estimate(picked()))
      else {
        setReport(await api.distill(picked()))
        onDone()
      }
    } catch (caught) {
      setError(String(caught instanceof Error ? caught.message : caught))
    } finally {
      setBusy('')
    }
  }

  // 换模型 = 换价格，旧的预估立刻作废，别让用户拿着 flash 的报价点了 pro 的按钮。
  const changeModel = (value: string): void => {
    setPick(value)
    setEstimate(undefined)
  }

  return (
    <>
      <div className="mp-cards">
        <div className="mp-card hero">
          <div className="mp-card-label">{t('top.portable')}</div>
          <div className="mp-card-value">{available?.claudeCode ?? 0}</div>
          <div className="mp-card-hint">{t('top.portableHint')}</div>
        </div>
        <div className="mp-card">
          <div className="mp-card-label">{t('top.stored')}</div>
          <div className="mp-card-value">{available?.memories ?? 0}</div>
        </div>
        <div className="mp-card">
          <div className="mp-card-label">{t('top.pending')}</div>
          <div className="mp-card-value">{available?.pending ?? 0}</div>
        </div>
      </div>

      <div className="mp-note" style={{ marginTop: 14 }}><b>{t('mode.head')}</b></div>
      <div className="mp-modes">
        {MODES.map(option => (
          <button
            key={option.id}
            className="mp-mode"
            data-on={mode === option.id ? '1' : '0'}
            onClick={() => onMode(option.id)}
          >
            <div className="mp-mode-name">{t(option.name)}</div>
            <div className="mp-mode-desc">{t(option.desc)}</div>
          </button>
        ))}
      </div>
      <div className="mp-note">{t('mode.note')}</div>

      {/* ① 免费且情绪最强的那条路：抢救 Claude 对你的记忆。 */}
      <div className="mp-lane">
        <div className="mp-lane-head">
          <span className="mp-lane-tag free">{t('lane.free')}</span>
          <b>{t('import.head')}</b>
        </div>
        <div className="mp-note" style={{ marginTop: 0 }}>{t('import.lead')}</div>
        <div className="mp-search" style={{ marginTop: 10 }}>
          <input
            className="mp-input"
            placeholder={t('import.placeholder')}
            value={importPath}
            onChange={event => setImportPath(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') void run('import')
            }}
          />
          <button
            className="mp-btn"
            disabled={busy !== '' || importPath.trim() === ''}
            onClick={() => void run('import')}
          >
            {busy === 'import' ? t('import.busy') : t('import.action')}
          </button>
        </div>
        {imported !== undefined && (
          <div className="mp-note">
            {t('import.done', { conversations: imported.conversations, candidates: imported.candidates })}
            {imported.conversations > 0 && t('import.more')}
          </div>
        )}
      </div>

      {/* ② 本机对话：先如实展示存量，再明码标价。 */}
      <div className="mp-lane">
        <div className="mp-lane-head">
          <span className="mp-lane-tag">{t('lane.local')}</span>
          <b>{t('stats.head')}</b>
        </div>
        {stats === undefined
          ? (
              <div className="mp-actions">
                <button className="mp-btn ghost" disabled={busy !== ''} onClick={() => void run('stats')}>
                  {busy === 'stats' ? t('stats.busy') : t('stats.action')}
                </button>
              </div>
            )
          : (
              <>
                <div className="mp-cards" style={{ marginTop: 10 }}>
                  <div className="mp-card hero">
                    <div className="mp-card-label">{t('stats.mine')}</div>
                    <div className="mp-card-value">{stats.userTurns}</div>
                    <div className="mp-card-hint">{t('stats.mineHint', { chars: stats.chars.toLocaleString() })}</div>
                  </div>
                  <div className="mp-card">
                    <div className="mp-card-label">{t('stats.convs')}</div>
                    <div className="mp-card-value">{stats.conversations}</div>
                    <div className="mp-card-hint">{t('stats.convsHint', { count: stats.messages })}</div>
                  </div>
                  <div className="mp-card">
                    <div className="mp-card-label">{t('stats.earliest')}</div>
                    <div className="mp-card-value" style={{ fontSize: 17 }}>{stats.earliest || '—'}</div>
                    <div className="mp-card-hint">{t('stats.earliestHint')}</div>
                  </div>
                </div>
                <button className="mp-linkish" disabled={busy !== ''} onClick={() => void run('local')}>
                  {busy === 'local' ? t('local.busy') : t('local.action')}
                </button>
                {local !== undefined && (
                  <div className="mp-note">{t('local.done', { found: local.found })}</div>
                )}
              </>
            )}
      </div>

      {/* 用哪个模型 = 花多少钱，所以选择器就摆在算钱按钮旁边。 */}
      <div className="mp-actions">
        <label className="mp-field">
          <span className="mp-field-label">{t('model.label')}</span>
          <select className="mp-input" value={pick} onChange={event => changeModel(event.target.value)}>
            <option value="">{t('model.follow', { label: defaultLabel ?? t('model.default') })}</option>
            {models.map(model => (
              <option key={`${model.provider}::${model.id}`} value={`${model.provider}::${model.id}`}>
                {model.name}（{model.provider}）
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="mp-note">
        {t('model.note')}
        {models.length === 0 && t('model.none')}
      </div>

      <div className="mp-actions">
        <button className="mp-btn ghost" disabled={busy !== ''} onClick={() => void run('estimate')}>
          {busy === 'estimate' ? t('run.estimateBusy') : t('run.estimate')}
        </button>
        <button
          className="mp-btn"
          disabled={busy !== '' || estimate === undefined}
          onClick={() => void run('distill')}
        >
          {busy === 'distill' ? t('run.distillBusy') : t('run.distill')}
        </button>
      </div>

      {busy === 'distill' && ticks !== undefined && (
        <div className="mp-note">
          <div className="mp-progress"><i style={{ width: `${Math.round(ticks.done / ticks.total * 100)}%` }} /></div>
          {t('run.progress', { done: ticks.done, total: ticks.total })}
        </div>
      )}

      {estimate !== undefined && (
        <div className="mp-alert">
          {t('estimate.line', {
            conversations: estimate.conversations,
            tokens: estimate.estimate.inputTokens.toLocaleString(),
            model: estimate.estimate.model,
            source: estimate.modelSource,
            cost: estimate.estimate.cny,
          })}
          {estimate.estimate.repriced && estimate.estimate.peak
            && t('estimate.peak', { cost: estimate.estimate.offPeakCny })}
          {t('estimate.outbound')}
        </div>
      )}

      {report !== undefined && (
        <div className="mp-note">
          {t('report.line', {
            model: report.model ?? '?',
            conversations: report.conversations,
            candidates: report.candidates,
            accepted: report.ingested?.accepted ?? 0,
            pending: report.ingested?.pending ?? 0,
          })}
          {report.rejectedNotVerbatim > 0 && t('report.blocked', { count: report.rejectedNotVerbatim })}
          {report.fromAssistant > 0 && t('report.fromAssistant', { count: report.fromAssistant })}
          {report.errors.length > 0 && t('report.errors', { count: report.errors.length })}
        </div>
      )}

      {error !== undefined && <div className="mp-alert">{t('error.line', { message: error })}</div>}
    </>
  )
}

function PendingTab({ onChanged }: { onChanged: () => void }): React.JSX.Element {
  const t = useT()
  const [queue, setQueue] = useState<MemoryView[] | undefined>()
  const load = useCallback(() => {
    void api.queue().then(data => setQueue(data.queue)).catch(() => setQueue([]))
  }, [])
  useEffect(load, [load])

  const decide = async (id: string, decision: 'approved' | 'discarded'): Promise<void> => {
    await api.decide(id, decision)
    setQueue(current => current?.filter(item => item.id !== id))
    onChanged()
  }

  if (queue === undefined) return <div className="mp-empty">{t('queue.loading')}</div>
  if (queue.length === 0) return <div className="mp-empty">{t('queue.empty')}</div>
  return (
    <>
      <div className="mp-note">{t('queue.note')}</div>
      {queue.map(item => (
        <MemoryCard key={item.id} item={item} onDecide={decision => void decide(item.id, decision)} />
      ))}
    </>
  )
}

function LibraryTab(): React.JSX.Element {
  const t = useT()
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<(MemoryView & { score: number })[] | undefined>()
  const [all, setAll] = useState<MemoryView[] | undefined>()

  useEffect(() => {
    void api.memories().then(data => setAll(data.memories)).catch(() => setAll([]))
  }, [])

  const search = async (): Promise<void> => {
    if (query.trim() === '') {
      setHits(undefined)
      return
    }
    setHits((await api.recall(query, 8)).hits)
  }

  const shown = hits ?? all
  return (
    <>
      <div className="mp-search">
        <input
          className="mp-input"
          placeholder={t('library.placeholder')}
          value={query}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') void search()
          }}
        />
        <button className="mp-btn" onClick={() => void search()}>{t('library.search')}</button>
        <a className="mp-btn plain" href="/memory-porter/api/export" download="memories.md">
          {t('library.exportMd')}
        </a>
        <a className="mp-btn plain" href="/memory-porter/api/export?format=jsonl" download="memories.jsonl">
          {t('library.exportJsonl')}
        </a>
      </div>
      <div className="mp-note">{t('library.note')}</div>
      {shown === undefined && <div className="mp-empty">{t('queue.loading')}</div>}
      {shown !== undefined && shown.length === 0 && (
        <div className="mp-empty">{hits === undefined ? t('library.empty') : t('library.noHits')}</div>
      )}
      {shown?.map(item => <MemoryCard key={item.id} item={item} />)}
    </>
  )
}

export function Panel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const t = useT()
  const [tab, setTab] = useState<Tab>('port')
  const [available, setAvailable] = useState<Available | undefined>()
  const [mode, setMode] = useState('balanced')

  const refresh = useCallback(() => {
    void api.available().then(setAvailable).catch(() => undefined)
  }, [])
  useEffect(refresh, [refresh])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const reasons = Object.entries(available?.byReason ?? {})

  return (
    <div className="mp-overlay" onClick={onClose}>
      <div className="mp-panel" onClick={event => event.stopPropagation()}>
        <div className="mp-head">
          <span className="mp-head-icon">📦</span>
          <div>
            <div className="mp-head-title">{t('panel.title')}</div>
            <div className="mp-head-sub">{t('panel.subtitle')}</div>
          </div>
          <button className="mp-close" title={t('panel.close')} onClick={onClose}>×</button>
        </div>

        <div className="mp-tabs">
          <button className="mp-tab" data-on={tab === 'port' ? '1' : '0'} onClick={() => setTab('port')}>
            {t('tab.port')}
          </button>
          <button className="mp-tab" data-on={tab === 'pending' ? '1' : '0'} onClick={() => setTab('pending')}>
            {t('tab.pending')}
            {(available?.pending ?? 0) > 0 && <span className="mp-tab-count">{available?.pending}</span>}
          </button>
          <button className="mp-tab" data-on={tab === 'library' ? '1' : '0'} onClick={() => setTab('library')}>
            {t('tab.library')}
            {(available?.memories ?? 0) > 0 && <span className="mp-tab-count">{available?.memories}</span>}
          </button>
        </div>

        <div className="mp-body">
          {/* 入库依据分布：一眼看清这个库是怎么长成现在这样的。 */}
          {reasons.length > 0 && (
            <div className="mp-reasons">
              {reasons.map(([reason, count]) => (
                <span key={reason} className={`mp-reason ${reason.startsWith('auto-') ? 'auto' : 'human'}`}>
                  {reasonText(t, reason)} · {count}
                </span>
              ))}
            </div>
          )}
          {tab === 'port' && <PortTab available={available} mode={mode} onMode={setMode} onDone={refresh} />}
          {tab === 'pending' && <PendingTab onChanged={refresh} />}
          {tab === 'library' && <LibraryTab />}
        </div>
      </div>
    </div>
  )
}
