/**
 * 侧边栏底部入口（`sidebar.footer.action`，与「设置」齿轮同一排）。
 *
 * 为什么必须有这个：会话头部那个徽章只在**打开一个会话之后**才渲染，
 * 而「搬家」恰恰是装完插件的第一个动作——那时用户还停在首页、一个会话都没有，
 * 于是什么也看不到。真机 E2E 第一次点开就撞上了这个问题。
 *
 * 侧栏收起时只留图标（宿主通过 `wide` 告诉我们当前宽窄）。
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, type Available } from './api.ts'
import { Panel } from './Panel.tsx'
import { makeT, TranslateContext } from './t.ts'

export function SidebarEntry(props: Record<string, unknown>): React.JSX.Element {
  const wide = props.wide !== false
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

  const portable = available?.claudeCode ?? 0
  const pending = available?.pending ?? 0
  const title = t('side.title', {
    portable,
    pending: pending > 0 ? t('side.pending', { count: pending }) : '',
  })

  return (
    <TranslateContext.Provider value={t}>
      <button type="button" className="mp-side" title={title} onClick={() => setOpen(true)}>
        <span className="mp-side-icon">📦</span>
        {wide && <span className="mp-side-label">{t('side.label')}</span>}
        {wide && portable > 0 && <span className="mp-side-count">{portable}</span>}
        {pending > 0 && <span className="mp-chip-dot" />}
      </button>
      {open && typeof document !== 'undefined'
        && createPortal(<Panel onClose={() => setOpen(false)} />, document.body)}
    </TranslateContext.Provider>
  )
}
