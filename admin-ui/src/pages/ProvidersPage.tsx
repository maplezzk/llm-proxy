import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
} from '@appica/ui-react/dialog'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@appica/ui-react/select'
import { Button } from '@appica/ui-react/button'
import { Input } from '@appica/ui-react/input'
import { Checkbox } from '@appica/ui-react/checkbox'
import { Badge } from '@appica/ui-react/badge'
import { Spinner } from '@appica/ui-react/spinner'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@appica/ui-react/table'
import {
  Search,
  Pencil,
  Trash,
  Activity,
  X,
  Eye,
  EyeOff,
  Brain,
  Image,
  CloudDownload,
  Plus,
} from '@appica/icons-react'
import { useApp } from '../lib/app-state'
import { fetchJson } from '../lib/api'
import type { ApiRes, ProviderType } from '../lib/api-types'
import {
  EffortSelect,
  LABEL_CLS,
  REASONING_EFFORTS,
  THINKING_TYPES,
  TYPE_LABELS,
  extractError,
} from '../lib/form-helpers'
import { useToast } from '../lib/toast'
import { useConfirm } from '../lib/confirm'
import TestPanelDialog from '../components/TestPanelDialog'

/* ────────────────────────── 类型 ────────────────────────── */

/** config.providers[].models[] 的持久化结构（保存时写入）。 */
interface ModelConfig {
  id: string
  thinking?: { budget_tokens?: number; reasoning_effort?: string; type?: string }
  reasoning_effort?: string
  input?: string[]
}

/** status + config 合并后的表格行。 */
interface ProviderRow {
  name: string
  type: string
  available?: boolean
  api_key?: string
  api_base?: string
  models?: ModelConfig[]
}

/** 表单中的模型行（budget_tokens 以字符串承载 number input）。 */
interface ModelRow {
  id: string
  thinking: { budget_tokens?: string; type?: string }
  reasoning_effort: string
  input: string[]
}

interface FormState {
  name: string
  type: ProviderType
  apiKey: string
  apiBase: string
  models: ModelRow[]
}

interface PullModel {
  id: string
  description?: string | null
  checked: boolean
}

interface PullState {
  open: boolean
  models: PullModel[]
  existing: string[]
  loading: boolean
  error: string
}

interface TestTarget {
  open: boolean
  name: string
  providerType: string
  modelIds: string[]
}

/* ────────────────────────── 常量 / 工具 ────────────────────────── */

const emptyModelRow = (): ModelRow => ({ id: '', thinking: {}, reasoning_effort: '', input: [] })

const emptyForm = (): FormState => ({
  name: '',
  type: 'openai',
  apiKey: '',
  apiBase: '',
  models: [emptyModelRow()],
})

/* ────────────────────────── 页面 ────────────────────────── */

/**
 * Providers 页 — 移植自旧版 providers.ts：
 * - 列表（status + config 按序合并）、搜索过滤、空态/无匹配
 * - 新增/编辑弹窗（name/type/api_key/api_base/models + thinking/input 配置）
 * - pull-models 弹窗（勾选导入）、删除确认、连通性测试（复用 TestPanelDialog）
 */
