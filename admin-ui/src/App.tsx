import { useEffect } from 'react'
import type { ComponentType } from 'react'
import { useApp } from './lib/app-state'
import type { Tab } from './lib/app-state'
import Sidebar from './components/Sidebar'
import Topbar from './components/Topbar'
import DashboardPage from './pages/DashboardPage'
import ProvidersPage from './pages/ProvidersPage'
import AdaptersPage from './pages/AdaptersPage'
import LogsPage from './pages/LogsPage'
import CapturePage from './pages/CapturePage'
import SettingsPage from './pages/SettingsPage'

// tab 白名单（与旧版一致）；非法 hash 回退 dashboard。
const TAB_WHITELIST: readonly Tab[] = ['dashboard', 'providers', 'adapters', 'logs', 'capture', 'settings']

function isTab(value: string): value is Tab {
  return (TAB_WHITELIST as readonly string[]).includes(value)
}

/**
 * hash 路由 hook：监听 hashchange，将合法 hash 同步到 currentTab；
 * 非法 hash 回退 dashboard。switchTab（写 location.hash）由 useApp 提供。
 */
function useHashTab(): Tab {
  const { currentTab, setCurrentTab } = useApp()

  useEffect(() => {
    const applyHash = () => {
      const raw = location.hash.replace(/^#/, '')
      setCurrentTab(isTab(raw) ? raw : 'dashboard')
    }
    applyHash()
    window.addEventListener('hashchange', applyHash)
    return () => window.removeEventListener('hashchange', applyHash)
  }, [setCurrentTab])

  return currentTab
}

// 导入全部 6 个页面：后续 U3-U8 只需替换各页面文件内容，无需再改 App.tsx。
const PAGES: Record<Tab, ComponentType> = {
  dashboard: DashboardPage,
  providers: ProvidersPage,
  adapters: AdaptersPage,
  logs: LogsPage,
  capture: CapturePage,
  settings: SettingsPage,
}

export default function App() {
  const tab = useHashTab()

  const Page = PAGES[tab]

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Topbar />
        <main className="flex-1 overflow-auto">
          <Page />
        </main>
      </div>
    </div>
  )
}
