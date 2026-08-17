/**
 * 翻译函数的解析与传递。
 *
 * 宿主在 slot 注册时（`locale: NS`）会把 `t` 作为 prop 传进组件。但那是宿主的
 * API 形态，不保证稳定——所以每次调用都做防御性探测，拿不到就退回本地词典。
 * 面板可以不好看，但不能因为宿主换了个字段就变成一堆 key。
 */
import { createContext, useContext } from 'react'
import { fallbackT, type PorterKey } from './locales.ts'

export type Translate = (key: PorterKey, params?: Record<string, unknown>) => string

/** 把宿主传进来的 t（如果有）包成一个总是可用的翻译函数。 */
export function makeT(hostT: unknown): Translate {
  const host = typeof hostT === 'function'
    ? hostT as (key: string, params?: Record<string, unknown>) => string
    : undefined
  return (key, params) => {
    if (host !== undefined) {
      try {
        const value = host(key, params)
        // 宿主查不到时常见的返回是原样吐回 key，这种也算没查到。
        if (typeof value === 'string' && value !== '' && value !== key) return value
      } catch {
        // 宿主 t 形态变化时静默回退
      }
    }
    return fallbackT(key, params)
  }
}

/** 默认值就是纯本地词典——即使谁忘了套 Provider，界面也不会露出 key。 */
export const TranslateContext = createContext<Translate>(fallbackT)

export function useT(): Translate {
  return useContext(TranslateContext)
}
