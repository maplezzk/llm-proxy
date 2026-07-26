import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { fmtK } from './TimelineChart'

export interface UsageBucket {
  key: string
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  request_count: number
}

interface BreakdownRow extends UsageBucket {
  /** Y 轴展示名（超 11 字符截断，tooltip 显示全名） */
  label: string
}

const COLORS = {
  input: 'var(--info-emphasis)',
  output: 'var(--secondary-emphasis)',
}

/** 最多展示条目数（对齐旧版 sorted.slice(0, 12)） */
const TOP_N = 12

/** 截断过长 key（>22 字符保留前 21 + …；tooltip 始终显示全名） */
function truncateKey(k: string, max = 22): string {
  if (k.length <= max) return k
  return k.slice(0, max - 1) + '…'
}

/**
 * 自定义 tooltip — 对齐旧版：标题=完整 key 名（不受 Y 轴截断影响），
 * 每行 series 值 toLocaleString，尾部 Total（四类 token 合计）+ Requests。
 */
function BreakdownTooltip({
  active,
  payload,
}: {
  active?: boolean
  payload?: ReadonlyArray<{ name?: string | number; value?: number | string; color?: string; payload?: BreakdownRow }>
}) {
  const { t } = useTranslation()
  if (!active || !payload || payload.length === 0) return null
  const row = payload[0].payload
  if (!row) return null
  const total = row.input_tokens + row.output_tokens + row.cache_read_input_tokens + row.cache_creation_input_tokens
  return (
    <div className="rounded-lg border border-border-strong bg-background-inverse px-3 py-2 text-[11px] shadow-md">
      <p className="mb-1 max-w-56 break-all text-xs font-bold text-foreground-inverse">{row.key}</p>
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
        <p>{t('admin.dashboard.chart.requests')}: {row.request_count.toLocaleString()}</p>
      </div>
    </div>
  )
}

/**
 * 分维度堆叠横向柱状图 — input + output 堆叠。
 * 移植自旧版 buildBreakdownConfig：
 * - 按 input+output 降序取前 12
 * - Y 轴 key 超 11 字符截断，tooltip 显示全名
 * - X 轴动态上限 dataMax*1.1（向上取整到千）
 */
export default function BreakdownChart({ data }: { data: UsageBucket[] }) {
  const { t } = useTranslation()
  const rows = useMemo<BreakdownRow[]>(
    () =>
      [...data]
        .sort((a, b) => b.input_tokens + b.output_tokens - (a.input_tokens + a.output_tokens))
        .slice(0, TOP_N)
        .map((b) => ({ ...b, label: truncateKey(b.key) })),
    [data],
  )

  const xMax = useMemo(() => {
    const dataMax = rows.reduce(
      (m, b) =>
        Math.max(m, b.input_tokens + b.output_tokens + b.cache_read_input_tokens + b.cache_creation_input_tokens),
      0,
    )
    return dataMax > 0 ? Math.ceil((dataMax * 1.1) / 1000) * 1000 : undefined
  }, [rows])

  return (
    <div className="flex h-full w-full flex-col">
      {/* 自定义 legend（右上，方形色块） */}
      <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 pb-1.5">
        <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="size-2.5 rounded-[3px]" style={{ background: COLORS.input }} />
          {t('admin.dashboard.chart.input')}
        </span>
        <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="size-2.5 rounded-[3px]" style={{ background: COLORS.output }} />
          {t('admin.dashboard.chart.output')}
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} layout="vertical" barSize={14} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--border-muted)" strokeDasharray="3 3" horizontal={false} />
            <XAxis
              type="number"
              domain={[0, xMax ?? 'auto']}
              tickFormatter={(v) => fmtK(v)}
              tick={{ fontSize: 10, fill: 'var(--foreground-muted)' }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              type="category"
              dataKey="label"
              width={170}
              interval={0}
              tick={{ fontSize: 11, fill: 'var(--foreground-muted)' }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip content={<BreakdownTooltip />} cursor={{ fill: 'var(--background-muted)', opacity: 0.5 }} />
            <Bar dataKey="input_tokens" name={t('admin.dashboard.chart.input')} stackId="a" fill={COLORS.input} radius={2} animationDuration={400} />
            <Bar dataKey="output_tokens" name={t('admin.dashboard.chart.output')} stackId="a" fill={COLORS.output} radius={2} animationDuration={400} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
