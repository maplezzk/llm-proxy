import { createContext, useCallback, useContext, useMemo } from 'react'
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
      manager.add({
        title: message,
        type,
        data: { icon: TYPE_ICON[type] ?? TYPE_ICON.info },
      })
    },
    [manager],
  )

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
