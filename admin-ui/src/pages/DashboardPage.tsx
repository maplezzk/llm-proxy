import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentType, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@appica/ui-react/button'
import { Input } from '@appica/ui-react/input'
import { Spinner } from '@appica/ui-react/spinner'
import {
  ArrowLeftRight,
  Bolt,
  ChartLine,
  CircleCheck,
  CircleX,
  Database,
  Download,
  Grid3x3,
  Server,
  Stack,
  TrendingDown,
  TrendingUp,
  Trash,
  Upload,
} from '@appica/icons-react'
import { useApp } from '../lib/app-state'
import { fetchJson } from '../lib/api'
import type { ApiRes } from '../lib/api-types'
import { useToast } from '../lib/toast'
import { useConfirm } from '../lib/confirm'
import TimelineChart from '../components/charts/TimelineChart'
import type { TimelinePoint } from '../components/charts/TimelineChart'
import BreakdownChart from '../components/charts/BreakdownChart'
import type { UsageBucket } from '../components/charts/BreakdownChart'

interface DbInfo {
  events: number
  aggregates: number
  sizeBytes: number
}

/** config.providers 条目最小结构（仅取 models 计数，与 app-state 的 any 配置隔离） */
interface ProviderEntry {
  models?: unknown[]
}

type BreakdownDimension = 'provider' | 'adapter' | 'model' | 'adapterModel'

/** 初始日期预设：近 30 天（对齐旧版 dateStart=daysAgo(30) + presetDays=30 的初始组合） */
const INITIAL_PRESET_DAYS = 30

/** 清理操作保留天数（对齐旧版 cleanupUsage 固定 90 天） */
const CLEANUP_RETAIN_DAYS = 90

type Accent = 'success' | 'error' | 'primary' | 'secondary' | 'info' | 'muted'

/** 卡片强调色（accent 条 + 图标底）— 全部使用 Appica 主题 token，明暗主题自适应。 */
const ACCENT: Record<Accent, { bar: string; chip: string }> = {
  success: { bar: 'bg-success-emphasis', chip: 'bg-success-soft text-success-emphasis' },
  error: { bar: 'bg-error-emphasis', chip: 'bg-error-soft text-error-emphasis' },
  primary: { bar: 'bg-primary-strong', chip: 'bg-primary-soft text-primary-strong' },
  secondary: { bar: 'bg-secondary-emphasis', chip: 'bg-secondary-soft text-secondary-emphasis' },
  info: { bar: 'bg-info-emphasis', chip: 'bg-info-soft text-info-emphasis' },
  muted: { bar: 'bg-foreground-subtle', chip: 'bg-background-muted text-foreground-muted' },
}

/** 今天往前 N 天，返回 YYYY-MM-DD（对齐旧版，UTC 日期） */
function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10)
}

/** 数值缩写（对齐旧版 fmtNum） */
function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

/** 文件大小（对齐旧版 fmtBytes） */
function fmtBytes(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + ' MB'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + ' KB'
  return n + ' B'
}

/** 百分比（对齐旧版 pct） */
function pct(n: number, total: number): string {
  if (!total) return '0%'
  return ((n / total) * 100).toFixed(1) + '%'
}

interface StatCardSpec {
  label: string
  value: string
  icon: ComponentType<{ className?: string }>
  accent: Accent
  valueClass?: string
  desc?: string
}

/** 统计卡片：左侧 accent 条 + 右上图标底 + 大号数值；hover 轻微上浮。 */
function StatCard({ label, value, icon: Icon, accent, valueClass, desc }: StatCardSpec) {
  return (
    <div className="group relative overflow-hidden rounded-lg border border-border bg-background-subtle px-4 py-3.5 transition-all duration-200 hover:-translate-y-0.5 hover:border-border-strong hover:shadow-md">
      <span
        className={`absolute top-3 bottom-3 left-0 w-1 rounded-r-full opacity-80 transition-opacity group-hover:opacity-100 ${ACCENT[accent].bar}`}
      />
      <div className="mb-2 flex items-start justify-between gap-2">
        <span className="text-[10.5px] font-semibold tracking-wider text-muted-foreground uppercase">{label}</span>
        <span className={`rounded-md p-1.5 ${ACCENT[accent].chip}`}>
          <Icon className="size-4" />
        </span>
      </div>
      <div className={`text-2xl leading-none font-bold tracking-tight ${valueClass ?? 'text-foreground'}`}>
        {value}
      </div>
      {desc ? <div className="mt-1.5 text-[11px] text-muted-foreground">{desc}</div> : null}
    </div>
  )
}

