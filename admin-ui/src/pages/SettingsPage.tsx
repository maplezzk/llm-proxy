import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@appica/ui-react/select'
import { Button } from '@appica/ui-react/button'
import { Input } from '@appica/ui-react/input'
import { Textarea } from '@appica/ui-react/textarea'
import { Switch } from '@appica/ui-react/switch'
import { Eye, EyeOff } from '@appica/icons-react'
import { fetchJson } from '../lib/api'
import type { ApiRes } from '../lib/api-types'
import { LABEL_CLS, extractError } from '../lib/form-helpers'
import { useToast } from '../lib/toast'
import { useConfirm } from '../lib/confirm'

/* ────────────────────────── 类型 / 常量 ────────────────────────── */

interface ProviderRef {
  name: string
  models?: Array<{ id: string; input?: string[] }>
}

interface VisionData {
  provider?: string
  model?: string
  prompt?: string
}

interface CacheStats {
  enabled: boolean
  hits: number
  misses: number
  size: number
  maxEntries: number
  hitRate: number
}

/** 与后端 src/proxy/vision.ts DEFAULT_VISION_PROMPT 保持一致。 */
const DEFAULT_VISION_PROMPT =
  '请详细描述这张图片的内容，包括其中的文字、物体、场景、颜色等关键信息。'

/** 卡片外壳（Appica 无 Card 组件，用样式 div）。 */
function Card({
  icon,
  title,
  desc,
  children,
}: {
  icon: string
  title: string
  desc?: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-lg border border-border bg-background-subtle p-4">
      <div className="mb-1 flex items-center gap-2">
        <span aria-hidden>{icon}</span>
        <h3 className="text-[14px] font-semibold text-foreground">{title}</h3>
      </div>
      {desc && <p className="mb-3 text-[12px] text-muted-foreground">{desc}</p>}
      {children}
    </div>
  )
}

/* ────────────────────────── Proxy Key 卡片 ────────────────────────── */

