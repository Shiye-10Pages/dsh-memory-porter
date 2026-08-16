/**
 * 会话头部的入口按钮。
 *
 * 徽章上那个数字本身就是钩子——「你还有 1,247 个对话没搬」。
 * 有待确认条目时挂一个小红点，点开是完整面板。
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, type Available } from './api.ts'
import { Panel } from './Panel.tsx'

export function PorterAction(): React.JSX.Element | null {
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
    <>
      <button
        type="button"
        className="mp-chip"
        title={`记忆搬家：本机 ${available.claudeCode} 个会话可搬 · 已入库 ${available.memories} 条 · ${available.pending} 条待确认`}
        onClick={() => setOpen(true)}
      >
        <span>📦</span>
        <span>{available.memories > 0 ? available.memories : available.claudeCode}</span>
        {available.pending > 0 && <span className="mp-chip-dot" />}
      </button>
      {open && typeof document !== 'undefined'
        && createPortal(<Panel onClose={() => setOpen(false)} />, document.body)}
    </>
  )
}
