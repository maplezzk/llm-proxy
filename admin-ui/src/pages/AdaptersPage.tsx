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
  Plus,
  Brain,
  CloudDownload,
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

/** config.providers[]（共享 config 中的供应商，供映射下拉联动）。 */
interface ProviderRef {
  name: string
  models?: Array<{ id: string; thinking?: unknown; reasoning_effort?: string }>
}

/** GET /api/admin/adapters 返回的映射项（含后端校验出的 status）。 */
interface AdapterMapping {
  sourceModelId: string
  provider: string
  targetModelId: string
  status?: string // 'ok' | 'provider_not_found' | 'model_not_found'
  thinking?: { budget_tokens?: number; reasoning_effort?: string; type?: string }
}

interface AdapterRow {
  name: string
  type: ProviderType
  max_tokens?: number
  stream?: boolean
  baseUrl?: string
  models?: AdapterMapping[]
}

/** 表单中的映射行（budget_tokens 以字符串承载 number input）。 */
interface MappingRow {
  sourceModelId: string
  provider: string
  targetModelId: string
  thinking: { budget_tokens?: string; type?: string }
  reasoning_effort: string
}

interface FormState {
  name: string
  type: ProviderType
  maxTokens: string
  stream: string // '' | 'true' | 'false'
  models: MappingRow[]
}

interface TestTarget {
  open: boolean
  name: string
  modelIds: string[]
}

/* ────────────────────────── 常量 / 工具 ────────────────────────── */

const emptyMappingRow = (): MappingRow => ({
  sourceModelId: '',
  provider: '',
  targetModelId: '',
  thinking: {},
  reasoning_effort: '',
})

const emptyForm = (): FormState => ({
  name: '',
  type: 'openai',
  maxTokens: '',
  stream: '',
  models: [emptyMappingRow()],
})

/* ────────────────────────── 页面 ────────────────────────── */

/**
 * Adapters 页 — 移植自旧版 adapters.ts：
 * - 列表（baseUrl / 模型映射 / 状态）、搜索过滤、空态/无匹配
 * - 新增/编辑弹窗（name/type/请求默认 max_tokens+stream / 模型映射表）
 * - 批量从供应商导入、删除确认、连通性测试（复用 TestPanelDialog → /api/admin/test-adapter）
 */
