import { useTranslation } from 'react-i18next'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@appica/ui-react/select'
import type { ApiRes, ProviderType } from './api-types'

export const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export const THINKING_TYPES = ['adaptive', 'auto', 'enabled', 'disabled'] as const

/** type 下拉显示名（与旧版 <option> 文案一致，非 i18n key）。 */
export const TYPE_LABELS: Record<ProviderType, string> = {
  openai: 'OpenAI (Chat)',
  'openai-responses': 'OpenAI (Responses)',
  anthropic: 'Anthropic',
}

/** 表单标签的统一样式。 */
export const LABEL_CLS = 'text-[11.5px] font-medium text-muted-foreground'

/** 从后端响应提取人类可读错误。 */
export function extractError(
  res: ApiRes<unknown> | null | undefined,
  fallback: string,
): string | null {
  if (!res) return null
  if (typeof res.error === 'object' && res.error !== null) {
    const msg = (res.error as { message?: unknown }).message
    return typeof msg === 'string' && msg ? msg : fallback
  }
  if (typeof res.error === 'string' && res.error) {
    if (Array.isArray(res.errors) && res.errors.length > 0) {
      const lines = res.errors.map((error) => {
        const field = error.field || ''
        const message = error.message || ''
        return field ? `• ${field}: ${message}` : `• ${message}`
      })
      return res.error + '\n' + lines.join('\n')
    }
    return res.error
  }
  if (Array.isArray(res.errors) && res.errors.length > 0) {
    return res.errors.map((error) => `• ${error.field || ''}: ${error.message || ''}`).join('\n')
  }
  return null
}

/** reasoning_effort 下拉（'' ↔ sentinel 'default' 互转，避免空值 Select）。 */
export function EffortSelect({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  const { t } = useTranslation()
  return (
    <Select
      size="sm"
      value={value || 'default'}
      onValueChange={(selectedValue) =>
        onChange(selectedValue === 'default' ? '' : String(selectedValue ?? ''))
      }
    >
      <SelectTrigger className="w-24" aria-label={t('admin.providers.reasoningEffort')}>
        <SelectValue>
          {(selectedValue) =>
            !selectedValue || selectedValue === 'default'
              ? t('admin.providers.defaultEffort')
              : t(`admin.providers.${selectedValue}Effort`)
          }
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="default">{t('admin.providers.defaultEffort')}</SelectItem>
        {REASONING_EFFORTS.map((effort) => (
          <SelectItem key={effort} value={effort}>
            {t(`admin.providers.${effort}Effort`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
