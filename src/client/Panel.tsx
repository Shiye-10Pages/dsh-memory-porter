/**
 * 记忆搬家面板：搬家 / 待确认 / 记忆库 三页。
 *
 * 贯穿三页的一条规矩：**每条记忆都要说清自己是怎么进来的**。
 * 入库依据（gateReason）随条目一起显示，档位选择摆在搬家页最上面而不是设置深处——
 * 用户要能一眼看出"哪些自动进了库、为什么"，然后自己决定松紧。
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

type Tab = 'port' | 'pending' | 'library'

const MODES = [
  {
    id: 'strict',
    name: '逐条确认',
    desc: '一条都不自动入库，全部等你点头。最稳，但队列会长。',
  },
  {
    id: 'balanced',
    name: '默认（推荐）',
    desc: '动到钱和方向的、与旧结论冲突的、AI 推断的，才要你看。网页导出的记忆会自动入库。',
  },
  {
    id: 'trusting',
    name: '省事',
    desc: '只有 AI 推断和冲突才拦你，其余全自动。适合先搬进来再慢慢看。',
  },
] as const

function ReasonTag({ reason }: { reason: string }): React.JSX.Element {
  const auto = reason.startsWith('自动入库')
  return <span className={`mp-reason ${auto ? 'auto' : 'human'}`}>{reason}</span>
}

function MemoryCard({
  item,
  onDecide,
}: {
  item: MemoryView & { score?: number }
  onDecide?: (decision: 'approved' | 'discarded') => void
}): React.JSX.Element {
  return (
    <div className="mp-item">
      <div className="mp-item-top">
        <span className="mp-type">{item.type}</span>
        <ReasonTag reason={item.gateReason} />
        {item.links.length > 0 && <span className="mp-reason human">与 {item.links.length} 条已有记忆相关</span>}
        {item.score !== undefined && <span className="mp-meta">相关度 {item.score}</span>}
      </div>
      <div className="mp-claim">{item.claim}</div>
      <div className="mp-evidence">{item.evidence}</div>
      <div className="mp-meta">
        置信度 {item.confidence} · {item.validFrom} 起 · 来源{' '}
        {item.sources.map(s => `${s.source}:${s.convId.slice(0, 8)}`).join('、')}
        {item.context !== undefined && ` · ${item.context}`}
      </div>
      {onDecide !== undefined && (
        <div className="mp-item-actions">
          <button className="mp-btn" onClick={() => onDecide('approved')}>批准入库</button>
          <button className="mp-btn plain" onClick={() => onDecide('discarded')}>丢弃</button>
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
  const [defaultLabel, setDefaultLabel] = useState('dsh 默认模型')

  useEffect(() => {
    void api.models()
      .then(data => {
        setModels(data.models)
        if (data.current !== undefined) setDefaultLabel(`${data.current.model}（${data.current.source}）`)
      })
      .catch(() => undefined)
  }, [])

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
        const result = await api.localScan()
        setLocal(result)
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

  const count = available?.claudeCode ?? 0

  return (
    <>
      <div className="mp-cards">
        <div className="mp-card hero">
          <div className="mp-card-label">本机 Claude Code 会话</div>
          <div className="mp-card-value">{count}</div>
          <div className="mp-card-hint">号没了这些也还在你硬盘上</div>
        </div>
        <div className="mp-card">
          <div className="mp-card-label">已搬进来的记忆</div>
          <div className="mp-card-value">{available?.memories ?? 0}</div>
        </div>
        <div className="mp-card">
          <div className="mp-card-label">等你确认</div>
          <div className="mp-card-value">{available?.pending ?? 0}</div>
        </div>
      </div>

      <div className="mp-note" style={{ marginTop: 14 }}>
        <b>什么会自动入库，什么要你看一眼</b> —— 这条你自己定，随时能改：
      </div>
      <div className="mp-modes">
        {MODES.map(option => (
          <button
            key={option.id}
            className="mp-mode"
            data-on={mode === option.id ? '1' : '0'}
            onClick={() => onMode(option.id)}
          >
            <div className="mp-mode-name">{option.name}</div>
            <div className="mp-mode-desc">{option.desc}</div>
          </button>
        ))}
      </div>
      <div className="mp-note">
        当前档位改的是 <b>cordis.yml 里的 reviewMode</b>；面板这里的切换只影响下一次搬家。
        默认档下，Claude / ChatGPT 网页导出的记忆置信度正好卡在自动入库的线上——
        想更保守就切「逐条确认」。
      </div>

      {/* ① 免费且情绪最强的那条路：抢救 Claude 对你的记忆。 */}
      <div className="mp-lane">
        <div className="mp-lane-head">
          <span className="mp-lane-tag free">免费 · 瞬时</span>
          <b>有 Claude / ChatGPT 的导出？拖进来</b>
        </div>
        <div className="mp-note" style={{ marginTop: 0 }}>
          导出包里的 <code>memories.json</code> 是 <b>Claude 记着的关于你的一切</b>——
          它已经是结论，<b>不过模型、不花一分钱</b>，直接进你的库。
          而这份东西**号一没就彻底消失，别处重建不出来**。
        </div>
        <div className="mp-search" style={{ marginTop: 10 }}>
          <input
            className="mp-input"
            placeholder="导出解压后的文件夹路径，或 conversations.json / memories.json"
            value={importPath}
            onChange={event => setImportPath(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') void run('import')
            }}
          />
          <button className="mp-btn" disabled={busy !== '' || importPath.trim() === ''} onClick={() => void run('import')}>
            {busy === 'import' ? '导入中…' : '导入'}
          </button>
        </div>
        {imported !== undefined && (
          <div className="mp-note">
            读到 <b>{imported.conversations}</b> 个会话；
            <b>{imported.candidates}</b> 条 Claude 记忆已零成本进「待确认」页。
            {imported.conversations > 0 && ' 会话本身还要用模型提纯才能变成记忆，见下。'}
          </div>
        )}
      </div>

      {/* ② 本机对话：先如实展示存量，再明码标价。 */}
      <div className="mp-lane">
        <div className="mp-lane-head">
          <span className="mp-lane-tag">本机</span>
          <b>没有导出？你硬盘上本来就还留着这些</b>
        </div>
        {stats === undefined
          ? (
              <div className="mp-actions">
                <button className="mp-btn ghost" disabled={busy !== ''} onClick={() => void run('stats')}>
                  {busy === 'stats' ? '统计中…' : '看看本机还剩多少（免费）'}
                </button>
              </div>
            )
          : (
              <>
                <div className="mp-cards" style={{ marginTop: 10 }}>
                  <div className="mp-card hero">
                    <div className="mp-card-label">你自己说过的话</div>
                    <div className="mp-card-value">{stats.userTurns}</div>
                    <div className="mp-card-hint">条，共 {stats.chars.toLocaleString()} 字</div>
                  </div>
                  <div className="mp-card">
                    <div className="mp-card-label">会话 / 消息</div>
                    <div className="mp-card-value">{stats.conversations}</div>
                    <div className="mp-card-hint">{stats.messages} 条消息</div>
                  </div>
                  <div className="mp-card">
                    <div className="mp-card-label">最早回到</div>
                    <div className="mp-card-value" style={{ fontSize: 17 }}>{stats.earliest || '—'}</div>
                    <div className="mp-card-hint">号没了，这些也还在</div>
                  </div>
                </div>
                <button className="mp-linkish" disabled={busy !== ''} onClick={() => void run('local')}>
                  {busy === 'local' ? '粗筛中…' : '顺手粗筛一遍显式决断句（免费，会漏很多）'}
                </button>
                {local !== undefined && (
                  <div className="mp-note">
                    粗筛只挑得到「我决定 / 以后都 / 不要再」这类显式句式，这次挑出 <b>{local.found}</b> 句。
                    真正的结论多数是隐含的，得靠下面的模型提纯。
                  </div>
                )}
              </>
            )}
      </div>

      {/* 用哪个模型 = 花多少钱，所以选择器就摆在算钱按钮旁边。 */}
      <div className="mp-actions">
        <label className="mp-field">
          <span className="mp-field-label">提纯用</span>
          <select className="mp-input" value={pick} onChange={event => changeModel(event.target.value)}>
            <option value="">跟随 {defaultLabel}</option>
            {models.map(model => (
              <option key={`${model.provider}::${model.id}`} value={`${model.provider}::${model.id}`}>
                {model.name}（{model.provider}）
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="mp-note">
        <b>想挖得更深？</b>用模型完整提纯一遍——它能抓到规则抓不到的隐含结论，
        代价是<b>会把对话原文发给你在 DSH 里配的模型服务商</b>，并按用量收费。
        搬家是批量作业，<b>和你聊天用的模型可以不一样</b>——会话里临时切的模型不影响这里。
        v4-flash 的输出价只有 v4-pro 的三分之一，批量搬历史通常用 flash 就够。
        {models.length === 0 && ' （当前列不出可选模型，会用宿主默认那个。）'}
      </div>

      <div className="mp-actions">
        <button className="mp-btn ghost" disabled={busy !== ''} onClick={() => void run('estimate')}>
          {busy === 'estimate' ? '算账中…' : '① 先算算要花多少钱'}
        </button>
        <button className="mp-btn" disabled={busy !== '' || estimate === undefined} onClick={() => void run('distill')}>
          {busy === 'distill' ? '正在搬…' : '② 开始搬家'}
        </button>
      </div>

      {estimate !== undefined && (
        <div className="mp-alert">
          {estimate.conversations} 个会话 · 约 {estimate.estimate.inputTokens.toLocaleString()} tokens ·
          用 <b>{estimate.estimate.model}</b>（{estimate.modelSource}）
          现在跑 <b>¥{estimate.estimate.cny}</b>
          {estimate.estimate.repriced && estimate.estimate.peak
            && `（高峰时段；等空闲时段跑约 ¥${estimate.estimate.offPeakCny}）`}
          {' '}—— 提纯会把对话原文发给你在 DSH 里配置的模型服务商。
        </div>
      )}

      {report !== undefined && (
        <div className="mp-note">
          搬完了（用的 <b>{report.model}</b>）：从 <b>{report.conversations}</b> 个会话提炼出{' '}
          <b>{report.candidates}</b> 条候选，
          自动入库 <b>{report.ingested?.accepted ?? 0}</b> 条、
          待你确认 <b>{report.ingested?.pending ?? 0}</b> 条。
          {report.rejectedNotVerbatim > 0 && (
            <>
              {' '}其中 <b>{report.rejectedNotVerbatim}</b> 条因为<b>对不上原文</b>被挡掉了
              —— 证据必须逐字出现在你说过的话里，模型转述的一律不要。
            </>
          )}
          {report.errors.length > 0 && ` 另有 ${report.errors.length} 个会话解析失败。`}
        </div>
      )}

      {error !== undefined && <div className="mp-alert">出错了：{error}</div>}
    </>
  )
}

function PendingTab({ onChanged }: { onChanged: () => void }): React.JSX.Element {
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

  if (queue === undefined) return <div className="mp-empty">读取中…</div>
  if (queue.length === 0) {
    return <div className="mp-empty">队列是空的。<br />该看的都看完了，或者还没搬过东西进来。</div>
  }
  return (
    <>
      <div className="mp-note">
        按「最该看一眼的排前面」排序。每条都标了<b>为什么需要你确认</b>，
        丢弃的条目不会再回到队列。
      </div>
      {queue.map(item => (
        <MemoryCard key={item.id} item={item} onDecide={decision => void decide(item.id, decision)} />
      ))}
    </>
  )
}

function LibraryTab(): React.JSX.Element {
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
          placeholder="试着问一句你以前说过的话，看看能不能召回"
          value={query}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') void search()
          }}
        />
        <button className="mp-btn" onClick={() => void search()}>召回</button>
        <a className="mp-btn plain" href="/memory-porter/api/export" download="memories.md">导出 MD</a>
        <a className="mp-btn plain" href="/memory-porter/api/export?format=jsonl" download="memories.jsonl">JSONL</a>
      </div>
      <div className="mp-note">
        模型也能直接调 <b>recall_memory</b> 拿到同一份结果。导出的 Markdown / JSONL
        可以直接喂给生态里其他记忆插件——它们负责「从今天起记住」，这里负责「把过去搬进来」。
      </div>
      {shown === undefined && <div className="mp-empty">读取中…</div>}
      {shown !== undefined && shown.length === 0 && (
        <div className="mp-empty">
          {hits === undefined ? '记忆库还是空的，先去「搬家」页扫一遍。' : '没召回到相关记忆。'}
        </div>
      )}
      {shown?.map(item => <MemoryCard key={item.id} item={item} />)}
    </>
  )
}

