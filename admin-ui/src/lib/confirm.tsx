import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from '@appica/ui-react/alert-dialog'
import { Button } from '@appica/ui-react/button'

interface ConfirmContextValue {
  /** 弹出确认框，返回用户选择（确定=true / 取消=false）。对齐旧 store.confirm 语义。 */
  confirm: (message: string) => Promise<boolean>
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null)

interface Pending {
  message: string
  resolve: (ok: boolean) => void
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const [pending, setPending] = useState<Pending | null>(null)
  // 用 ref 暂存 resolve，避免 confirm 回调依赖 state。
  const resolveRef = useRef<((ok: boolean) => void) | null>(null)

  const confirm = useCallback((message: string) => {
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve
      setPending({ message, resolve })
    })
  }, [])

  // 结算当前确认框：调用暂存的 resolve 并关闭弹窗。
  const settle = useCallback((ok: boolean) => {
    resolveRef.current?.(ok)
    resolveRef.current = null
    setPending(null)
  }, [])

  const value = useMemo(() => ({ confirm }), [confirm])

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      <AlertDialog open={pending !== null} onOpenChange={(open) => { if (!open) settle(false) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('admin.confirm.confirm')}</AlertDialogTitle>
            <AlertDialogDescription>{pending?.message}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => settle(false)}>
              {t('admin.confirm.cancel')}
            </Button>
            <Button variant="primary" onClick={() => settle(true)}>
              {t('admin.confirm.confirm')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  )
}

export function useConfirm(): ConfirmContextValue {
  const ctx = useContext(ConfirmContext)
  if (!ctx) throw new Error('useConfirm must be used within ConfirmProvider')
  return ctx
}
