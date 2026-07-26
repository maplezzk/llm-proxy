import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@appica/ui-react/button'
import { Badge } from '@appica/ui-react/badge'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@appica/ui-react/table'
import { ClipboardCopy } from '@appica/icons-react'
import JsonEditorPane from '../components/JsonEditorPane'
import { useToast } from '../lib/toast'

/* ────────────────────────── 类型 / 常量 ────────────────────────── */

/** 后端 CaptureEntry（src/proxy/capture.ts）。 */
interface CaptureEntry {
  id: number
  timestamp: number
  source: string
  protocol: string
  model: string
  pairId: number
  adapterName?: string
  upstreamProvider?: string
  upstreamProtocol?: string
  upstreamModel?: string
  requestIn: string | null
  requestOut: string | null
  responseIn: string | null
  responseOut: string | null
}

interface StatusRes {
  success?: boolean
  data?: { enabled?: boolean }
}

type PhaseKey = 'requestIn' | 'requestOut' | 'responseIn' | 'responseOut'

/**
 * 四阶段定义（对齐旧版 capture.ts PHASES）。
 * 标签为旧版硬编码中文（locales 无对应 key，忠实迁移）；
 * 颜色由旧版 var(--success)/var(--accent) 映射到 Appica token 类。
 */
const PHASES: Array<{ key: PhaseKey; label: string; cls: string; isStream: boolean }> = [
  { key: 'requestIn', label: '客户端→代理', cls: 'text-success-emphasis', isStream: false },
  { key: 'requestOut', label: '代理→上游', cls: 'text-primary-strong', isStream: false },
  { key: 'responseIn', label: '上游→代理', cls: 'text-success-emphasis', isStream: true },
  { key: 'responseOut', label: '代理→客户端', cls: 'text-primary-strong', isStream: true },
]

const MAX_ENTRIES = 200

