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
  Code,
  Settings,
  ClipboardCopy,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ChevronDown,
  ChevronUp,
} from '@appica/icons-react'
import { fetchJson } from '../lib/api'
import type { ApiRes } from '../lib/api-types'
import { useToast } from '../lib/toast'

/* ────────────────────────── 类型 / 常量 ────────────────────────── */

interface LogEntry {
  timestamp: string
  type: 'request' | 'system'
  level: string
  message: string
  details?: unknown
}

const PAGE_SIZE = 50
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const

/** level → Badge variant（对齐旧版配色：error 红 / warn 黄 / info 蓝 / debug 灰）。 */
function levelVariant(level: string): 'error' | 'warning' | 'info' | 'secondary' {
  switch (level) {
    case 'error':
      return 'error'
    case 'warn':
      return 'warning'
    case 'info':
      return 'info'
    default:
      return 'secondary'
  }
}

/* ────────────────────────── 工具 ────────────────────────── */

function formatTime(ts: string): string {
  const d = new Date(ts)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

/* ────────────────────────── 详情单元格（可展开 + 复制） ────────────────────────── */

function DetailCell({ details }: { details: unknown }) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [expanded, setExpanded] = useState(false)

  if (details === null || details === undefined) {
    return <span className="text-muted-foreground">—</span>
  }

  const copy = () => {
    navigator.clipboard.writeText(JSON.stringify(details)).then(
      // 旧版硬编码中文 toast（locales 无对应 key，忠实迁移）
      () => toast('已复制', 'success'),
      () => {},
    )
  }

  return (
    <div className="text-[11px]">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setExpanded((s) => !s)}
          className="flex cursor-pointer items-center gap-0.5 font-medium text-primary-strong transition-colors hover:underline"
        >
          {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          JSON
        </button>
        <button
          type="button"
          onClick={copy}
          aria-label={t('admin.common.copy')}
          title={t('admin.common.copy')}
          className="cursor-pointer text-muted-foreground transition-colors hover:text-foreground"
        >
          <ClipboardCopy className="size-3.5" />
        </button>
      </div>
      {expanded && (
        <pre className="mt-1.5 max-h-80 overflow-auto rounded border border-border bg-background-muted p-2 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap break-all text-muted-foreground">
          {JSON.stringify(details, null, 2)}
        </pre>
      )}
    </div>
  )
}

/* ────────────────────────── 页面 ────────────────────────── */

/**
 * Logs 页 — 移植自旧版 logs.ts：
 * - 加载（limit=1000，可按日期）、类型/级别筛选、关键词搜索、分页（50/页）
 * - 日志级别切换（GET/PUT /admin/log-level）、刷新
 * - 详情可展开 JSON + 复制
 */
