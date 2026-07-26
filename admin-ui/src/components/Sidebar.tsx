import { useTranslation } from 'react-i18next'
import { Navigation, NavigationList, NavigationItem, NavigationLink } from '@appica/ui-react/navigation'
import {
  LayoutDashboard,
  Server,
  PlugConnected,
  FileText,
  Radar,
  Settings,
} from '@appica/icons-react'
import { useApp } from '../lib/app-state'
import type { Tab } from '../lib/app-state'

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
 * 侧栏：Appica Navigation（vertical）6 个 tab + 页脚运行状态点。
 * 语言/主题/端口/重载配置已收纳到 Settings 页「通用」卡片。
 */
export default function Sidebar() {
  const { t } = useTranslation()
  const { currentTab, switchTab, status } = useApp()

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

      {/* 页脚：仅运行状态（操作项已移至 Settings 页） */}
      <div className="flex flex-col gap-2 border-t border-border px-3 py-3 text-xs text-muted-foreground">
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
      </div>
    </aside>
  )
}
