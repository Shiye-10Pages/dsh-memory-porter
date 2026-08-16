/**
 * 会话头部的入口按钮。
 *
 * 现在只做一件事：显示本机可搬的会话数——**第一屏那个数字本身就是钩子**
 * （「你有 1,247 个对话还没搬」）。M6 会把点击展开成完整面板。
 */
import { useEffect, useState } from 'react'

interface Available {
  claudeCode: number
  scanLimit: number
}

export function PorterAction(): JSX.Element | null {
  const [available, setAvailable] = useState<Available | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    void fetch('/memory-porter/api/available')
      .then(response => (response.ok ? response.json() : undefined))
      .then((data: Available | undefined) => {
        if (!cancelled && data !== undefined) setAvailable(data)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  // 没东西可搬就不占位——空状态的按钮只是噪声。
  if (available === undefined || available.claudeCode === 0) return null

  return (
    <button
      type="button"
      className="memory-porter-action"
      title={`本机还有 ${available.claudeCode} 个 Claude Code 会话可以搬进来`}
    >
      {`📦 ${available.claudeCode}`}
    </button>
  )
}