export default function AdaptersPage() {
  const { t } = useTranslation()
  const { config, loadDashboard } = useApp()
  const { toast } = useToast()
  const { confirm } = useConfirm()

  // ──── 列表 ────
  const [adapters, setAdapters] = useState<AdapterRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  // ──── 新增/编辑弹窗 ────
  const [formOpen, setFormOpen] = useState(false)
  const [editingName, setEditingName] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [bulkImportProvider, setBulkImportProvider] = useState('')

  // ──── 测试弹窗 ────
  const [test, setTest] = useState<TestTarget>({ open: false, name: '', modelIds: [] })

  /** 共享 config 中的供应商列表（映射下拉联动来源）。 */
  const providers = useMemo<ProviderRef[]>(() => config?.providers ?? [], [config])

  const getProviderModels = useCallback(
    (providerName: string) => providers.find((p) => p.name === providerName)?.models ?? [],
    [providers],
  )

  const load = useCallback(async () => {
    setLoading(true)
    const res = await fetchJson<ApiRes<{ adapters: AdapterRow[] }>>('/api/admin/adapters').catch(
      (err) => {
        console.warn('[adapters] 列表加载失败', err)
        toast(t('admin.common.requestFailed'), 'error')
        return null
      },
    )
    setAdapters(res?.data?.adapters ?? [])
    setLoading(false)
  }, [t, toast])

  useEffect(() => {
    void load()
  }, [load])

  /** 增/改/删成功后：刷新本页列表 + 同步共享 config（供其它页）。 */
  const afterMutate = useCallback(() => {
    void loadDashboard()
    void load()
  }, [loadDashboard, load])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q ? adapters.filter((a) => a.name.toLowerCase().includes(q)) : adapters
  }, [adapters, search])

  /* ──── 新增/编辑 ──── */

  const openForm = (name: string | null) => {
    setEditingName(name)
    setBulkImportProvider('')
    let next: FormState = emptyForm()
    if (name) {
      const a = adapters.find((x) => x.name === name)
      if (a) {
        next = {
          name: a.name,
          type: (a.type as ProviderType) || 'openai',
          maxTokens: a.max_tokens != null ? String(a.max_tokens) : '',
          stream: a.stream === true ? 'true' : a.stream === false ? 'false' : '',
          models: (a.models || []).map((m) => ({
            sourceModelId: m.sourceModelId,
            provider: m.provider,
            targetModelId: m.targetModelId,
            thinking: {
              budget_tokens: m.thinking?.budget_tokens != null ? String(m.thinking.budget_tokens) : '',
              type: m.thinking?.type ?? '',
            },
            reasoning_effort: m.thinking?.reasoning_effort ?? '',
          })),
        }
      }
    }
    if (next.models.length === 0) next.models = [emptyMappingRow()]
    setForm(next)
    setFormOpen(true)
  }

  const closeForm = () => setFormOpen(false)

  const updateMapping = (index: number, patch: Partial<MappingRow>) => {
    setForm((f) => ({
      ...f,
      models: f.models.map((m, i) => (i === index ? { ...m, ...patch } : m)),
    }))
  }

  const updateMappingThinking = (index: number, patch: Partial<MappingRow['thinking']>) => {
    setForm((f) => ({
      ...f,
      models: f.models.map((m, i) =>
        i === index ? { ...m, thinking: { ...m.thinking, ...patch } } : m,
      ),
    }))
  }

  /** 切换 provider 后清空已选目标模型（对齐旧版 onProviderChange）。 */
  const onProviderChange = (index: number, provider: string) => {
    updateMapping(index, { provider, targetModelId: '' })
  }

  const addMappingRow = () => {
    setForm((f) => ({ ...f, models: [...f.models, emptyMappingRow()] }))
  }

  const removeMappingRow = (index: number) => {
    setForm((f) => ({ ...f, models: f.models.filter((_, i) => i !== index) }))
  }

  /** 一键导入选定供应商全部模型为映射行（去重，对齐旧版 bulkImportAllModels）。 */
  const bulkImportAllModels = () => {
    if (!bulkImportProvider) {
      toast(t('admin.adapters.selectProviderFirst'), 'error')
      return
    }
    const provider = providers.find((p) => p.name === bulkImportProvider)
    if (!provider?.models?.length) {
      toast(t('admin.adapters.noModelsInProvider', { provider: bulkImportProvider }), 'error')
      return
    }
    const existingSourceIds = new Set(form.models.map((m) => m.sourceModelId).filter(Boolean))
    const addedRows: MappingRow[] = []
    for (const model of provider.models) {
      if (!existingSourceIds.has(model.id)) {
        addedRows.push({
          sourceModelId: model.id,
          provider: bulkImportProvider,
          targetModelId: model.id,
          thinking: {},
          reasoning_effort: '',
        })
        existingSourceIds.add(model.id)
      }
    }
    const added = addedRows.length
    const skipped = provider.models.length - added
    const msg =
      skipped > 0
        ? `${t('admin.adapters.importedModels', { added })}${t('admin.adapters.importedModelsSkip', { skipped })}`
        : t('admin.adapters.importedModels', { added })
    toast(msg, 'success')
    setForm((f) => ({ ...f, models: [...f.models, ...addedRows] }))
    setBulkImportProvider('')
  }

  /** 保存：校验 → 组装 validModels → PUT/POST → toast + 刷新（对齐旧版 save）。 */
  const save = async () => {
    const { name, type, models } = form
    const validModels = models
      .filter((m) => m.sourceModelId.trim() && m.provider && m.targetModelId)
      .map((m) => {
        const base: Record<string, unknown> = {
          sourceModelId: m.sourceModelId.trim(),
          provider: m.provider,
          targetModelId: m.targetModelId,
        }
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
        return base
      })

    if (!name || validModels.length === 0) {
      toast(t('admin.common.validationName'), 'error')
      return
    }

    const streamDefault = form.stream === 'true' ? true : form.stream === 'false' ? false : undefined
    const body = {
      name,
      type,
      max_tokens: parseInt(form.maxTokens, 10) || undefined,
      stream: streamDefault,
      models: validModels,
    }
    const res = editingName
      ? await fetchJson<ApiRes<unknown>>(`/api/admin/adapters/${editingName}`, {
          method: 'PUT',
          body: JSON.stringify(body),
        }).catch((err) => {
          console.warn('[adapters] 保存失败', err)
          return null
        })
      : await fetchJson<ApiRes<unknown>>('/api/admin/adapters', {
          method: 'POST',
          body: JSON.stringify(body),
        }).catch((err) => {
          console.warn('[adapters] 保存失败', err)
          return null
        })

    if (!res?.success) {
      toast(extractError(res, t('admin.adapters.saveFailed')) || t('admin.adapters.saveFailed'), 'error')
      return
    }
    toast(editingName ? t('admin.adapters.updated') : t('admin.adapters.created'), 'success')
    setFormOpen(false)
    afterMutate()
  }

  /* ──── 删除 ──── */

  const confirmDelete = async (name: string) => {
    const ok = await confirm(t('admin.adapters.deleteConfirm', { name }))
    if (!ok) return
    const res = await fetchJson<ApiRes<unknown>>(`/api/admin/adapters/${name}`, {
      method: 'DELETE',
    }).catch((err) => {
      console.warn('[adapters] 删除失败', err)
      return null
    })
    if (!res?.success) {
      toast(extractError(res, t('admin.adapters.deleteFailed')) || t('admin.adapters.deleteFailed'), 'error')
      return
    }
    toast(t('admin.adapters.deleted'), 'success')
    afterMutate()
  }

  /* ──── 测试 ──── */

  const openTestPanel = (name: string) => {
    const a = adapters.find((x) => x.name === name)
    if (!a) {
      toast(t('admin.common.error'), 'error')
      return
    }
    setTest({
      open: true,
      name: a.name,
      modelIds: (a.models ?? []).map((m) => m.sourceModelId),
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
          placeholder={t('admin.adapters.searchPlaceholder')}
          inputSize="sm"
          aria-label={t('admin.adapters.searchPlaceholder')}
          startSlot={<Search className="size-3.5 text-muted-foreground" />}
          className="w-64"
        />
        <Button variant="primary" size="sm" onClick={() => openForm(null)}>
          {t('admin.adapters.add')}
        </Button>
      </div>

      {/* 列表 */}
      <Table size="sm" hoverableRows>
        <TableHeader>
          <TableRow>
            <TableHead>{t('admin.adapters.adapter')}</TableHead>
            <TableHead>{t('admin.adapters.type')}</TableHead>
            <TableHead>{t('admin.adapters.baseUrl')}</TableHead>
            <TableHead>{t('admin.adapters.modelMapping')}</TableHead>
            <TableHead>{t('admin.adapters.status')}</TableHead>
            <TableHead className="text-end">{t('admin.adapters.actions')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.map((a) => {
            const models = a.models ?? []
            const allOk = models.every((m) => m.status === 'ok')
            return (
              <TableRow key={a.name}>
                <TableCell className="font-semibold text-foreground">{a.name}</TableCell>
                <TableCell className="font-mono text-[11.5px] text-muted-foreground">
                  {a.type === 'openai-responses' ? 'openai (responses)' : a.type}
                </TableCell>
                <TableCell className="font-mono text-[10.5px] text-muted-foreground">
                  {a.baseUrl || '—'}
                </TableCell>
                <TableCell>
                  <div className="flex max-w-90 flex-wrap gap-1">
                    {models.map((m, i) => {
                      const bad = m.status !== 'ok'
                      const thinkingDetail = m.thinking
                        ? [
                            m.thinking.budget_tokens ? `thinking:${m.thinking.budget_tokens}` : '',
                            m.thinking.reasoning_effort ? `re:${m.thinking.reasoning_effort}` : '',
                            m.thinking.type ? `type:${m.thinking.type}` : '',
                          ]
                            .filter(Boolean)
                            .join(' ')
                        : ''
                      return (
                        <span
                          key={i}
                          title={
                            `${m.sourceModelId} → ${m.provider}/${m.targetModelId}` +
                            (m.status && m.status !== 'ok' ? `\nstatus: ${m.status}` : '') +
                            (thinkingDetail ? `\n${thinkingDetail}` : '')
                          }
                          className={
                            'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] ' +
                            (bad
                              ? 'border-error bg-error-soft text-error-emphasis'
                              : 'border-border bg-background-subtle text-muted-foreground')
                          }
                        >
                          {m.sourceModelId} → {m.provider}/{m.targetModelId}
                          {m.thinking && <Brain className="size-3 text-primary-strong" aria-label="thinking" />}
                        </span>
                      )
                    })}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant={allOk ? 'success' : 'error'} size="sm">
                    {allOk ? t('admin.common.normal') : t('admin.common.error')}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-1.5">
                    <Button
                      variant="soft"
                      size="sm"
                      className="bg-info-soft text-info-emphasis"
                      onClick={() => openTestPanel(a.name)}
                    >
                      <Activity data-icon="start" className="size-3.5" />
                      {t('admin.common.test')}
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => openForm(a.name)}>
                      <Pencil data-icon="start" className="size-3.5" />
                      {t('admin.common.edit')}
                    </Button>
                    <Button
                      variant="soft"
                      size="sm"
                      className="bg-error-soft text-error-emphasis"
                      onClick={() => void confirmDelete(a.name)}
                    >
                      <Trash data-icon="start" className="size-3.5" />
                      {t('admin.common.delete')}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            )
          })}

          {loading && adapters.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="py-12 text-center">
                <Spinner className="text-xl" />
              </TableCell>
            </TableRow>
          )}
          {!loading && filtered.length === 0 && adapters.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="py-12 text-center text-[13px] text-muted-foreground">
                {t('admin.adapters.empty')}
              </TableCell>
            </TableRow>
          )}
          {!loading && filtered.length === 0 && adapters.length > 0 && (
            <TableRow>
              <TableCell colSpan={6} className="py-12 text-center text-[13px] text-muted-foreground">
                {t('admin.adapters.noMatch')}
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
              {editingName ? t('admin.adapters.editTitle') : t('admin.adapters.addTitle')}
            </DialogTitle>
          </DialogHeader>
          <DialogBody>
            <div className="max-h-[58vh] space-y-4 overflow-y-auto pe-1">
              {/* 名称 */}
              <div className="flex flex-col gap-1.5">
                <label className={LABEL_CLS} htmlFor="adapter-name">
                  {t('admin.adapters.formName')}
                </label>
                <Input
                  id="adapter-name"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder={t('admin.adapters.formNamePlaceholder')}
                  inputSize="sm"
                />
              </div>

              {/* 类型 */}
              <div className="flex flex-col gap-1.5">
                <label className={LABEL_CLS}>{t('admin.adapters.formType')}</label>
                <Select
                  size="sm"
                  value={form.type}
                  onValueChange={(v) => setForm((f) => ({ ...f, type: String(v ?? 'openai') as ProviderType }))}
                >
                  <SelectTrigger aria-label={t('admin.adapters.formType')}>
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

              {/* 请求默认（max_tokens + stream） */}
              <div className="flex flex-col gap-1.5">
                <label className={LABEL_CLS}>{t('admin.adapters.formRequestDefaults')}</label>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <label className="flex items-center gap-1.5">
                    <span className="text-[10.5px] font-medium whitespace-nowrap text-primary-strong">
                      {t('admin.adapters.formDefaultMaxTokens')}
                    </span>
                    <Input
                      type="number"
                      min={0}
                      value={form.maxTokens}
                      onChange={(e) => setForm((f) => ({ ...f, maxTokens: e.target.value }))}
                      inputSize="sm"
                      aria-label={t('admin.adapters.formDefaultMaxTokens')}
                      className="w-28 font-mono text-[11px]"
                    />
                  </label>
                  <label className="flex items-center gap-1.5">
                    <span className="text-[10.5px] font-medium whitespace-nowrap text-primary-strong">
                      {t('admin.adapters.formStreamDefault')}
                    </span>
                    <Select
                      size="sm"
                      value={form.stream || 'follow'}
                      onValueChange={(v) =>
                        setForm((f) => ({ ...f, stream: v === 'follow' ? '' : String(v ?? '') }))
                      }
                    >
                      <SelectTrigger className="w-28" aria-label={t('admin.adapters.formStreamDefault')}>
                        <SelectValue>
                          {(v) =>
                            v === 'true'
                              ? t('admin.adapters.streamOn')
                              : v === 'false'
                                ? t('admin.adapters.streamOff')
                                : t('admin.adapters.streamFollow')
                          }
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="follow">{t('admin.adapters.streamFollow')}</SelectItem>
                        <SelectItem value="true">{t('admin.adapters.streamOn')}</SelectItem>
                        <SelectItem value="false">{t('admin.adapters.streamOff')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </label>
                </div>
                <p className="text-[11px] text-muted-foreground">{t('admin.adapters.requestDefaultsHint')}</p>
              </div>

              {/* 模型映射 */}
              <div className="flex flex-col gap-2">
                <span className={LABEL_CLS}>{t('admin.adapters.formModelMapping')}</span>

                <div className="flex flex-col gap-2.5">
                  {form.models.map((m, i) => {
                    const providerModels = getProviderModels(m.provider)
                    return (
                      <div
                        key={i}
                        className="rounded-md border border-border bg-background-subtle p-3 transition-colors duration-150 hover:border-border-strong"
                      >
                        <div className="flex items-center gap-2">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t('admin.common.delete')}
                            onClick={() => removeMappingRow(i)}
                            className="shrink-0 text-muted-foreground hover:text-error-emphasis"
                          >
                            <X className="size-4" />
                          </Button>
                          {/* sourceModelId */}
                          <Input
                            value={m.sourceModelId}
                            onChange={(e) => updateMapping(i, { sourceModelId: e.target.value })}
                            placeholder={t('admin.adapters.sourcePlaceholder')}
                            inputSize="sm"
                            aria-label={t('admin.adapters.sourceModelId')}
                            className="min-w-30 flex-1 font-mono"
                          />
                          {/* provider */}
                          <Select
                            size="sm"
                            value={m.provider || '__none'}
                            onValueChange={(v) =>
                              onProviderChange(i, v === '__none' ? '' : String(v ?? ''))
                            }
                          >
                            <SelectTrigger className="w-36" aria-label={t('admin.adapters.provider')}>
                              <SelectValue placeholder={t('admin.adapters.selectProvider')}>
                                {(v) => (!v || v === '__none' ? t('admin.adapters.selectProvider') : String(v))}
                              </SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__none">{t('admin.adapters.selectProvider')}</SelectItem>
                              {providers.map((p) => (
                                <SelectItem key={p.name} value={p.name}>
                                  {p.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {/* targetModelId */}
                          <Select
                            size="sm"
                            value={m.targetModelId || '__none'}
                            onValueChange={(v) =>
                              updateMapping(i, { targetModelId: v === '__none' ? '' : String(v ?? '') })
                            }
                          >
                            <SelectTrigger className="w-44" aria-label={t('admin.adapters.targetModelId')}>
                              <SelectValue placeholder={t('admin.adapters.selectModel')}>
                                {(v) => (!v || v === '__none' ? t('admin.adapters.selectModel') : String(v))}
                              </SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__none">{t('admin.adapters.selectModel')}</SelectItem>
                              {providerModels.map((pm) => (
                                <SelectItem key={pm.id} value={pm.id}>
                                  {pm.id}
                                  {pm.thinking || pm.reasoning_effort ? ' 🤔' : ''}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                        {/* thinking / effort 配置 */}
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
                                onChange={(e) => updateMappingThinking(i, { budget_tokens: e.target.value })}
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
                              onChange={(v) => updateMapping(i, { reasoning_effort: v })}
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
                                updateMappingThinking(i, { type: v === 'none' ? '' : String(v ?? '') })
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
                        </div>
                      </div>
                    )
                  })}
                </div>

                <Button variant="ghost" size="sm" onClick={addMappingRow} className="self-start">
                  <Plus data-icon="start" className="size-3.5" />
                  {t('admin.adapters.addMapping')}
                </Button>

                {/* 一键导入供应商全部模型 */}
                <div className="flex items-center gap-2 rounded-md border border-dashed border-border bg-background-subtle p-2">
                  <Select
                    size="sm"
                    value={bulkImportProvider || '__none'}
                    onValueChange={(v) => setBulkImportProvider(v === '__none' ? '' : String(v ?? ''))}
                  >
                    <SelectTrigger className="flex-1" aria-label={t('admin.adapters.bulkImport')}>
                      <SelectValue placeholder={t('admin.adapters.selectProviderFirst')}>
                        {(v) =>
                          !v || v === '__none' ? t('admin.adapters.selectProviderFirst') : String(v)
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none">{t('admin.adapters.selectProviderFirst')}</SelectItem>
                      {providers.map((p) => (
                        <SelectItem key={p.name} value={p.name}>
                          {p.name} ({p.models?.length ?? 0})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button variant="soft" size="sm" onClick={bulkImportAllModels}>
                    <CloudDownload data-icon="start" className="size-3.5" />
                    {t('admin.adapters.bulkImport')}
                  </Button>
                </div>
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

      {/* 连通性测试弹窗（adapters → /api/admin/test-adapter） */}
      <TestPanelDialog
        open={test.open}
        onClose={() => setTest((prev) => ({ ...prev, open: false }))}
        name={test.name}
        modelIds={test.modelIds}
        endpoint="/api/admin/test-adapter"
        buildBody={(modelId) => ({ adapterName: test.name, modelId })}
      />
    </div>
  )
}
