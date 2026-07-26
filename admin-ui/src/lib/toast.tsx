import { createContext, useCallback, useContext, useEffect, useMemo } from 'react'
import type { ReactNode } from 'react'
import {
  ToastProvider as AppicaToastProvider,
  Toaster,
  useToastManager,
} from '@appica/ui-react/toast'
import {
  CircleCheckFilled,
  CircleXFilled,
  AlertTriangleFilled,
  InfoCircleFilled,
} from '@appica/icons-react'

export type ToastType = 'success' | 'error' | 'warning' | 'info'

interface ToastContextValue {
  toast: (message: string, type?: ToastType) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

// error/warning 去重窗口：防止轮询/SSE 重连等高频失败刷屏；success/info 不去重，保证操作反馈。
const DEDUPE_MS = 8000
const recentToasts = new Map<string, number>()

let globalToast: ((message: string, type?: ToastType) => void) | null = null

/**
 * 命令式 toast：供 ToastProvider 之外的模块（i18n、app-state 等）使用。
 * Provider 未挂载时降级为 console.warn，不静默丢弃。
 */
export function toast(message: string, type: ToastType = 'info'): void {
  if (globalToast) {
    globalToast(message, type)
  } else {
    console.warn(`[toast:${type}] ${message}`)
  }
}

// 命令式 toast(msg, type)：用带状态色图标的 Appica Toast。
const TYPE_ICON: Record<ToastType, ReactNode> = {
  success: <CircleCheckFilled className="text-success-emphasis" />,
  error: <CircleXFilled className="text-error-emphasis" />,
  warning: <AlertTriangleFilled className="text-warning-emphasis" />,
  info: <InfoCircleFilled className="text-info-emphasis" />,
}

function ToastBridge({ children }: { children: ReactNode }) {
  const manager = useToastManager<{ icon?: ReactNode }>()

  const toast = useCallback(
    (message: string, type: ToastType = 'info') => {
      if (type === 'error' || type === 'warning') {
        const key = `${type}:${message}`
        const now = Date.now()
        const last = recentToasts.get(key)
        if (last != null && now - last < DEDUPE_MS) return
        recentToasts.set(key, now)
      }
      manager.add({
        title: message,
        type,
        data: { icon: TYPE_ICON[type] ?? TYPE_ICON.info },
      })
    },
    [manager],
  )

  // 注册命令式入口，供 Provider 之外的模块使用。
  useEffect(() => {
    globalToast = toast
    return () => {
      globalToast = null
    }
  }, [toast])

  const value = useMemo(() => ({ toast }), [toast])
  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>
}

export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <AppicaToastProvider>
      <ToastBridge>{children}</ToastBridge>
      <Toaster position="bottom-right" />
    </AppicaToastProvider>
  )
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within ToastProvider')
  return ctx
}