/** 图表加载遮罩（对齐旧版：半透明 + 轻模糊 + spinner） */
function ChartLoading() {
  const { t } = useTranslation()
  return (
    <div className="absolute inset-0 z-[1] flex items-center justify-center rounded-md bg-background/40 backdrop-blur-[2px]">
      <div className="flex flex-col items-center gap-2">
        <Spinner className="text-2xl" />
        <span className="text-xs text-muted-foreground">{t('admin.common.saving')}</span>
      </div>
    </div>
  )
}

/** 图表空态（对齐旧版：图标 + 标题 + 范围说明） */
function ChartEmpty({ icon, desc }: { icon: ReactNode; desc: string }) {
  const { t } = useTranslation()
  return (
    <div className="absolute inset-0 z-[1] flex flex-col items-center justify-center gap-1.5 rounded-md bg-background-subtle">
      <span className="text-muted-foreground opacity-50">{icon}</span>
      <p className="text-[13px] font-semibold text-foreground">{t('admin.dashboard.usage.emptyTitle')}</p>
      <p className="max-w-60 text-center text-[11px] text-muted-foreground">{desc}</p>
    </div>
  )
}

/** 图表卡片容器：图标标题 + 可选描述 + 工具条 + 280px 图表区（相对定位，叠加载/空态） */
function ChartCard({
  icon,
  title,
  desc,
  toolbar,
  children,
}: {
  icon: ReactNode
  title: string
  desc?: string
  toolbar: ReactNode
  children: ReactNode
}) {
  return (
    <section className="rounded-lg border border-border bg-background-subtle p-4 transition-colors duration-200 hover:border-border-strong">
      <div className="flex items-center gap-2">
        <span className="rounded-md bg-primary-soft p-1.5 text-primary-strong">{icon}</span>
        <h3 className="text-[13px] font-semibold text-foreground">{title}</h3>
      </div>
      {desc ? <p className="mt-1.5 mb-2.5 text-[11.5px] leading-relaxed text-muted-foreground">{desc}</p> : null}
      {toolbar}
      <div className="relative h-[280px]">{children}</div>
    </section>
  )
}

/**
 * Dashboard 页 — 移植自旧版 dashboard.ts：
 * - 状态卡片（正常/错误、providers、models、adapters）+ 今日 token 卡片
 * - 时间线折线图 + 分维度堆叠柱状图（共用日期范围；维度独立切换）
 * - 日期预设/自定义 + 维度切换触发两图刷新；失败不阻塞卡片
 * - 数据库信息与 90 天清理（confirm → toast → 刷新）
 * 今日 token 数据来自 useApp().tokenStats（AppProvider 已 10s 轮询 /api/admin/token-stats，
 * 覆盖旧版 dashboard 自身 30s refreshToday 的行为，无需重复轮询）。
 */
