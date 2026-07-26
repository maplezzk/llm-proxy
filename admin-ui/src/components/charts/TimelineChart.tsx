import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

export interface TimelinePoint {
  date: string
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  request_count: number
}

interface SeriesDef {
  key: 'input_tokens' | 'output_tokens' | 'cache_read_input_tokens' | 'cache_creation_input_tokens'
  label: string
  color: string
  width: number
  dash?: string
}

/**
 * 四色对齐旧版 Chart.js 配色语义（蓝/紫/绿/橙），改用 Appica 主题 token，
 * emphasis 档在明暗两套主题下均保持足够对比度。
 * Cache Read/Create 沿用旧版虚线区分（4-3 / 2-2）。
 * label 为 i18n key（admin.dashboard.chart.*），组件内用 t() 解析。
 */
const SERIES: SeriesDef[] = [
  { key: 'input_tokens', label: 'input', color: 'var(--info-emphasis)', width: 2 },
  { key: 'output_tokens', label: 'output', color: 'var(--secondary-emphasis)', width: 2 },
  { key: 'cache_read_input_tokens', label: 'cacheRead', color: 'var(--success-emphasis)', width: 1.5, dash: '4 3' },
  { key: 'cache_creation_input_tokens', label: 'cacheCreate', color: 'var(--warning-emphasis)', width: 1.5, dash: '2 2' },
]

/** 数值缩写（对齐旧版 fmtK）：>=1M → xM，>=1K → xK */
export function fmtK(v: number | string): string {
  const n = Number(v)
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

/**
 * 自定义 tooltip — 对齐旧版 Chart.js callbacks：
 * 标题=完整日期；每行 series 名 + toLocaleString 数值；
 * 尾部 Total（四类 token 合计）+ Requests。
 */
function TimelineTooltip({
  active,
  payload,
}: {
  active?: boolean
  payload?: ReadonlyArray<{ name?: string | number; value?: number | string; color?: string; payload?: TimelinePoint }>
}) {
  const { t } = useTranslation()
  if (!active || !payload || payload.length === 0) return null
  const point = payload[0].payload
  if (!point) return null
  const total =
    point.input_tokens + point.output_tokens + point.cache_read_input_tokens + point.cache_creation_input_tokens
  return (
    <div className="rounded-lg border border-border-strong bg-background-inverse px-3 py-2 text-[11px] shadow-md">
      <p className="mb-1 text-xs font-bold text-foreground-inverse">{point.date}</p>
      {payload.map((entry, i) => (
        <p key={i} className="flex items-center gap-1.5 text-foreground-inverse/85">
          <span className="size-2 shrink-0 rounded-full" style={{ background: entry.color }} />
          <span>
            {entry.name}: {fmtK(Number(entry.value ?? 0))}
          </span>
        </p>
      ))}
      <div className="mt-1 border-t border-foreground-inverse/20 pt-1 text-foreground-inverse/85">
        <p>{t('admin.dashboard.chart.total')}: {fmtK(total)}</p>
        <p>{t('admin.dashboard.chart.requests')}: {point.request_count.toLocaleString()}</p>
      </div>
    </div>
  )
}

/**
 * Token 用量时间线折线图 — input/output/cacheRead/cacheCreate 四条线。
 * 移植自旧版 usage-charts.ts buildTimelineConfig：
 * - 纯线不填充；cache 两线虚线；点数 >60 隐藏圆点
 * - Y 轴动态上限 dataMax*1.1（向上取整到千），避免尖峰贴顶
 * - legend 过滤全 0 series（对齐旧版 generateLabels 行为，cache 全 0 时不误导）
 */
export default function TimelineChart({ data }: { data: TimelinePoint[] }) {
  const { t } = useTranslation()
  // 全 0 series 不进 legend
  const visibleSeries = useMemo(() => {
    return SERIES.filter((s) => data.some((p) => (p[s.key] || 0) > 0))
  }, [data])

  const yMax = useMemo(() => {
    const dataMax = data.reduce(
      (m, p) =>
        Math.max(m, p.input_tokens, p.output_tokens, p.cache_read_input_tokens, p.cache_creation_input_tokens),
      0,
    )
    return dataMax > 0 ? Math.ceil((dataMax * 1.1) / 1000) * 1000 : undefined
  }, [data])

  const showDots = data.length <= 60

  return (
    <div className="flex h-full w-full flex-col">
      {/* 自定义 legend（右上，对齐旧版 position:top align:end） */}
      <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 pb-1.5">
        {visibleSeries.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="h-0.5 w-4 rounded-full" style={{ background: s.color }} />
            {t(`admin.dashboard.chart.${s.label}`)}
          </span>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--border-muted)" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="date"
              tickFormatter={(v) => String(v).slice(5)}
              tick={{ fontSize: 10, fill: 'var(--foreground-muted)' }}
              axisLine={{ stroke: 'var(--border-muted)' }}
              tickLine={false}
              minTickGap={16}
            />
            <YAxis
              domain={[0, yMax ?? 'auto']}
              tickFormatter={(v) => fmtK(v)}
              tick={{ fontSize: 10, fill: 'var(--foreground-muted)' }}
              axisLine={false}
              tickLine={false}
              width={40}
            />
            <Tooltip
              content={<TimelineTooltip />}
              cursor={{ stroke: 'var(--border-strong)', strokeDasharray: '3 3' }}
            />
            {SERIES.map((s) => (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={t(`admin.dashboard.chart.${s.label}`)}
                stroke={s.color}
                strokeWidth={s.width}
                strokeDasharray={s.dash}
                dot={showDots ? { r: 2, strokeWidth: 0, fill: s.color } : false}
                activeDot={{ r: 4 }}
                animationDuration={400}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