export default function ProvidersPage() {
  const { t } = useTranslation()
  const { loadDashboard } = useApp()
  const { toast } = useToast()
  const { confirm } = useConfirm()

  // ──── 列表 ────
  const [providers, setProviders] = useState<ProviderRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  // ──── 新增/编辑弹窗 ────
  const [formOpen, setFormOpen] = useState(false)
  const [editingName, setEditingName] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [showKey, setShowKey] = useState(false)

  // ──── pull-models 弹窗 ────
  const [pull, setPull] = useState<PullState>({
    open: false,
    models: [],
    existing: [],
    loading: false,
    error: '',
  })
  const [pullSearch, setPullSearch] = useState('')

  // ──── 测试弹窗 ────
  const [test, setTest] = useState<TestTarget>({
    open: false,
    name: '',
    providerType: '',
    modelIds: [],
  })

  /**
   * 拉取 status（name/type/available）+ config（api_key/api_base/models），
   * 按序合并为表格行（对齐旧版 load 的 index 对齐逻辑）。
   */
  const load = useCallback(async () => {
    setLoading(true)
    const [statusRes, configRes] = await Promise.all([
      fetchJson<ApiRes<{ providers: Array<{ name: string; type: string; available?: boolean }> }>>(
        '/admin/status/providers',
      ).catch((err) => {
        console.warn('[providers] status 拉取失败', err)
        return null
      }),
      fetchJson<ApiRes<{ providers: ProviderRow[] }>>('/admin/config').catch((err) => {
        console.warn('[providers] config 拉取失败', err)
        return null
      }),
    ])
    if (!statusRes || !configRes) {
      toast(t('admin.common.requestFailed'), 'error')
    }
    const statuses = statusRes?.data?.providers ?? []
    const configs = configRes?.data?.providers ?? []
    setProviders(
      statuses.map((p, i) => ({
        name: p.name,
        type: p.type,
        available: p.available,
        api_key: configs[i]?.api_key,
        api_base: configs[i]?.api_base,
        models: configs[i]?.models ?? [],
      })),
    )
    setLoading(false)
  }, [t, toast])

  useEffect(() => {
    void load()
  }, [load])

  /** 增/改/删成功后：刷新本页列表 + 同步共享 config（供 adapters / dashboard）。 */
  const afterMutate = useCallback(() => {
    void loadDashboard()
    void load()
  }, [loadDashboard, load])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q ? providers.filter((p) => p.name.toLowerCase().includes(q)) : providers
  }, [providers, search])

  /* ──── 新增/编辑 ──── */

  const openForm = (name: string | null) => {
    setShowKey(false)
    setEditingName(name)
    let next: FormState = emptyForm()
    if (name) {
      const p = providers.find((x) => x.name === name)
      if (p) {
        next = {
          name: p.name,
          type: (p.type as ProviderType) || 'openai',
          apiKey: p.api_key || '',
          apiBase: p.api_base || '',
          models:
            (p.models || []).map((m) => ({
              id: m.id,
              thinking: {
                budget_tokens: m.thinking?.budget_tokens != null ? String(m.thinking.budget_tokens) : '',
                type: m.thinking?.type ?? '',
              },
              // reasoning_effort 持久化在 thinking 内（anthropic/openai 均然），顶层为旧格式兜底
              reasoning_effort: m.reasoning_effort ?? m.thinking?.reasoning_effort ?? '',
              input: Array.isArray(m.input) ? [...m.input] : [],
            })),
        }
      }
    }
    if (next.models.length === 0) next.models = [emptyModelRow()]
    setForm(next)
    setFormOpen(true)
  }

  const closeForm = () => setFormOpen(false)

  const updateModel = (index: number, patch: Partial<ModelRow>) => {
    setForm((f) => ({
      ...f,
      models: f.models.map((m, i) => (i === index ? { ...m, ...patch } : m)),
    }))
  }

  const updateModelThinking = (index: number, patch: Partial<ModelRow['thinking']>) => {
    setForm((f) => ({
      ...f,
      models: f.models.map((m, i) =>
        i === index ? { ...m, thinking: { ...m.thinking, ...patch } } : m,
      ),
    }))
  }

  const addModelRow = () => {
    setForm((f) => ({ ...f, models: [...f.models, emptyModelRow()] }))
  }

  const removeModelRow = (index: number) => {
    setForm((f) => ({ ...f, models: f.models.filter((_, i) => i !== index) }))
  }

  /** 勾选/取消输入模态；text 至少保留一项（对齐旧版 toggleModality）。 */
  const toggleModality = (index: number, modality: string, checked: boolean) => {
    setForm((f) => ({
      ...f,
      models: f.models.map((m, i) => {
        if (i !== index) return m
        let input = Array.isArray(m.input) ? [...m.input] : []
        const has = input.includes(modality)
        if (checked && !has) input.push(modality)
        if (!checked && has) input = input.filter((x) => x !== modality)
        if (!input.includes('text')) input.unshift('text')
        return { ...m, input }
      }),
    }))
  }

  /** 保存：校验 → 组装 validModels → PUT/POST → toast + 刷新（对齐旧版 save）。 */
  const save = async () => {
    const { name, type, apiKey, apiBase, models } = form
    const validModels = models
      .filter((m) => m.id.trim())
      .map((m) => {
        const base: Record<string, unknown> = { id: m.id.trim() }
        if (type === 'anthropic') {
          const bt = parseInt(m.thinking.budget_tokens ?? '', 10)
          if (bt > 0) base.thinking = { budget_tokens: bt }
          if (m.reasoning_effort && (REASONING_EFFORTS as readonly string[]).includes(m.reasoning_effort)) {
            base.thinking = { ...(base.thinking as object), reasoning_effort: m.reasoning_effort }
          }
        } else if (m.reasoning_effort && (REASONING_EFFORTS as readonly string[]).includes(m.reasoning_effort)) {
          base.thinking = { reasoning_effort: m.reasoning_effort }
        }
        if (m.thinking.type && (THINKING_TYPES as readonly string[]).includes(m.thinking.type)) {
          base.thinking = { ...(base.thinking as object), type: m.thinking.type }
        }
        const inputArr = (Array.isArray(m.input) ? m.input : []).filter((x) =>
          ['text', 'image'].includes(x),
        )
        if (inputArr.length > 0) base.input = inputArr
        return base
      })

    if (!name) {
      toast(t('admin.providers.validationName'), 'error')
      return
    }
    if (validModels.length === 0) {
      toast(t('admin.providers.validationModels'), 'error')
      return
    }
    if (!editingName && !apiKey) {
      toast(t('admin.providers.validationApiKey'), 'error')
      return
    }

    const body = {
      name,
      type,
      api_key: apiKey,
      api_base: apiBase || undefined,
      models: validModels,
    }
    const res = editingName
      ? await fetchJson<ApiRes<unknown>>(`/admin/providers/${editingName}`, {
          method: 'PUT',
          body: JSON.stringify(body),
        }).catch((err) => {
          console.warn('[providers] 保存失败', err)
          return null
        })
      : await fetchJson<ApiRes<unknown>>('/admin/providers', {
          method: 'POST',
          body: JSON.stringify(body),
        }).catch((err) => {
          console.warn('[providers] 保存失败', err)
          return null
        })

    if (!res?.success) {
      toast(extractError(res, t('admin.providers.saveFailed')) || t('admin.providers.saveFailed'), 'error')
      return
    }
    toast(editingName ? t('admin.providers.updated') : t('admin.providers.created'), 'success')
    setFormOpen(false)
    afterMutate()
  }

  /* ──── 删除 ──── */

  const confirmDelete = async (name: string) => {
    const ok = await confirm(t('admin.providers.deleteConfirm', { name }))
    if (!ok) return
    const res = await fetchJson<ApiRes<unknown>>(`/admin/providers/${name}`, {
      method: 'DELETE',
    }).catch((err) => {
      console.warn('[providers] 删除失败', err)
      return null
    })
    if (!res?.success) {
      toast(extractError(res, t('admin.providers.deleteFailed')) || t('admin.providers.deleteFailed'), 'error')
      return
    }
    toast(t('admin.providers.deleted'), 'success')
    afterMutate()
  }

  /* ──── pull-models ──── */

  const openPullModels = async () => {
    const { name, type, apiKey, apiBase } = form
    const effectiveName = name || editingName
    if (!effectiveName) {
      toast(t('admin.providers.validationProviderName'), 'error')
      return
    }
    if (!apiKey && !editingName) {
      toast(t('admin.providers.validationApiKey'), 'error')
      return
    }
    setPull({ open: true, models: [], existing: [], loading: true, error: '' })
    setPullSearch('')

    const body: Record<string, unknown> = { type }
    if (apiKey) body.api_key = apiKey
    if (apiBase) body.api_base = apiBase

    const res = await fetchJson<ApiRes<{ models: Array<{ id: string; description?: string | null }>; existing?: string[] }>>(
      `/admin/providers/${effectiveName}/pull-models`,
      { method: 'POST', body: JSON.stringify(body) },
    ).catch((err) => {
      console.warn('[providers] 拉取远程模型失败', err)
      return null
    })

    if (!res?.success) {
      const detail = extractError(res, t('admin.providers.pullModelsError')) || t('admin.providers.pullModelsError')
      setPull({ open: true, models: [], existing: [], loading: false, error: detail })
      return
    }
    const existing = res.data?.existing ?? []
    const models = (res.data?.models ?? []).map((m) => ({
      id: m.id,
      description: m.description,
      checked: !existing.includes(m.id),
    }))
    setPull({ open: true, models, existing, loading: false, error: '' })
  }

  const importPullModels = () => {
    const existingIds = new Set(form.models.map((m) => m.id))
    const selected = pull.models.filter((m) => m.checked)
    const addedRows: ModelRow[] = []
    for (const m of selected) {
      if (!existingIds.has(m.id)) {
        addedRows.push({ id: m.id, thinking: {}, reasoning_effort: '', input: [] })
        existingIds.add(m.id)
      }
    }
    const added = addedRows.length
    const total = selected.length
    const msg =
      total > added
        ? `${t('admin.providers.importedModels', { added })}${t('admin.providers.importedModelsSkip', { skipped: total - added })}`
        : t('admin.providers.importedModels', { added })
    toast(msg, 'success')
    setForm((f) => ({ ...f, models: [...f.models, ...addedRows] }))
    setPull((p) => ({ ...p, open: false }))
  }

  /* ──── pull-models 搜索 + 批量选择 ──── */

  /** 按搜索词过滤后的模型（搜索 ID 或描述）。 */
  const filteredPullModels = useMemo(() => {
    const q = pullSearch.trim().toLowerCase()
    if (!q) return pull.models
    return pull.models.filter(
      (m) => m.id.toLowerCase().includes(q) || (m.description ?? '').toLowerCase().includes(q),
    )
  }, [pull.models, pullSearch])

  /** 对过滤结果中可勾选（非已存在）的模型批量设置 checked。 */
  const setFilteredChecked = (mode: 'all' | 'invert' | 'clear') => {
    const ids = new Set(filteredPullModels.filter((m) => !pull.existing.includes(m.id)).map((m) => m.id))
    if (ids.size === 0) return
    setPull((p) => ({
      ...p,
      models: p.models.map((m) =>
        ids.has(m.id)
          ? { ...m, checked: mode === 'all' ? true : mode === 'clear' ? false : !m.checked }
          : m,
      ),
    }))
  }

  const pullSelectedCount = pull.models.filter((m) => m.checked && !pull.existing.includes(m.id)).length

  /* ──── 测试 ──── */

  const openTestPanel = (name: string) => {
    const p = providers.find((x) => x.name === name)
    if (!p) {
      toast(t('admin.providers.notFound'), 'error')
      return
    }
    setTest({
      open: true,
      name: p.name,
      providerType: p.type || '',
      modelIds: (p.models ?? []).map((m) => m.id),
    })
  }

  /* ──── 渲染 ──── */

  const isAnthropic = form.type === 'anthropic'

  return (
    <div className="flex flex-col gap-4 p-6">
      {/* 工具条：搜索 + 添加 */}
      <div className="flex items-center justify-between gap-3">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('admin.providers.searchPlaceholder')}
          inputSize="sm"
          aria-label={t('admin.providers.searchPlaceholder')}
          startSlot={<Search className="size-3.5 text-muted-foreground" />}
          className="w-64"
        />
        <Button variant="primary" size="sm" onClick={() => openForm(null)}>
          {t('admin.providers.add')}
        </Button>
      </div>

      {/* 列表 */}
      <Table size="sm" hoverableRows>
        <TableHeader>
          <TableRow>
            <TableHead>{t('admin.providers.name')}</TableHead>
            <TableHead>{t('admin.providers.type')}</TableHead>
            <TableHead>{t('admin.providers.modelCount')}</TableHead>
            <TableHead>{t('admin.providers.status')}</TableHead>
            <TableHead className="text-end">{t('admin.providers.actions')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.map((p) => {
            const models = p.models ?? []
            const thinkingModels = models.filter(
              (m) => m.thinking?.budget_tokens || m.thinking?.type || m.reasoning_effort || m.thinking?.reasoning_effort,
            )
            const visionModels = models.filter((m) => Array.isArray(m.input) && m.input.includes('image'))
            const thinkingTitle = thinkingModels
              .map((m) => {
                const detail = m.thinking?.budget_tokens
                  ? `thinking:${m.thinking.budget_tokens}`
                  : m.thinking?.type
                    ? `type:${m.thinking.type}`
                    : `re:${m.reasoning_effort || m.thinking?.reasoning_effort}`
                return `${m.id} → ${detail}`
              })
              .join('\n')
            const visionTitle = `${t('admin.providers.visionBadgeTitle')}\n${visionModels.map((m) => m.id).join('\n')}`
            return (
              <TableRow key={p.name}>
                <TableCell className="font-semibold text-foreground">{p.name}</TableCell>
                <TableCell className="font-mono text-[11.5px] text-muted-foreground">
                  {p.type === 'openai-responses' ? 'openai (responses)' : p.type}
                </TableCell>
                <TableCell>
                  <span className="font-mono text-[12px] text-foreground">{models.length}</span>
                  {thinkingModels.length > 0 && (
                    <span title={thinkingTitle} className="cursor-help">
                      <Brain className="ms-1.5 inline size-3.5 align-[-2px] text-primary-strong" aria-label="thinking" />
                    </span>
                  )}
                  {visionModels.length > 0 && (
                    <span title={visionTitle} className="cursor-help">
                      <Image className="ms-1 inline size-3.5 align-[-2px] text-info-emphasis" aria-label="vision" />
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant={p.available ? 'success' : 'error'} size="sm">
                    {p.available ? t('admin.common.normal') : t('admin.common.error')}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-1.5">
                    <Button
                      variant="soft"
                      size="sm"
                      className="bg-info-soft text-info-emphasis"
                      onClick={() => openTestPanel(p.name)}
                    >
                      <Activity data-icon="start" className="size-3.5" />
                      {t('admin.common.test')}
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => openForm(p.name)}>
                      <Pencil data-icon="start" className="size-3.5" />
                      {t('admin.common.edit')}
                    </Button>
                    <Button
                      variant="soft"
                      size="sm"
                      className="bg-error-soft text-error-emphasis"
                      onClick={() => void confirmDelete(p.name)}
                    >
                      <Trash data-icon="start" className="size-3.5" />
                      {t('admin.common.delete')}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            )
          })}

          {loading && providers.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="py-12 text-center">
                <Spinner className="text-xl" />
              </TableCell>
            </TableRow>
          )}
          {!loading && filtered.length === 0 && providers.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="py-12 text-center text-[13px] text-muted-foreground">
                {t('admin.providers.empty')}
              </TableCell>
            </TableRow>
          )}
          {!loading && filtered.length === 0 && providers.length > 0 && (
            <TableRow>
              <TableCell colSpan={5} className="py-12 text-center text-[13px] text-muted-foreground">
                {t('admin.providers.noMatch')}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      {/* 新增/编辑弹窗 */}
      <Dialog open={formOpen} onOpenChange={(o) => !o && closeForm()}>
        <DialogContent className="sm:w-170">
          <DialogHeader>
            <DialogTitle>
              {editingName ? t('admin.providers.editTitle') : t('admin.providers.addTitle')}
            </DialogTitle>
          </DialogHeader>
          <DialogBody>
            <div className="max-h-[58vh] space-y-4 overflow-y-auto pe-1">
              {/* 名称 */}
              <div className="flex flex-col gap-1.5">
                <label className={LABEL_CLS} htmlFor="provider-name">
                  {t('admin.providers.formName')}
                </label>
                <Input
                  id="provider-name"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder={t('admin.providers.formNamePlaceholder')}
                  inputSize="sm"
                />
              </div>

              {/* 类型 */}
              <div className="flex flex-col gap-1.5">
                <label className={LABEL_CLS}>{t('admin.providers.formType')}</label>
                <Select
                  size="sm"
                  value={form.type}
                  onValueChange={(v) => setForm((f) => ({ ...f, type: (String(v ?? 'openai') as ProviderType) }))}
                >
                  <SelectTrigger aria-label={t('admin.providers.formType')}>
                    <SelectValue>
                      {(v) => TYPE_LABELS[String(v ?? 'openai') as ProviderType] ?? String(v)}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="openai">OpenAI (Chat)</SelectItem>
                    <SelectItem value="openai-responses">OpenAI (Responses)</SelectItem>
                    <SelectItem value="anthropic">Anthropic</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* API Key */}
              <div className="flex flex-col gap-1.5">
                <label className={LABEL_CLS} htmlFor="provider-api-key">
                  {t('admin.providers.formApiKey')}
                </label>
                <div className="flex items-center gap-1.5">
                  <Input
                    id="provider-api-key"
                    type={showKey ? 'text' : 'password'}
                    value={form.apiKey}
                    onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
                    placeholder={t('admin.providers.formApiKeyPlaceholder')}
                    inputSize="sm"
                    className="flex-1 font-mono"
                    autoComplete="off"
                  />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={showKey ? t('admin.common.hide') : t('admin.common.view')}
                    title={showKey ? t('admin.common.hide') : t('admin.common.view')}
                    onClick={() => setShowKey((s) => !s)}
                  >
                    {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </Button>
                </div>
                {editingName && (
                  <p className="text-[11px] text-muted-foreground">{t('admin.providers.keepOriginal')}</p>
                )}
              </div>

              {/* API Base */}
              <div className="flex flex-col gap-1.5">
                <label className={LABEL_CLS} htmlFor="provider-api-base">
                  {t('admin.providers.formApiBase')}
                </label>
                <Input
                  id="provider-api-base"
                  value={form.apiBase}
                  onChange={(e) => setForm((f) => ({ ...f, apiBase: e.target.value }))}
                  placeholder={t('admin.providers.formApiBasePlaceholder')}
                  inputSize="sm"
                  className="font-mono"
                />
              </div>

              {/* 模型列表 */}
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className={LABEL_CLS}>{t('admin.providers.formModels')}</span>
                  <Button variant="soft" size="sm" onClick={() => void openPullModels()}>
                    <CloudDownload data-icon="start" className="size-3.5" />
                    {t('admin.providers.pullModels')}
                  </Button>
                </div>

                <div className="flex flex-col gap-2.5">
                  {form.models.map((m, i) => (
                    <div
                      key={i}
                      className="rounded-md border border-border bg-background-subtle p-3 transition-colors duration-150 hover:border-border-strong"
                    >
                      {/* 模型 ID + 删除 */}
                      <div className="flex items-center gap-2">
                        <span className="w-14 shrink-0 text-[11px] text-muted-foreground">
                          {t('admin.providers.formModelId')}
                        </span>
                        <Input
                          value={m.id}
                          onChange={(e) => updateModel(i, { id: e.target.value })}
                          placeholder={t('admin.providers.formModelIdPlaceholder')}
                          inputSize="sm"
                          aria-label={t('admin.providers.formModelId')}
                          className="flex-1 font-mono"
                        />
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('admin.common.delete')}
                          onClick={() => removeModelRow(i)}
                          className="text-muted-foreground hover:text-error-emphasis"
                        >
                          <X className="size-4" />
                        </Button>
                      </div>

                      {/* thinking / 模态配置 */}
                      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
                        {isAnthropic && (
                          <label className="flex items-center gap-1.5">
                            <span className="text-[10.5px] font-medium whitespace-nowrap text-primary-strong">
                              {t('admin.providers.thinkingBudget')}
                            </span>
                            <Input
                              type="number"
                              min={0}
                              step={1024}
                              value={m.thinking.budget_tokens ?? ''}
                              onChange={(e) => updateModelThinking(i, { budget_tokens: e.target.value })}
                              inputSize="sm"
                              aria-label={t('admin.providers.thinkingBudget')}
                              className="w-24 font-mono text-[11px]"
                            />
                          </label>
                        )}

                        <label className="flex items-center gap-1.5">
                          <span className="text-[10.5px] font-medium whitespace-nowrap text-primary-strong">
                            {t('admin.providers.reasoningEffort')}
                          </span>
                          <EffortSelect
                            value={m.reasoning_effort}
                            onChange={(v) => updateModel(i, { reasoning_effort: v })}
                          />
                        </label>

                        <label className="flex items-center gap-1.5">
                          <span className="text-[10.5px] font-medium whitespace-nowrap text-primary-strong">
                            {t('admin.providers.thinkingType')}
                          </span>
                          <Select
                            size="sm"
                            value={m.thinking.type || 'none'}
                            onValueChange={(v) =>
                              updateModelThinking(i, { type: v === 'none' ? '' : String(v ?? '') })
                            }
                          >
                            <SelectTrigger className="w-26" aria-label={t('admin.providers.thinkingType')}>
                              <SelectValue>
                                {(v) => (!v || v === 'none' ? t('admin.providers.defaultType') : String(v))}
                              </SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">{t('admin.providers.defaultType')}</SelectItem>
                              {THINKING_TYPES.map((tt) => (
                                <SelectItem key={tt} value={tt}>
                                  {tt}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </label>

                        <div
                          className="flex items-center gap-2.5"
                          title={t('admin.providers.inputModalitiesHint')}
                        >
                          <span className="text-[10.5px] font-medium whitespace-nowrap text-primary-strong">
                            {t('admin.providers.inputModalities')}
                          </span>
                          <label className="flex cursor-pointer items-center gap-1 text-[11px] select-none">
                            <Checkbox
                              checked={m.input.includes('text')}
                              onCheckedChange={(c) => toggleModality(i, 'text', c)}
                            />
                            T
                          </label>
                          <label className="flex cursor-pointer items-center gap-1 text-[11px] select-none">
                            <Checkbox
                              checked={m.input.includes('image')}
                              onCheckedChange={(c) => toggleModality(i, 'image', c)}
                            />
                            <Image className="size-3.5" aria-hidden />
                          </label>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                <Button variant="ghost" size="sm" onClick={addModelRow} className="self-start">
                  <Plus data-icon="start" className="size-3.5" />
                  {t('admin.providers.addModel')}
                </Button>
              </div>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={closeForm}>
              {t('admin.common.cancel')}
            </Button>
            <Button variant="primary" onClick={() => void save()}>
              {t('admin.common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* pull-models 弹窗 */}
      <Dialog open={pull.open} onOpenChange={(o) => !o && setPull((p) => ({ ...p, open: false }))}>
        <DialogContent className="sm:w-150">
          <DialogHeader>
            <DialogTitle>{t('admin.providers.pullModelsTitle')}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <p className="mb-3 text-[12px] text-muted-foreground">
              {pull.loading
                ? t('admin.providers.pullModelsLoading')
                : t('admin.providers.pullModelsCount', {
                    count: pull.models.length,
                    existing: pull.existing.length,
                  })}
            </p>

            {!pull.loading && pull.models.length === 0 && (
              <div className="rounded-md border border-border bg-background-subtle py-10 text-center text-[13px] whitespace-pre-line text-muted-foreground">
                {pull.error || t('admin.providers.pullModelsNone')}
              </div>
            )}

            {!pull.loading && pull.models.length > 0 && (
              <>
                {/* 搜索 + 批量选择工具栏 */}
                <div className="mb-2 flex items-center gap-2">
                  <div className="relative flex-1">
                    <Search className="pointer-events-none absolute start-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={pullSearch}
                      onChange={(e) => setPullSearch(e.target.value)}
                      placeholder={t('admin.providers.pullModelsSearch')}
                      className="h-8 ps-7 text-[12px]"
                    />
                  </div>
                  <Button variant="outline" size="sm" onClick={() => setFilteredChecked('all')}>
                    {t('admin.providers.pullModelsSelectAll')}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setFilteredChecked('invert')}>
                    {t('admin.providers.pullModelsInvert')}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setFilteredChecked('clear')}>
                    {t('admin.providers.pullModelsClear')}
                  </Button>
                </div>
                <div className="max-h-[48vh] overflow-y-auto pe-1">
                  <Table size="sm">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10" />
                        <TableHead>{t('admin.providers.formModelId')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredPullModels.map((m) => (
                        <TableRow key={m.id}>
                          <TableCell>
                            <Checkbox
                              checked={m.checked}
                              disabled={pull.existing.includes(m.id)}
                              aria-label={m.id}
                              onCheckedChange={(c) =>
                                setPull((p) => ({
                                  ...p,
                                  models: p.models.map((x) => (x.id === m.id ? { ...x, checked: c } : x)),
                                }))
                              }
                            />
                          </TableCell>
                          <TableCell>
                            <span className="font-mono text-[12px] text-foreground">{m.id}</span>
                            {m.description && (
                              <span className="ms-2 text-[11px] text-muted-foreground">{m.description}</span>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPull((p) => ({ ...p, open: false }))}>
              {t('admin.common.cancel')}
            </Button>
            <Button variant="primary" disabled={pull.loading || pullSelectedCount === 0} onClick={importPullModels}>
              {t('admin.providers.pullModelsImport')}（{pullSelectedCount}）
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 连通性测试弹窗（providers → /admin/test-model） */}
      <TestPanelDialog
        open={test.open}
        onClose={() => setTest((prev) => ({ ...prev, open: false }))}
        name={test.name}
        typeLabel={test.providerType}
        modelIds={test.modelIds}
        buildBody={(modelId) => ({
          providerName: test.name,
          model: modelId,
          type: test.providerType,
        })}
      />
    </div>
  )
}