export default function DashboardPage() {
  const { t } = useTranslation()
  const { config, health, tokenStats } = useApp()
  const { toast } = useToast()
  const { confirm } = useConfirm()

  // ──── 日期范围 / 维度（初始值对齐旧版：dateStart=daysAgo(30)、preset=30）────
  const [dateStart, setDateStart] = useState(() => daysAgo(INITIAL_PRESET_DAYS))
  const [dateEnd, setDateEnd] = useState(() => todayStr())
  const [presetDays, setPresetDays] = useState(INITIAL_PRESET_DAYS) // 0 = 自定义
  const [dimension, setDimension] = useState<BreakdownDimension>('provider')

  // ──── 图表数据 ────
  const [timeline, setTimeline] = useState<TimelinePoint[]>([])
  const [breakdown, setBreakdown] = useState<UsageBucket[]>([])
  const [dbInfo, setDbInfo] = useState<DbInfo>({ events: 0, aggregates: 0, sizeBytes: 0 })
  const [loadingCharts, setLoadingCharts] = useState(true)
  const [cleaning, setCleaning] = useState(false)
  const [cleanupDays, setCleanupDays] = useState(String(CLEANUP_RETAIN_DAYS))

  // 请求序号：快速切换时丢弃过期响应（旧版无此保护，属无害增强）
  const reqId = useRef(0)

  // timeline + breakdown 共用同一对 startDate/endDate（对齐旧版 loadCharts）。
  const loadCharts = useCallback(async (start: string, end: string, dim: BreakdownDimension) => {
    const id = ++reqId.current
    setLoadingCharts(true)
    const tlUrl = `/api/admin/token-stats/timeline?startDate=${start}&endDate=${end}`
    const bdUrl = `/api/admin/token-stats/breakdown?dimension=${dim}&startDate=${start}&endDate=${end}`
    const [tlRes, bdRes, dbRes] = await Promise.all([
      fetchJson<ApiRes<TimelinePoint[]>>(tlUrl).catch((err) => {
        console.warn('[dashboard] timeline 加载失败', err)
        return null
      }),
      fetchJson<ApiRes<UsageBucket[]>>(bdUrl).catch((err) => {
        console.warn('[dashboard] breakdown 加载失败', err)
        return null
      }),
      fetchJson<ApiRes<DbInfo>>('/api/admin/token-stats/db-info').catch((err) => {
        console.warn('[dashboard] db-info 加载失败', err)
        return null
      }),
    ])
    if (id !== reqId.current) return
    if (!tlRes || !bdRes || !dbRes) {
      toast(t('admin.common.requestFailed'), 'error')
    }
    setTimeline(tlRes?.data ?? [])
    setBreakdown(bdRes?.data ?? [])
    setDbInfo((prev) => dbRes?.data ?? prev)
    setLoadingCharts(false)
  }, [t, toast])

  // 挂载加载一次（对齐旧版 init → loadCharts）
  useEffect(() => {
    void loadCharts(dateStart, dateEnd, dimension)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadCharts])

  // ──── 用户操作（对齐旧版 setPreset / setCustomDate / setBreakdownDim）────

  /** 点击预设天数：同步 dateStart/dateEnd 并立即刷新两图（对齐旧版 setPreset） */
  const handlePreset = (days: number) => {
    const start = daysAgo(days - 1)
    const end = todayStr()
    setPresetDays(days)
    setDateStart(start)
    setDateEnd(end)
    void loadCharts(start, end, dimension)
  }

  /** 自定义日期变更：起止反了自动互换；任一为空只更新输入不请求（对齐旧版 setCustomDate） */
  const handleDateChange = (which: 'start' | 'end', value: string) => {
    const s = which === 'start' ? value : dateStart
    const e = which === 'end' ? value : dateEnd
    if (which === 'start') setDateStart(value)
    else setDateEnd(value)
    if (!s || !e) return
    // 起止反了自动互换（对齐旧版 setCustomDate）
    const [ns, ne] = s > e ? [e, s] : [s, e]
    if (ns !== s || ne !== e) {
      setDateStart(ns)
      setDateEnd(ne)
    }
    setPresetDays(0)
    void loadCharts(ns, ne, dimension)
  }

  /** 切换 breakdown 维度（provider/adapter/model），共用当前日期范围刷新 */
  const handleDimension = (dim: BreakdownDimension) => {
    setDimension(dim)
    void loadCharts(dateStart, dateEnd, dim)
  }

  /** 清理历史用量：days>0 清理 N 天前；days=0 清空全部。confirm 确认后 POST cleanup（对齐旧版 cleanupUsage 扩展） */
  const handleCleanup = async (all = false) => {
    const days = all ? 0 : Math.max(1, Math.min(365, parseInt(cleanupDays, 10) || CLEANUP_RETAIN_DAYS))
    const confirmed = await confirm(
      all
        ? t('admin.dashboard.usage.cleanupAllConfirm')
        : t('admin.dashboard.usage.cleanupConfirm', { days }),
    )
    if (!confirmed) return
    setCleaning(true)
    const res = await fetchJson<ApiRes<{ events: number; aggregates: number }>>('/api/admin/token-stats/cleanup', {
      method: 'POST',
      body: JSON.stringify(all ? { all: true } : { days }),
    }).catch((err) => {
      console.warn('[dashboard] 存储清理失败', err)
      return null
    })
    setCleaning(false)
    if (res?.success && res.data) {
      toast(
        t('admin.dashboard.usage.cleanupDone', { events: res.data.events, aggregates: res.data.aggregates }),
        'success',
      )
      void loadCharts(dateStart, dateEnd, dimension)
    } else {
      toast(t('admin.dashboard.usage.cleanupFailed'), 'error')
    }
  }

  // ──── 状态卡片（对齐旧版 stats getter）────
  const statCards = useMemo<StatCardSpec[]>(() => {
    const ok = !!health?.success
    const providers: ProviderEntry[] = config?.providers ?? []
    const models = providers.reduce((s, p) => s + (p.models?.length ?? 0), 0)
    const adapters: unknown[] = config?.adapters ?? []
    return [
      {
        label: t('admin.dashboard.status'),
        value: ok ? t('admin.common.normal') : t('admin.common.error'),
        icon: ok ? CircleCheck : CircleX,
        accent: ok ? 'success' : 'error',
        valueClass: ok ? 'text-success-emphasis' : 'text-error-emphasis',
      },
      { label: t('admin.dashboard.providerCount'), value: String(providers.length), icon: Server, accent: 'primary' },
      { label: t('admin.dashboard.modelCount'), value: String(models), icon: Grid3x3, accent: 'secondary' },
      { label: t('admin.dashboard.adapterCount'), value: String(adapters.length), icon: ArrowLeftRight, accent: 'info' },
    ]
  }, [config, health, t])

  // ──── 今日 token 卡片（对齐旧版 tokenCards getter 的语义与算式）────
  const tokenCards = useMemo<StatCardSpec[]>(() => {
    const ts = tokenStats?.today
    if (!ts) return []
    const inp = ts.input_tokens || 0
    const out = ts.output_tokens || 0
    const cr = ts.cache_read_input_tokens || 0
    const cc = ts.cache_creation_input_tokens || 0
    // DB 统一语义：inp = 计费部分（不含缓存），cr/cc 独立字段。
    // 卡片「输入」与趋势图输入线同口径（仅计费输入），避免缓存占主导时卡片与图表对不上；
    // 缓存流量由缓存命中率卡片与图表缓存读取/创建线表达。
    const totalTokens = inp + out + cr + cc
    const totalInput = inp
    return [
      { label: t('admin.dashboard.total'), value: fmtNum(totalTokens), icon: Stack, accent: 'primary' },
      {
        label: t('admin.dashboard.inputTokens'),
        value: fmtNum(totalInput),
        icon: Download,
        accent: 'info',
        valueClass: 'text-info-emphasis',
        desc: t('admin.dashboard.today'),
      },
      {
        label: t('admin.dashboard.output'),
        value: fmtNum(out),
        icon: Upload,
        accent: 'muted',
        desc: t('admin.dashboard.today'),
      },
      {
        // hitRate key 含旧版残留占位符 {{rate}}，传空串渲染为纯标签
        label: t('admin.dashboard.hitRate', { rate: '' }),
        value: pct(cr, totalTokens),
        icon: Bolt,
        accent: 'success',
        valueClass: 'text-success-emphasis',
        desc: t('admin.dashboard.today'),
      },
    ]
  }, [tokenStats, t])

  // 空态范围文案（对齐旧版 timelineEmpty/breakdownEmpty getter）
  const rangeText =
    presetDays > 0 ? `${presetDays} ${t('admin.dashboard.usage.daysUnit')}` : `${dateStart} ~ ${dateEnd}`
  const emptyDesc = t('admin.dashboard.usage.emptyDesc', { range: rangeText })

  const dateInputClass = 'w-34 text-xs'

  return (
    <div className="flex flex-col gap-3.5 p-6">
      {/* ── 状态卡片 ── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {statCards.map((card) => (
          <StatCard key={card.label} {...card} />
        ))}
      </div>

      {/* ── 今日 token 卡片（tokenStats 到达后显示，对齐旧版 x-show）── */}
      {tokenCards.length > 0 && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {tokenCards.map((card) => (
            <StatCard key={card.label} {...card} />
          ))}
        </div>
      )}

      {/* ── Token 用量趋势 ── */}
      <ChartCard
        icon={<ChartLine className="size-4" />}
        title={t('admin.dashboard.usage.trendTitle')}
        desc={t('admin.dashboard.usage.trendDesc')}
        toolbar={
          <div className="mb-2.5 flex flex-wrap items-center gap-1.5">
            <Input
              type="date"
              aria-label="startDate"
              value={dateStart}
              onChange={(e) => handleDateChange('start', e.target.value)}
              inputSize="sm"
              className={dateInputClass}
            />
            <span className="px-0.5 text-xs text-muted-foreground">—</span>
            <Input
              type="date"
              aria-label="endDate"
              value={dateEnd}
              onChange={(e) => handleDateChange('end', e.target.value)}
              inputSize="sm"
              className={dateInputClass}
            />
            <div className="ms-1 flex items-center gap-1" role="group" aria-label={t('admin.dashboard.usage.trendTitle')}>
              {[1, 7, 30, 90].map((v) => (
                <Button
                  key={v}
                  variant={presetDays === v ? 'primary' : 'outline'}
                  size="sm"
                  className="rounded-full px-3 text-[11.5px]"
                  onClick={() => handlePreset(v)}
                >
                  {t(`admin.dashboard.usage.days${v}`)}
                </Button>
              ))}
            </div>
          </div>
        }
      >
        <TimelineChart data={timeline} />
        {loadingCharts && <ChartLoading />}
        {!loadingCharts && timeline.length === 0 && <ChartEmpty icon={<TrendingDown className="size-7" />} desc={emptyDesc} />}
      </ChartCard>

      {/* ── 分维度对比（与趋势图共用日期范围）── */}
      <ChartCard
        icon={<TrendingUp className="size-4" />}
        title={t('admin.dashboard.usage.breakdownTitle')}
        toolbar={
          <div className="mb-2 flex flex-wrap items-center gap-1">
            <div className="flex items-center gap-1" role="group" aria-label={t('admin.dashboard.usage.breakdownTitle')}>
              {(['provider', 'adapter', 'model', 'adapterModel'] as const).map((d) => (
                <Button
                  key={d}
                  variant={dimension === d ? 'primary' : 'outline'}
                  size="sm"
                  className="rounded-full px-3 text-[11.5px]"
                  onClick={() => handleDimension(d)}
                >
                  {t(`admin.dashboard.usage.dim${d[0].toUpperCase()}${d.slice(1)}`)}
                </Button>
              ))}
            </div>
          </div>
        }
      >
        <BreakdownChart data={breakdown} />
        {loadingCharts && <ChartLoading />}
        {!loadingCharts && breakdown.length === 0 && <ChartEmpty icon={<ChartLine className="size-7" />} desc={emptyDesc} />}
      </ChartCard>

      {/* ── 用量数据存储 ── */}
      <section className="rounded-lg border border-border bg-background-subtle p-4 transition-colors duration-200 hover:border-border-strong">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="rounded-md bg-primary-soft p-1.5 text-primary-strong">
                <Database className="size-4" />
              </span>
              <h3 className="text-[13px] font-semibold text-foreground">
                {t('admin.dashboard.usage.storageTitle')}
              </h3>
            </div>
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
              {t('admin.dashboard.usage.storageDesc', {
                events: dbInfo.events,
                aggregates: dbInfo.aggregates,
                size: fmtBytes(dbInfo.sizeBytes),
              })}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Input
              type="number"
              min={1}
              max={365}
              value={cleanupDays}
              onChange={(e) => setCleanupDays(e.target.value)}
              inputSize="sm"
              className="w-20 text-end"
              aria-label={t('admin.dashboard.usage.daysUnit')}
            />
            <span className="text-[11px] text-muted-foreground">{t('admin.dashboard.usage.daysUnit')}</span>
            <Button
              variant="outline"
              size="sm"
              disabled={cleaning}
              onClick={() => void handleCleanup(false)}
            >
              <Trash className="size-3.5" />
              {cleaning ? t('admin.common.saving') : t('admin.dashboard.usage.cleanupBtn')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-error-emphasis hover:bg-error-soft"
              disabled={cleaning}
              onClick={() => void handleCleanup(true)}
            >
              <Trash className="size-3.5" />
              {t('admin.dashboard.usage.cleanupAllBtn')}
            </Button>
          </div>
        </div>
      </section>
    </div>
  )
}