function ProxyKeyCard() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [key, setKey] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [showKey, setShowKey] = useState(false)

  const load = useCallback(async () => {
    const res = await fetchJson<ApiRes<{ set?: boolean }>>('/admin/proxy-key').catch(() => null)
    setHasKey(res?.data?.set ?? false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const save = async (value: string) => {
    setSaving(true)
    const res = await fetchJson<ApiRes<unknown>>('/admin/proxy-key', {
      method: 'PUT',
      body: JSON.stringify({ key: value }),
    }).catch(() => null)
    setSaving(false)
    if (res?.success) {
      setHasKey(!!value)
      toast(value ? t('admin.dashboard.proxyKeySetSuccess') : t('admin.dashboard.proxyKeyRemoveSuccess'), 'success')
      setKey('')
      void load()
    }
  }

  return (
    <Card
      icon="🔑"
      title={t('admin.dashboard.proxyKey')}
      desc={hasKey ? t('admin.dashboard.proxyKeySet') : t('admin.dashboard.proxyKeyNotSet')}
    >
      <div className="flex items-center gap-2">
        <Input
          type={showKey ? 'text' : 'password'}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={t('admin.dashboard.proxyKeyPlaceholder')}
          inputSize="sm"
          className="flex-1 font-mono"
          autoComplete="off"
        />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={showKey ? t('admin.common.hide') : t('admin.common.view')}
          onClick={() => setShowKey((s) => !s)}
        >
          {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </Button>
        <Button variant="primary" size="sm" disabled={saving} onClick={() => void save(key)}>
          {t('admin.common.save')}
        </Button>
        {hasKey && (
          <Button
            variant="ghost"
            size="sm"
            disabled={saving}
            className="text-error-emphasis hover:bg-error-soft"
            onClick={() => void save('')}
          >
            {t('admin.common.remove')}
          </Button>
        )}
      </div>
    </Card>
  )
}

/* ────────────────────────── Vision 卡片 ────────────────────────── */

function VisionCard() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const { confirm } = useConfirm()

  const [enabled, setEnabled] = useState(false)
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [prompt, setPrompt] = useState(DEFAULT_VISION_PROMPT)
  const [providers, setProviders] = useState<ProviderRef[]>([])
  const [cache, setCache] = useState<CacheStats>({
    enabled: false,
    hits: 0,
    misses: 0,
    size: 0,
    maxEntries: 0,
    hitRate: 0,
  })
  const [saving, setSaving] = useState(false)
  const [clearing, setClearing] = useState(false)

  const load = useCallback(async () => {
    const [visionRes, configRes, cacheRes] = await Promise.all([
      fetchJson<ApiRes<VisionData>>('/admin/vision').catch(() => null),
      fetchJson<ApiRes<{ providers: ProviderRef[] }>>('/admin/config').catch(() => null),
      fetchJson<ApiRes<CacheStats>>('/admin/vision-cache/stats').catch(() => null),
    ])
    if (cacheRes?.data) setCache(cacheRes.data)
    const list = configRes?.data?.providers ?? []
    setProviders(list)

    const v = visionRes?.data
    const hasVision = v && (v.provider || v.model)
    if (!hasVision) {
      setEnabled(false)
      setProvider('')
      setModel('')
      setPrompt(DEFAULT_VISION_PROMPT)
      return
    }
    setEnabled(true)
    setProvider(v?.provider ?? '')
    setModel(v?.model ?? '')
    setPrompt(v?.prompt || DEFAULT_VISION_PROMPT)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const availableModels = useMemo(
    () => providers.find((p) => p.name === provider)?.models ?? [],
    [providers, provider],
  )

  const selectedModelHasImage = useMemo(() => {
    const p = providers.find((x) => x.name === provider)
    if (!p) return false
    const m = p.models?.find((x) => x.id === model)
    return m ? Array.isArray(m.input) && m.input.includes('image') : false
  }, [providers, provider, model])

  const save = async () => {
    setSaving(true)
    const promptTrimmed = prompt.trim()
    const promptToSend = promptTrimmed === DEFAULT_VISION_PROMPT ? '' : promptTrimmed
    const payload = enabled
      ? { provider: provider.trim(), model: model.trim(), prompt: promptToSend }
      : { provider: '', model: '', prompt: '' }
    const res = await fetchJson<ApiRes<unknown>>('/admin/vision', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }).catch(() => null)
    setSaving(false)
    if (res?.success) {
      toast(enabled ? t('admin.vision.saved') : t('admin.vision.removed'), 'success')
    } else {
      toast(extractError(res, t('admin.vision.saveFailed')) || t('admin.vision.saveFailed'), 'error')
    }
  }

  const clearCache = async () => {
    if (clearing) return
    const ok = await confirm(t('admin.vision.cache.clearConfirm'))
    if (!ok) return
    setClearing(true)
    const res = await fetchJson<ApiRes<CacheStats>>('/admin/vision-cache/clear', {
      method: 'POST',
    }).catch(() => null)
    setClearing(false)
    if (res?.success) {
      if (res.data) setCache(res.data)
      toast(t('admin.vision.cache.cleared'), 'success')
    } else {
      toast(extractError(res, t('admin.vision.cache.clearFailed')) || t('admin.vision.cache.clearFailed'), 'error')
    }
  }

  const cacheStatsText = cache.enabled
    ? t('admin.vision.cache.stats', {
        hits: cache.hits,
        misses: cache.misses,
        rate: (cache.hitRate * 100).toFixed(1) + '%',
        size: cache.size,
        max: cache.maxEntries,
      })
    : t('admin.vision.cache.disabled')

  return (
    <Card icon="🖼️" title={t('admin.vision.title')} desc={t('admin.vision.desc')}>
      <div className="flex flex-col gap-3">
        {/* 启用开关 */}
        <label className="flex items-center gap-2">
          <Switch checked={enabled} onCheckedChange={(c) => setEnabled(c)} />
          <span className="text-[12.5px] text-foreground">{t('admin.vision.enable')}</span>
        </label>

        {enabled && (
          <div className="flex flex-col gap-3">
            {/* Provider */}
            <div className="flex flex-col gap-1.5">
              <label className={LABEL_CLS}>{t('admin.vision.selectProvider')}</label>
              <Select
                size="sm"
                value={provider || '__none'}
                onValueChange={(v) => {
                  setProvider(v === '__none' ? '' : String(v ?? ''))
                  setModel('')
                }}
              >
                <SelectTrigger aria-label={t('admin.vision.selectProvider')}>
                  <SelectValue placeholder={t('admin.vision.selectProvider')}>
                    {(v) => (!v || v === '__none' ? t('admin.vision.selectProvider') : String(v))}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">{t('admin.vision.selectProvider')}</SelectItem>
                  {providers.map((p) => (
                    <SelectItem key={p.name} value={p.name}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Model */}
            <div className="flex flex-col gap-1.5">
              <label className={LABEL_CLS}>{t('admin.vision.selectModel')}</label>
              <Select
                size="sm"
                value={model || '__none'}
                onValueChange={(v) => setModel(v === '__none' ? '' : String(v ?? ''))}
              >
                <SelectTrigger aria-label={t('admin.vision.selectModel')}>
                  <SelectValue placeholder={t('admin.vision.selectModel')}>
                    {(v) => (!v || v === '__none' ? t('admin.vision.selectModel') : String(v))}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">{t('admin.vision.selectModel')}</SelectItem>
                  {availableModels.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {model && !selectedModelHasImage && (
                <p className="rounded-md bg-warning-soft px-2.5 py-1.5 text-[11px] text-warning-emphasis">
                  {t('admin.vision.modelNotImageWarning')}
                </p>
              )}
              {providers.length === 0 && (
                <p className="text-[11px] text-muted-foreground">{t('admin.vision.noVisionModel')}</p>
              )}
            </div>

            {/* Prompt */}
            <div className="flex flex-col gap-1.5">
              <Textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={t('admin.vision.promptPlaceholder')}
                rows={3}
                className="text-[12px]"
              />
            </div>
          </div>
        )}

        <div>
          <Button variant="primary" size="sm" disabled={saving} onClick={() => void save()}>
            {t('admin.common.save')}
          </Button>
        </div>

        {/* 缓存 */}
        <div className="rounded-md border border-border bg-background px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span aria-hidden>💾</span>
            <span className="text-[12.5px] font-medium text-foreground">{t('admin.vision.cache.title')}</span>
            <Button
              variant="outline"
              size="sm"
              className="ms-auto"
              disabled={clearing}
              onClick={() => void clearCache()}
            >
              {t('admin.vision.cache.clear')}
            </Button>
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">{t('admin.vision.cache.desc')}</p>
          <p className="mt-1 font-mono text-[11px] text-muted-foreground">{cacheStatsText}</p>
        </div>
      </div>
    </Card>
  )
}

/* ────────────────────────── 页面 ────────────────────────── */

/**
 * Settings 页 — 移植自旧版 proxy-key.ts + vision-setting.ts：
 * - Proxy Key 卡片（设置/移除 /admin/proxy-key）
 * - Vision 卡片（启用/供应商/模型/提示词 + 缓存统计与清除）
 */
export default function SettingsPage() {
  return (
    <div className="flex max-w-220 flex-col gap-4 p-6">
      <ProxyKeyCard />
      <VisionCard />
    </div>
  )
}
