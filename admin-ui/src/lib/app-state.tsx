import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ReactNode } from 'react'
import i18next from 'i18next'
import { fetchJson } from './api'
import { switchLang as switchLangI18n } from '../i18n'

export type Tab = 'dashboard' | 'providers' | 'adapters' | 'logs' | 'capture' | 'settings'
export type Status = 'loading' | 'running' | 'offline'

export interface ReloadResult {
  message: string
  type: 'success' | 'error'
}

interface AppContextValue {
  config: any
  health: any
  tokenStats: any
  currentTab: Tab
  status: Status
  setCurrentTab: (tab: Tab) => void
  switchTab: (tab: Tab) => void
  switchLang: (lang: string) => void
  loadDashboard: () => Promise<void>
  reloadConfig: () => Promise<ReloadResult | null>
}

const AppContext = createContext<AppContextValue | null>(null)

export function AppProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<any>(null)
  const [health, setHealth] = useState<any>(null)
  const [tokenStats, setTokenStats] = useState<any>(null)
  const [currentTab, setCurrentTab] = useState<Tab>('dashboard')
  const [status, setStatus] = useState<Status>('loading')
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // 并发拉取 health / config / token-stats，对齐旧 store.loadDashboard。
  const loadDashboard = useCallback(async () => {
    const [h, cfg, stats] = await Promise.all([
      fetchJson<any>('/admin/health').catch(() => null),
      fetchJson<any>('/admin/config').catch(() => null),
      fetchJson<any>('/admin/token-stats').catch(() => null),
    ])
    setHealth(h)
    setConfig(cfg?.data ?? null)
    setTokenStats(stats?.data ?? null)
    setStatus(h?.success ? 'running' : 'offline')
  }, [])

  const startPolling = useCallback(() => {
    if (intervalRef.current) return
    intervalRef.current = setInterval(() => {
      void loadDashboard()
    }, 10000)
  }, [loadDashboard])

  const stopPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
  }, [])

  // 挂载即加载 + 启动 10s 轮询；卸载清理 interval。
  useEffect(() => {
    void loadDashboard()
    startPolling()
    return () => stopPolling()
  }, [loadDashboard, startPolling, stopPolling])

  // hash 路由：对齐旧 store.switchTab——同时直接更新 currentTab 并写 location.hash，
  // 规避点击当前 tab（hash 不变、不触发 hashchange）导致状态不同步的边界。
  const switchTab = useCallback((tab: Tab) => {
    setCurrentTab(tab)
    location.hash = '#' + tab
  }, [])

  const switchLang = useCallback((lang: string) => {
    void switchLangI18n(lang)
  }, [])

  // 重载配置；错误时拼接 errors[].message。
  // 返回提示描述（message/type），由调用方（位于 ToastProvider 子树内）负责弹出 toast，
  // 以保持 main.tsx 既定的 provider 嵌套顺序（AppProvider 在 ToastProvider 之上）。
  const reloadConfig = useCallback(async (): Promise<ReloadResult | null> => {
    const res = await fetchJson<any>('/admin/config/reload', { method: 'POST' }).catch(() => null)
    if (!res) {
      return { message: i18next.t('admin.common.reloadFailed'), type: 'error' }
    }
    if (res.success) {
      void loadDashboard()
      return { message: i18next.t('admin.common.configReloaded'), type: 'success' }
    }
    if (res.errors) {
      return { message: res.errors.map((e: any) => e.message).join('; '), type: 'error' }
    }
    return { message: res.error || i18next.t('admin.common.reloadFailed'), type: 'error' }
  }, [loadDashboard])

  const value = useMemo<AppContextValue>(
    () => ({
      config,
      health,
      tokenStats,
      currentTab,
      status,
      setCurrentTab,
      switchTab,
      switchLang,
      loadDashboard,
      reloadConfig,
    }),
    [config, health, tokenStats, currentTab, status, switchTab, switchLang, loadDashboard, reloadConfig],
  )

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used within AppProvider')
  return ctx
}
