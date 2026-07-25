import { useTranslation } from 'react-i18next'

/** Dashboard 页占位（U2）；真实实现见 U3-U8。 */
export default function DashboardPage() {
  const { t } = useTranslation()
  return (
    <div className="p-6">
      <p className="text-sm text-muted-foreground">{t('admin.nav.dashboard')}</p>
    </div>
  )
}
