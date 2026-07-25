import { useTranslation } from 'react-i18next'
import { useTheme } from '@appica/ui-react/hooks/use-theme'
import { Navigation, NavigationList, NavigationItem, NavigationLink } from '@appica/ui-react/navigation'
import { Button } from '@appica/ui-react/button'
import {
  LayoutDashboard,
  Server,
  PlugConnected,
  FileText,
  Radar,
  Settings,
  Refresh,
  Globe,
  Sun,
  Moon,
} from '@appica/icons-react'
import { useApp } from '../lib/app-state'
import type { Tab } from '../lib/app-state'
import { useToast } from '../lib/toast'
import PortSetting from './PortSetting'

const TABS: Tab[] = ['dashboard', 'providers', 'adapters', 'logs', 'capture', 'settings']

const TAB_ICONS: Record<Tab, typeof LayoutDashboard> = {
  dashboard: LayoutDashboard,
  providers: Server,
  adapters: PlugConnected,
  logs: FileText,
  capture: Radar,
  settings: Settings,
}

/**
 * 侧栏：Appica Navigation（vertical）6 个 tab + 页脚
 * （运行状态点 / reload / 语言切换 / 主题切换 / 端口设置）。
 */
export default function Sidebar() {
  const { t, i18n } = useTranslation()
  const { currentTab, switchTab, status, reloadConfig, switchLang } = useApp()
  const { toast } = useToast()
  const { resolvedTheme, setTheme, mounted } = useTheme()
  const isDark = mounted && resolvedTheme === 'dark'
  const lang = i18n.language?.startsWith('zh') ? 'zh' : 'en'

  // reload 后由调用方弹 toast（AppProvider 位于 ToastProvider 之上，无法内部弹）。
  const handleReload = async () => {
    const res = await reloadConfig()
    if (res) toast(res.message, res.type)
  }

  const handleSwitchLang = () => {
    switchLang(lang === 'zh' ? 'en' : 'zh')
  }

  const handleToggleTheme = () => {
    setTheme(isDark ? 'light' : 'dark')
  }

  return (
    <aside className="flex h-screen w-56 shrink-0 flex-col border-e border-border bg-background-subtle">
      {/* 品牌头 */}
      <div className="px-4 py-4">
        <h1 className="text-base font-semibold text-foreground">llm-proxy</h1>
        <p className="mt-0.5 text-xs text-muted-foreground">Model Gateway</p>
      </div>

      {/* 导航 */}
      <Navigation
        aria-label="Main"
        orientation="vertical"
        variant="pill"
        activeLink={currentTab}
        className="flex-1 overflow-y-auto px-2"
      >
        <NavigationList>
          {TABS.map((tab) => {
            const Icon = TAB_ICONS[tab]
            return (
              <NavigationItem key={tab}>
                <NavigationLink
                  value={tab}
                  render={<button type="button" onClick={() => switchTab(tab)} />}
                  className="w-full"
                >
                  <Icon data-icon="start" />
                  {t(`admin.nav.${tab}`)}
                </NavigationLink>
              </NavigationItem>
            )
          })}
        </NavigationList>
      </Navigation>

      {/* 页脚 */}
      <div className="flex flex-col gap-2 border-t border-border px-3 py-3 text-xs text-muted-foreground">
        {/* 运行状态 */}
        <div className="flex items-center gap-2">
          <span
            className={
              'inline-block size-2 rounded-full ' +
              (status === 'running'
                ? 'bg-success'
                : status === 'offline'
                  ? 'bg-destructive'
                  : 'bg-muted-foreground')
            }
          />
          <span>
            {status === 'running'
              ? t('admin.sidebar.running')
              : status === 'offline'
                ? t('admin.sidebar.offline')
                : t('admin.sidebar.loading')}
          </span>
        </div>

        {/* 操作按钮：reload / 语言 / 主题 */}
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            title={t('admin.common.reloadConfig')}
            aria-label={t('admin.common.reloadConfig')}
            onClick={() => void handleReload()}
          >
            <Refresh />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            title={t('admin.sidebar.switchLang')}
            aria-label={t('admin.sidebar.switchLang')}
            onClick={handleSwitchLang}
          >
            <Globe />
            <span className="ms-1 text-[10px]">{lang === 'zh' ? 'EN' : '中文'}</span>
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Toggle theme"
            onClick={handleToggleTheme}
          >
            {isDark ? <Sun /> : <Moon />}
          </Button>
        </div>

        {/* 端口设置 */}
        <PortSetting />
      </div>
    </aside>
  )
}