export default function LogsPage() {
  const { t } = useTranslation()
  const { toast } = useToast()

  const [allLogs, setAllLogs] = useState<LogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'all' | 'request' | 'system'>('all')
  const [levelFilter, setLevelFilter] = useState<string>('all')
  const [dateFilter, setDateFilter] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [currentLogLevel, setCurrentLogLevel] = useState('info')

  const load = useCallback(async (date?: string) => {
    setLoading(true)
    const params = new URLSearchParams({ limit: '1000' })
    if (date) params.set('date', date)
    const res = await fetchJson<ApiRes<{ logs: LogEntry[] }>>('/admin/logs?' + params.toString()).catch(
      () => null,
    )
    setAllLogs(res?.data?.logs ?? [])
    setPage(1)
    setLoading(false)
  }, [])

  const loadLogLevel = useCallback(async () => {
    const res = await fetchJson<ApiRes<{ level: string }>>('/admin/log-level').catch(() => null)
    setCurrentLogLevel(res?.data?.level ?? 'info')
  }, [])

  useEffect(() => {
    void load()
    void loadLogLevel()
  }, [load, loadLogLevel])

  const setLogLevel = async (level: string) => {
    const res = await fetchJson<ApiRes<unknown>>('/admin/log-level', {
      method: 'PUT',
      body: JSON.stringify({ level }),
    }).catch(() => null)
    if (res?.success) {
      setCurrentLogLevel(level)
      // 旧版硬编码中文 toast（locales 无对应 key，忠实迁移）
      toast(`日志级别已设为 ${level}`, 'success')
    }
  }

  /* ──── 过滤 + 分页 ──── */

  const filtered = useMemo(() => {
    let logs = allLogs.slice().sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    if (filter !== 'all') logs = logs.filter((l) => l.type === filter)
    if (levelFilter !== 'all') logs = logs.filter((l) => l.level === levelFilter)
    if (search) {
      const q = search.toLowerCase()
      logs = logs.filter(
        (l) =>
          (l.message || '').toLowerCase().includes(q) ||
          (l.details ? JSON.stringify(l.details).toLowerCase() : '').includes(q),
      )
    }
    return logs
  }, [allLogs, filter, levelFilter, search])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const paged = useMemo(
    () => filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [filtered, safePage],
  )

  /* ──── 渲染 ──── */

  const typeFilters: Array<{ key: 'all' | 'request' | 'system'; label: string }> = [
    { key: 'all', label: t('admin.logs.filterAll') },
    { key: 'request', label: t('admin.logs.filterRequest') },
    { key: 'system', label: t('admin.logs.filterSystem') },
  ]
  const levelFilters: Array<{ key: string; label: string }> = [
    { key: 'all', label: t('admin.logs.filterAll') },
    { key: 'error', label: t('admin.logs.filterError') },
    { key: 'warn', label: t('admin.logs.filterWarn') },
    { key: 'info', label: t('admin.logs.filterInfo') },
    { key: 'debug', label: t('admin.logs.filterDebug') },
  ]

  return (
    <div className="flex flex-col gap-4 p-6">
      {/* 工具条 */}
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="me-2 text-[15px] font-semibold text-foreground">{t('admin.logs.title')}</h3>
        <span className="text-[11px] text-muted-foreground">
          {t('admin.logs.matchCount', { count: filtered.length, page: safePage, totalPages })}
        </span>

        <div className="mx-1 h-4 w-px bg-border" />

        {/* 日期筛选 */}
        <Input
          type="date"
          value={dateFilter}
          onChange={(e) => {
            setDateFilter(e.target.value)
            void load(e.target.value)
          }}
          inputSize="sm"
          aria-label={t('admin.logs.time')}
          className="w-36"
        />
        {dateFilter && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setDateFilter('')
              void load('')
            }}
          >
            ✕
          </Button>
        )}

        {/* 类型筛选 */}
        {typeFilters.map((f) => (
          <Button
            key={f.key}
            variant={filter === f.key ? 'soft' : 'ghost'}
            size="sm"
            onClick={() => {
              setFilter(f.key)
              setPage(1)
            }}
          >
            {f.label}
          </Button>
        ))}

        <div className="mx-1 h-4 w-px bg-border" />

        {/* 级别筛选 */}
        {levelFilters.map((f) => (
          <Button
            key={f.key}
            variant={levelFilter === f.key ? 'soft' : 'ghost'}
            size="sm"
            onClick={() => {
              setLevelFilter(f.key)
              setPage(1)
            }}
          >
            {f.label}
          </Button>
        ))}

        <div className="mx-1 h-4 w-px bg-border" />

        {/* 搜索 */}
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('admin.logs.searchPlaceholder')}
          inputSize="sm"
          aria-label={t('admin.logs.searchPlaceholder')}
          startSlot={<Search className="size-3.5 text-muted-foreground" />}
          className="w-48"
        />

        {/* 日志级别 + 刷新 */}
        <div className="ms-auto flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">{t('admin.logs.logLevel')}</span>
          <Select
            size="sm"
            value={currentLogLevel}
            onValueChange={(v) => void setLogLevel(String(v ?? 'info'))}
          >
            <SelectTrigger className="w-24" aria-label={t('admin.logs.logLevel')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LOG_LEVELS.map((lv) => (
                <SelectItem key={lv} value={lv}>
                  {lv}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="primary" size="sm" onClick={() => void load(dateFilter)}>
            {t('admin.common.refresh')}
          </Button>
        </div>
      </div>

      {/* 表格 */}
      <Table size="sm" hoverableRows>
        <TableHeader>
          <TableRow>
            <TableHead className="w-44">{t('admin.logs.time')}</TableHead>
            <TableHead className="w-20">{t('admin.logs.level')}</TableHead>
            <TableHead className="w-72">{t('admin.logs.message')}</TableHead>
            <TableHead>{t('admin.logs.detail')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {paged.map((l, i) => (
            <TableRow key={`${l.timestamp}-${i}`}>
              <TableCell className="font-mono text-[10.5px] whitespace-nowrap text-muted-foreground">
                {formatTime(l.timestamp)}
              </TableCell>
              <TableCell>
                <Badge variant={levelVariant(l.level)} size="sm">
                  {l.level}
                </Badge>
              </TableCell>
              <TableCell className="text-[12px] text-foreground">
                <span className="me-1.5 inline-flex align-[-2px] text-muted-foreground">
                  {l.type === 'request' ? (
                    <Code className="size-3.5" aria-label="request" />
                  ) : (
                    <Settings className="size-3.5" aria-label="system" />
                  )}
                </span>
                {l.message}
              </TableCell>
              <TableCell>
                <DetailCell details={l.details} />
              </TableCell>
            </TableRow>
          ))}

          {loading && allLogs.length === 0 && (
            <TableRow>
              <TableCell colSpan={4} className="py-12 text-center">
                <Spinner className="text-xl" />
              </TableCell>
            </TableRow>
          )}
          {!loading && filtered.length === 0 && allLogs.length === 0 && (
            <TableRow>
              <TableCell colSpan={4} className="py-12 text-center text-[13px] text-muted-foreground">
                {t('admin.logs.empty')}
              </TableCell>
            </TableRow>
          )}
          {!loading && filtered.length === 0 && allLogs.length > 0 && (
            <TableRow>
              <TableCell colSpan={4} className="py-12 text-center text-[13px] text-muted-foreground">
                {t('admin.logs.noMatch')}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      {/* 分页 */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-1.5">
          <Button variant="outline" size="icon-sm" aria-label="first" disabled={safePage <= 1} onClick={() => setPage(1)}>
            <ChevronsLeft className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="prev"
            disabled={safePage <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <span className="px-2 text-[12px] text-muted-foreground">
            {safePage} / {totalPages}
          </span>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="next"
            disabled={safePage >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            <ChevronRight className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="last"
            disabled={safePage >= totalPages}
            onClick={() => setPage(totalPages)}
          >
            <ChevronsRight className="size-4" />
          </Button>
        </div>
      )}
    </div>
  )
}
