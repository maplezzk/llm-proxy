import { useTranslation } from 'react-i18next'
import { useApp } from '../lib/app-state'

/** 顶栏：显示当前 tab 名。 */
export default function Topbar() {
  const { t } = useTranslation()
  const { currentTab } = useApp()

  return (
    <header className="flex h-14 shrink-0 items-center border-b border-border bg-background px-6">
      <h2 className="text-lg font-semibold text-foreground">{t(`admin.nav.${currentTab}`)}</h2>
    </header>
  )
}
