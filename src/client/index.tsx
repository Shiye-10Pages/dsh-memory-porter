/**
 * dsh-memory-porter · 记忆搬家（browser 半）
 *
 * 在会话头部动作区注册入口。所有注册都做防御性探测：
 * 搬家坏了不能把船弄沉。
 *
 * M6 会把面板三页（搬家 / 待确认 / 记忆库）挂到这里；现在先把接线跑通。
 */
import { PorterAction } from './PorterAction.tsx'
import { SidebarEntry } from './SidebarEntry.tsx'
import { injectStyles } from './styles.ts'
import { NS, en, zh } from './locales.ts'

export const name = 'memory-porter-client'

export const inject = ['slots', 'locale']

interface ClientLikeContext {
  effect(callback: () => void | (() => void), label?: string): void
  locale?: { register(ns: string, dicts: { zh: unknown; en: unknown }): void | (() => void) }
  slots?: {
    inject(slot: string, callback: () => unknown): void
    register(spec: Record<string, unknown>, component: unknown): unknown
  }
  logger?: { warn(msg: string): void }
}

export function apply(ctx: ClientLikeContext): void {
  injectStyles()

  try {
    if (ctx.locale?.register !== undefined) {
      ctx.effect(
        () => ctx.locale!.register(NS, { zh, en }) as (() => void) | void,
        'memory-porter: dictionaries',
      )
    }
  } catch (error) {
    ctx.logger?.warn(`memory-porter: locale register failed: ${String(error)}`)
  }

  // 侧边栏底部入口：**始终可见**，不需要先开会话。
  // 搬家是装完插件的第一个动作，那时用户还停在首页——主入口必须在这里。
  try {
    ctx.slots?.inject('sidebar.footer.action', () => ctx.slots!.register({
      name: 'sidebar.footer.action',
      id: 'memory-porter',
      order: 20,
      locale: NS,
    }, SidebarEntry))
  } catch (error) {
    ctx.logger?.warn(`memory-porter: sidebar slot register failed: ${String(error)}`)
  }

  // 会话头部的小徽章：搬完之后在对话里随手看一眼记忆库，是次要入口。
  try {
    ctx.slots?.inject('conversation.session.header.actions', () => ctx.slots!.register({
      name: 'conversation.session.header.actions',
      id: 'memory-porter',
      order: 41,
      locale: NS,
    }, PorterAction))
  } catch (error) {
    ctx.logger?.warn(`memory-porter: header slot register failed: ${String(error)}`)
  }
}
