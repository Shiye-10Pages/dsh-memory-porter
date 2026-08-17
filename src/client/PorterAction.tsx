/**
 * 会话头部的入口徽章（次要入口）。
 *
 * 主入口在侧边栏底部——搬家是装完插件的第一个动作，那时还没有会话。
 * 这里是搬完之后在对话里随手看一眼记忆库用的。
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, type Available } from './api.ts'
import { Panel } from './Panel.tsx'
import { makeT, TranslateContext } from './t.ts'

export function PorterAction(props: Record<string, unknown>): React.JSX.Element | null {
  const t = makeT(props.t)
  const [available, setAvailable] = useState<Available | undefined>(undefined)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    void api.available()
      .then(data => {
        if (!cancelled) setAvailable(data)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [open])

  // host 半不可用、且本机也没东西可搬时整体隐身——空按钮只是噪声。
  if (available === undefined) return null
  const total = available.claudeCode + available.memories + available.pending
  if (total === 0) return null

  return (
    <TranslateContext.Provider value={t}>
      <button
        type="button"
        className="mp-chip"
        title={t('chip.title', { count: available.claudeCode })}
        onClick={() => setOpen(true)}
      >
        <span>📦</span>
        <span>{available.memories > 0 ? available.memories : available.claudeCode}</span>
        {available.pending > 0 && <span className="mp-chip-dot" />}
      </button>
      {open && typeof document !== 'undefined'
        && createPortal(<Panel onClose={() => setOpen(false)} />, document.body)}
    </TranslateContext.Provider>
  )
}
