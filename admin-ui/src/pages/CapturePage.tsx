import { useTranslation } from 'react-i18next'

/** Capture 页占位（U2）；真实实现见 U3-U8。 */
export default function CapturePage() {
  const { t } = useTranslation()
  return (
    <div className="p-6">
      <p className="text-sm text-muted-foreground">{t('admin.nav.capture')}</p>
    </div>
  )
}
