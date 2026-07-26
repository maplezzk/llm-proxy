import { useEffect, useRef, useState } from 'react'
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
import { ChevronDown, ChevronUp, Bolt } from '@appica/icons-react'
import { fetchJson } from '../lib/api'

/** 单次测试的结果条目（对齐旧版 test-panel.ts 的 results.unshift 结构）。 */
interface TestResult {
  id: number
  model: string
  ok: boolean
  latency?: number
  error?: string
  time: string
  requestUrl?: string
  requestHeaders?: unknown
  requestBody?: unknown
  responseStatus?: number
  responseBody?: unknown
  /** 适配器测试额外返回的入口 URL（providers 无此字段） */
  adapterUrl?: string
  showDetails: boolean
}

/**
 * 连通性测试弹窗 — providers 与 adapters 共用（替代旧版 open-test-panel CustomEvent）。
 *
 * 受控组件：open/onClose 由调用方持有；测试目标（名称 / 可选类型标签 / 模型列表）
 * 与请求体构造、端点均由调用方通过 props 注入：
 * - providers：endpoint 缺省 `/admin/test-model`，buildBody → {providerName, model, type}
 * - adapters：endpoint 传 `/admin/test-adapter`，buildBody → {adapterName, modelId}
 *
 * 行为对齐旧版：选模型 → 运行 → 结果 unshift 列表（默认展开详情）→ 可清空。
 */
export interface TestPanelDialogProps {
  open: boolean
  onClose: () => void
  /** 标题与顶部展示的主体名称（provider 名 / adapter 名） */
  name: string
  /** 可选的类型标签，展示为 “(type)”，如 provider 协议类型；可省略 */
  typeLabel?: string
  /** provider 支持的协议；超过一个时允许在测试面板中切换协议 */
  protocols?: Array<{ type: string; apiBase?: string }>
  /** 可选模型 ID 列表 */
  modelIds: string[]
  /** 测试端点；providers 用默认 `/admin/test-model`，adapters 传 `/admin/test-adapter` */
  endpoint?: string
  /** 依据选中模型 ID 构造请求体 */
  buildBody: (modelId: string, protocolType?: string) => Record<string, unknown>
}

/** 请求/响应详情块：label + 等宽 JSON 预格式化。 */
function DetailBlock({ label, value }: { label: string; value: unknown }) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return (
    <div>
      <strong className="text-foreground">{label}</strong>
      <pre className="mt-1 max-h-40 overflow-auto rounded border border-border bg-background-muted p-2 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap break-all text-muted-foreground">
        {text}
      </pre>
    </div>
  )
}

