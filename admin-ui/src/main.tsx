import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ThemeProvider } from '@appica/ui-react/providers/theme-provider'
import { I18nextProvider } from 'react-i18next'
import { initAdminI18n } from './i18n'
import { AppProvider } from './lib/app-state'
import { ToastProvider } from './lib/toast'
import { ConfirmProvider } from './lib/confirm'
import App from './App'
import { adminFetch, setAdminKey } from './lib/api'
import { bootstrapAdminHandoff } from './lib/admin-handoff'
import './index.css'

// 初始化 i18next（检测语言 + 内联 zh/en 资源），交给 I18nextProvider。
const i18n = initAdminI18n()

async function start(): Promise<void> {
  await bootstrapAdminHandoff({
    hash: window.location.hash,
    pathname: window.location.pathname,
    search: window.location.search,
    replaceURL: (url) => window.history.replaceState(null, '', url),
    exchange: async (code) => {
      const response = await adminFetch('/admin/auth/handoff/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      })
      const body = await response.json()
      const key = body?.data?.key
      if (!response.ok || typeof key !== 'string') throw new Error('handoff failed')
      return key
    },
    saveCredential: (credential) => { setAdminKey(credential) },
    showManualEntry: () => {
      console.warn('[auth] 管理密钥自动交接失败，回退到手动输入')
      window.location.hash = '#settings'
    },
  })
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ThemeProvider defaultTheme="system" enableSystem storageKey="theme">
        <I18nextProvider i18n={i18n}>
          <AppProvider>
            <ToastProvider>
              <ConfirmProvider>
                <App />
              </ConfirmProvider>
            </ToastProvider>
          </AppProvider>
        </I18nextProvider>
      </ThemeProvider>
    </StrictMode>,
  )
}

void start()