export function Panel({ onClose }: { onClose: () => void }): React.JSX.Element {
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
            <div className="mp-head-title">记忆搬家</div>
            <div className="mp-head-sub">号可以没，记忆不能没</div>
          </div>
          <button className="mp-close" onClick={onClose}>×</button>
        </div>

        <div className="mp-tabs">
          <button className="mp-tab" data-on={tab === 'port' ? '1' : '0'} onClick={() => setTab('port')}>搬家</button>
          <button className="mp-tab" data-on={tab === 'pending' ? '1' : '0'} onClick={() => setTab('pending')}>
            待确认
            {(available?.pending ?? 0) > 0 && <span className="mp-tab-count">{available?.pending}</span>}
          </button>
          <button className="mp-tab" data-on={tab === 'library' ? '1' : '0'} onClick={() => setTab('library')}>
            记忆库
            {(available?.memories ?? 0) > 0 && <span className="mp-tab-count">{available?.memories}</span>}
          </button>
        </div>

        <div className="mp-body">
          {/* 入库依据分布：一眼看清这个库是怎么长成现在这样的。 */}
          {reasons.length > 0 && (
            <div className="mp-reasons">
              {reasons.map(([reason, count]) => (
                <span key={reason} className={`mp-reason ${reason.startsWith('自动入库') ? 'auto' : 'human'}`}>
                  {reason} · {count}
                </span>
              ))}
            </div>
          )}
          {tab === 'port' && (
            <PortTab available={available} mode={mode} onMode={setMode} onDone={refresh} />
          )}
          {tab === 'pending' && <PendingTab onChanged={refresh} />}
          {tab === 'library' && <LibraryTab />}
        </div>
      </div>
    </div>
  )
}
