import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ThemeProvider } from '@appica/ui-react/providers/theme-provider'
import { I18nextProvider } from 'react-i18next'
import { initAdminI18n } from './i18n'
import { AppProvider } from './lib/app-state'
import { ToastProvider } from './lib/toast'
import { ConfirmProvider } from './lib/confirm'
import App from './App'
import './index.css'

// 初始化 i18next（检测语言 + 内联 zh/en 资源），交给 I18nextProvider。
const i18n = initAdminI18n()

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