/** 单条结果：状态条（✓ 延迟 / ✗ 错误）+ 可展开的请求/响应详情。 */
function ResultItem({ r }: { r: TestResult }) {
  const { t } = useTranslation()
  const [show, setShow] = useState(r.showDetails)
  const hasDetails = !!r.requestUrl

  return (
    <div className="transition-opacity duration-200">
      <div
        className={
          'flex items-center gap-2.5 rounded-md border-l-3 px-3 py-2.5 text-[12.5px] transition-transform duration-150 hover:translate-x-0.5 ' +
          (r.ok ? 'border-l-success bg-success-soft' : 'border-l-error bg-error-soft')
        }
      >
        <span className="min-w-30 max-w-50 truncate font-semibold text-foreground" title={r.model}>
          {r.model}
        </span>
        <span className="min-w-16 shrink-0 text-[11px] text-muted-foreground">{r.time}</span>
        <span
          className={
            'flex-1 truncate font-mono text-[11.5px] ' +
            (r.ok ? 'text-success-emphasis' : 'text-error-emphasis')
          }
          title={r.ok ? undefined : r.error || t('admin.test.unreachable')}
        >
          {r.ok ? `✓ ${r.latency ?? 0}ms` : `✗ ${(r.error || t('admin.test.unreachable')).slice(0, 80)}`}
        </span>
      </div>

      {hasDetails && (
        <div className="mt-0.5 overflow-hidden rounded-b-md border border-border bg-background-subtle">
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            className="flex w-full cursor-pointer items-center gap-1 px-3 py-1.5 text-[11px] font-medium text-primary-strong transition-colors hover:bg-background-muted"
          >
            {show ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
            {show ? t('admin.common.collapse') : t('admin.common.expand')}
          </button>
          {show && (
            <div className="space-y-2.5 border-t border-border px-3 py-2.5 text-[11px]">
              <div>
                <strong className="text-foreground">URL</strong>
                <span className="ms-2 break-all font-mono text-muted-foreground">{r.requestUrl}</span>
                {r.responseStatus != null && (
                  <span
                    className={
                      'ms-2 font-mono ' +
                      (r.responseStatus < 400 ? 'text-success-emphasis' : 'text-error-emphasis')
                    }
                  >
                    HTTP {r.responseStatus}
                  </span>
                )}
              </div>
              {r.adapterUrl && (
                <div>
                  <strong className="text-foreground">Adapter URL</strong>
                  <span className="ms-2 break-all font-mono text-muted-foreground">{r.adapterUrl}</span>
                </div>
              )}
              <DetailBlock label="Headers" value={r.requestHeaders} />
              <DetailBlock label="Request Body" value={r.requestBody} />
              {r.responseBody != null && <DetailBlock label="Response Body" value={r.responseBody} />}
              {r.error && (
                <div>
                  <strong className="text-error-emphasis">{t('admin.common.error')}</strong>
                  <span className="ms-2 break-words text-error-emphasis">{r.error}</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function TestPanelDialog({
  open,
  onClose,
  name,
  typeLabel,
  protocols = [],
  modelIds,
  endpoint = '/admin/test-model',
  buildBody,
}: TestPanelDialogProps) {
  const { t } = useTranslation()
  const [selectedModel, setSelectedModel] = useState('')
  const [selectedType, setSelectedType] = useState(typeLabel ?? protocols[0]?.type ?? '')
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<TestResult[]>([])
  const idRef = useRef(0)

  // 打开时重置选择与结果（对齐旧版 open-test-panel 事件处理）。
  useEffect(() => {
    if (open) {
      setSelectedModel(modelIds[0] ?? '')
      setSelectedType(protocols[0]?.type ?? typeLabel ?? '')
      setResults([])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const run = async () => {
    if (!selectedModel) return
    setRunning(true)
    type TestApiRes = { data?: Partial<TestResult> & { reachable?: boolean } }
    const res: TestApiRes = await fetchJson<TestApiRes>(endpoint, {
      method: 'POST',
      body: JSON.stringify(buildBody(selectedModel, selectedType)),
    }).catch((): TestApiRes => ({
      data: { reachable: false, latency: 0, error: t('admin.test.requestFailed') },
    }))
    setRunning(false)
    const d = res.data ?? {}
    const item: TestResult = {
      id: ++idRef.current,
      model: selectedModel,
      ok: d.reachable === true,
      latency: d.latency,
      error: d.error,
      time: new Date().toLocaleTimeString(),
      requestUrl: d.requestUrl,
      requestHeaders: d.requestHeaders,
      requestBody: d.requestBody,
      responseStatus: d.responseStatus,
      responseBody: d.responseBody,
      adapterUrl: d.adapterUrl,
      showDetails: true,
    }
    setResults((prev) => [item, ...prev])
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:w-160">
        <DialogHeader>
          <DialogTitle>{t('admin.test.title', { name })}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          {/* 模型选择 + 运行 */}
          <div className="mb-3.5 flex items-center gap-3">
            <strong
              className="min-w-0 max-w-40 truncate text-[13px] font-semibold text-foreground"
              title={name}
            >
              {name}
            </strong>
            <div className="min-w-0 flex-1">
              <Select
                size="sm"
                value={selectedModel}
                onValueChange={(v) => setSelectedModel(String(v ?? ''))}
              >
                <SelectTrigger className="w-full" aria-label={t('admin.test.title', { name })}>
                  <SelectValue placeholder="—" />
                </SelectTrigger>
                <SelectContent>
                  {modelIds.map((id) => (
                    <SelectItem key={id} value={id}>
                      {id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {protocols.length > 1 ? (
              <Select size="sm" value={selectedType} onValueChange={(v) => setSelectedType(String(v ?? ''))}>
                <SelectTrigger className="w-38" aria-label="Protocol">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {protocols.map((protocol) => (
                    <SelectItem key={protocol.type} value={protocol.type}>
                      {protocol.type}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : typeLabel ? (
              <span className="shrink-0 text-[11px] whitespace-nowrap text-muted-foreground">
                ({selectedType || typeLabel})
              </span>
            ) : null}
            <Button
              variant="primary"
              size="sm"
              className="min-w-18 shrink-0"
              disabled={running || modelIds.length === 0}
              onClick={() => void run()}
            >
              <Bolt data-icon="start" className="size-3.5" />
              {running ? t('admin.test.testing') : t('admin.test.run')}
            </Button>
          </div>

          {/* 结果列表（unshift，可滚动） */}
          <div className="flex max-h-90 flex-col gap-2 overflow-y-auto pe-1">
            {results.length === 0 && (
              <div className="py-8 text-center text-[13px] text-muted-foreground">
                {t('admin.test.noResults')}
              </div>
            )}
            {results.map((r) => (
              <ResultItem key={r.id} r={r} />
            ))}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => setResults([])}>
            {t('admin.test.clearResults')}
          </Button>
          <Button variant="outline" onClick={onClose}>
            {t('admin.test.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