/* ────────────────────────── 工具 ────────────────────────── */

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}`
}

function fmtSize(s: string | null): string {
  if (!s) return '0B'
  const b = s.length
  if (b > 1024) return (b / 1024).toFixed(1) + 'KB'
  return b + 'B'
}

/* ────────────────────────── 页面 ────────────────────────── */

/**
 * Capture 页 — 移植自旧版 capture.ts：
 * - 启动/暂停/结束抓包（后端控制 + SSE 连接生命周期）
 * - 来源过滤、条目列表（pairId 合并、上限 200）
 * - 选中条目四阶段详情（request JSON 树形 / response 原始文本）+ 复制原始数据
 */
export default function CapturePage() {
  const { t } = useTranslation()
  const { toast } = useToast()

  const [entries, setEntries] = useState<CaptureEntry[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [running, setRunning] = useState(false)
  const [sourceFilter, setSourceFilter] = useState('')
  const esRef = useRef<EventSource | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)

  // 卸载标记：阻止 fetch/SSE 回调在卸载后 setState。
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  /** 调用后端抓包控制 API。 */
  const apiControl = useCallback(
    async (enabled: boolean, clear = false) => {
      try {
        await fetch('/admin/debug/captures/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled, clear }),
        })
      } catch (err) {
        console.warn('[capture] 控制请求失败', err)
        toast(t('admin.common.requestFailed'), 'error')
      }
    },
    [t, toast],
  )

  /** 建立 SSE 连接 + 加载历史数据（不修改后端 enabled 状态）。 */
  const connectSSE = useCallback(() => {
    esRef.current?.close()
    esRef.current = null
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    setRunning(true)
    setEntries([])
    setSelectedId(null)

    // 历史数据（可中止）
    fetch('/admin/debug/captures', { signal: ac.signal })
      .then((r) => r.json())
      .then((d: { success?: boolean; data?: CaptureEntry[] }) => {
        if (d.success && mountedRef.current && !ac.signal.aborted) setEntries(d.data ?? [])
      })
      .catch((err) => {
        if (ac.signal.aborted) return
        console.warn('[capture] 历史数据加载失败', err)
        toast(t('admin.common.requestFailed'), 'error')
      })

    // SSE 实时推送
    const es = new EventSource('/admin/debug/captures/stream')
    es.onmessage = (ev) => {
      if (!mountedRef.current || esRef.current !== es) return
      try {
        const entry = JSON.parse(ev.data) as CaptureEntry
        setEntries((prev) => {
          const idx = prev.findIndex((e) => e.pairId === entry.pairId)
          if (idx >= 0) {
            const next = prev.slice()
            next[idx] = entry
            return next
          }
          const next = [...prev, entry]
          return next.length > MAX_ENTRIES ? next.slice(-MAX_ENTRIES) : next
        })
      } catch (err) {
        // 上游夹杂非 JSON 帧：不丢弃连接，但必须可见（toast 8s 去重防刷屏）
        console.warn('[capture] SSE 消息解析失败', err)
        toast(t('admin.common.parseFailed'), 'warning')
      }
    }
    es.onerror = () => {
      // EventSource 会自动重连；readyState=CLOSED 表示服务端关闭或 fatal，同步 UI 状态
      console.warn('[capture] SSE 连接异常, readyState=', es.readyState)
      toast(t('admin.common.requestFailed'), 'warning')
      if (es.readyState === EventSource.CLOSED) {
        if (esRef.current === es) esRef.current = null
        if (mountedRef.current) setRunning(false)
      }
    }
    esRef.current = es
  }, [t, toast])

  // 进入页面：查询后端状态，已启用则自动连接；卸载时中止 fetch + 关闭 SSE。
  useEffect(() => {
    const ac = new AbortController()
    fetch('/admin/debug/captures/status', { signal: ac.signal })
      .then((r) => r.json())
      .then((d: StatusRes) => {
        if (d.success && d.data?.enabled) connectSSE()
      })
      .catch((err) => {
        if (ac.signal.aborted) return
        console.warn('[capture] 状态查询失败', err)
        toast(t('admin.common.requestFailed'), 'error')
      })
    return () => {
      ac.abort()
      abortRef.current?.abort()
      esRef.current?.close()
      esRef.current = null
    }
  }, [connectSSE, t, toast])

  /* ──── 控制按钮 ──── */

  const startCapture = () => {
    void apiControl(true, true) // 启用 + 清空缓存
    connectSSE()
  }

  /** 暂停：仅停用后端抓包，保留连接与数据（对齐旧版 stopCapture）。 */
  const pauseCapture = () => {
    void apiControl(false)
    setRunning(false)
    esRef.current?.close()
    esRef.current = null
  }

  /** 结束：停用 + 清空后端缓存与本地数据（对齐旧版 endCapture）。 */
  const endCapture = () => {
    void apiControl(false, true)
    setRunning(false)
    esRef.current?.close()
    esRef.current = null
    setEntries([])
    setSelectedId(null)
  }

  /* ──── 派生数据 ──── */

  const sources = useMemo(
    () => [...new Set(entries.map((e) => e.source))].sort(),
    [entries],
  )

  const filtered = useMemo(
    () => (sourceFilter ? entries.filter((e) => e.source === sourceFilter) : entries),
    [entries, sourceFilter],
  )

  const selected = useMemo(
    () => (selectedId == null ? null : entries.find((e) => e.id === selectedId) ?? null),
    [entries, selectedId],
  )

  const toggleSelect = (id: number) => {
    setSelectedId((cur) => (cur === id ? null : id))
  }

  const copyRaw = (raw: string | null) => {
    if (raw == null) return
    navigator.clipboard.writeText(raw).catch((err) => {
      console.warn('[capture] 复制失败', err)
      toast(t('admin.common.copyFailed'), 'error')
    })
  }

  /* ──── 渲染 ──── */

  return (
    <div className="flex flex-col gap-4 p-6">
      {/* 工具条 */}
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="me-1 text-[15px] font-semibold text-foreground">{t('admin.capture.title')}</h3>

        {!running ? (
          <Button variant="primary" size="sm" onClick={startCapture}>
            {t('admin.capture.start')}
          </Button>
        ) : (
          <>
            <Button variant="outline" size="sm" onClick={pauseCapture}>
              {t('admin.capture.pause')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-error-emphasis hover:bg-error-soft"
              onClick={endCapture}
            >
              {t('admin.capture.stop')}
            </Button>
          </>
        )}

        {running && (
          <Badge variant="success" size="sm">
            ●
          </Badge>
        )}

        <span className="text-[11px] text-muted-foreground">
          {t('admin.capture.entryCount', { count: filtered.length })}
        </span>

        <div className="mx-1 h-4 w-px bg-border" />

        {/* 来源过滤 */}
        <span className="text-[11px] text-muted-foreground">{t('admin.capture.source')}</span>
        <Button
          variant={sourceFilter === '' ? 'soft' : 'ghost'}
          size="sm"
          onClick={() => setSourceFilter('')}
        >
          {t('admin.capture.filterAll')}
        </Button>
        {sources.map((s) => (
          <Button
            key={s}
            variant={sourceFilter === s ? 'soft' : 'ghost'}
            size="sm"
            onClick={() => setSourceFilter(s)}
          >
            {s}
          </Button>
        ))}
      </div>

      {/* 条目列表 */}
      <div className="overflow-x-auto">
        <Table size="sm" hoverableRows>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">#</TableHead>
              <TableHead className="w-40">{t('admin.capture.time')}</TableHead>
              <TableHead>{t('admin.capture.sourceCol')}</TableHead>
              <TableHead>{t('admin.capture.adapter')}</TableHead>
              <TableHead>{t('admin.capture.inboundProtocol')}</TableHead>
              <TableHead>{t('admin.capture.inboundModel')}</TableHead>
              <TableHead>{t('admin.capture.upstreamProvider')}</TableHead>
              <TableHead>{t('admin.capture.upstreamProtocol')}</TableHead>
              <TableHead>{t('admin.capture.upstreamModel')}</TableHead>
              <TableHead className="text-end">{t('admin.capture.requestSize')}</TableHead>
              <TableHead className="text-end">{t('admin.capture.responseSize')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((e) => (
              <TableRow
                key={e.id}
                onClick={() => toggleSelect(e.id)}
                className={
                  'cursor-pointer ' + (selectedId === e.id ? 'bg-background-muted' : '')
                }
              >
                <TableCell className="font-mono text-[11px] text-muted-foreground">{e.id}</TableCell>
                <TableCell className="font-mono text-[10.5px] whitespace-nowrap text-muted-foreground">
                  {fmtTime(e.timestamp)}
                </TableCell>
                <TableCell className="text-[11.5px] text-foreground">{e.source}</TableCell>
                <TableCell className="text-[11.5px] text-muted-foreground">{e.adapterName || '—'}</TableCell>
                <TableCell className="font-mono text-[11px] text-muted-foreground">{e.protocol}</TableCell>
                <TableCell className="font-mono text-[11px] text-muted-foreground">{e.model}</TableCell>
                <TableCell className="text-[11.5px] text-muted-foreground">{e.upstreamProvider || '—'}</TableCell>
                <TableCell className="font-mono text-[11px] text-muted-foreground">
                  {e.upstreamProtocol || '—'}
                </TableCell>
                <TableCell className="font-mono text-[11px] text-muted-foreground">
                  {e.upstreamModel || '—'}
                </TableCell>
                <TableCell className="text-end font-mono text-[10.5px] whitespace-nowrap">
                  <span className="text-success-emphasis">{fmtSize(e.requestIn)}</span>
                  <span className="text-muted-foreground"> / </span>
                  <span className="text-primary-strong">{fmtSize(e.requestOut)}</span>
                </TableCell>
                <TableCell className="text-end font-mono text-[10.5px] whitespace-nowrap">
                  <span className="text-success-emphasis">{fmtSize(e.responseIn)}</span>
                  <span className="text-muted-foreground"> / </span>
                  <span className="text-primary-strong">{fmtSize(e.responseOut)}</span>
                </TableCell>
              </TableRow>
            ))}

            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={11} className="py-12 text-center text-[13px] text-muted-foreground">
                  {t('admin.capture.empty')}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* 四阶段详情 */}
      {selected && (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {PHASES.map((p) => (
            <div
              key={p.key}
              className="overflow-hidden rounded-md border border-border bg-background-subtle"
            >
              <div className="flex items-center gap-2 border-b border-border bg-background px-3 py-2">
                <span className={'text-[12px] font-semibold ' + p.cls}>{p.label}</span>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {fmtSize(selected[p.key])}
                </span>
                <button
                  type="button"
                  onClick={() => copyRaw(selected[p.key])}
                  aria-label={t('admin.capture.copyRaw')}
                  title={t('admin.capture.copyRaw')}
                  className="ms-auto cursor-pointer text-muted-foreground transition-colors hover:text-foreground"
                >
                  <ClipboardCopy className="size-3.5" />
                </button>
              </div>
              <div className="max-h-100 overflow-auto">
                <JsonEditorPane data={selected[p.key]} isStream={p.isStream} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
