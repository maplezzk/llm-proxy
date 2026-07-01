import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  BarController,
  BarElement,
  CategoryScale,
  LinearScale,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js'

Chart.register(
  LineController, LineElement, PointElement,
  BarController, BarElement,
  CategoryScale, LinearScale,
  Tooltip, Legend, Filler,
)

export interface TimelinePoint {
  date: string
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  request_count: number
}

export interface UsageBucket {
  key: string
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  request_count: number
}

const C = {
  input: '#3b82f6',
  output: '#8b5cf6',
  cacheRead: '#10b981',
  cacheCreate: '#f59e0b',
  text: '#cbd5e1',
  textMuted: '#94a3b8',
  border: 'rgba(148,163,184,0.15)',
}

const OPTS = {
  responsive: true,
  maintainAspectRatio: false,
  animation: false as const,
  events: ['mousemove', 'mouseout', 'click', 'touchstart', 'touchmove'] as string[],
  interaction: { mode: 'index' as const, intersect: false },
  hover: { mode: 'index' as const, intersect: false },
}

function fmtK(v: number | string): string {
  const n = Number(v)
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

/** Y 轴刻度回调 — input 数 轴（堆叠横向柱状图） */
function fmtAxisK(v: number | string): string {
  return fmtK(v)
}

/** 截断过长 key，>=12 字符保留前 9 + '…' */
function truncateKey(k: string, max = 11): string {
  if (k.length <= max) return k
  return k.slice(0, max - 1) + '…'
}

/**
 * 折线图 — input/output/cache read/cache create 四条线，纯线不填充避免颜色叠加混乱。
 * tooltip 充实（日期 / 4 series / 合计 / 请求数），Y 轴动态上限避免尖峰压制细节。
 */
export function buildTimelineConfig(timeline: TimelinePoint[]): any {
  const labels = timeline.map(p => p.date.slice(5))
  // 动态上限：dataMax * 1.1，避免尖峰刚好贴顶，也不压制其它天细节
  const dataMax = timeline.reduce((m, p) => {
    const dayMax = Math.max(p.input_tokens, p.output_tokens, p.cache_read_input_tokens, p.cache_creation_input_tokens)
    return dayMax > m ? dayMax : m
  }, 0)
  return {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Input', data: timeline.map(p => p.input_tokens),
          borderColor: C.input, borderWidth: 2,
          fill: false, tension: 0.35, pointRadius: timeline.length > 60 ? 0 : 2, pointHoverRadius: 4,
        },
        {
          label: 'Output', data: timeline.map(p => p.output_tokens),
          borderColor: C.output, borderWidth: 2,
          fill: false, tension: 0.35, pointRadius: timeline.length > 60 ? 0 : 2, pointHoverRadius: 4,
        },
        {
          label: 'Cache Read', data: timeline.map(p => p.cache_read_input_tokens),
          borderColor: C.cacheRead, borderWidth: 1.5, borderDash: [4, 3],
          fill: false, tension: 0.35, pointRadius: timeline.length > 60 ? 0 : 2, pointHoverRadius: 4,
        },
        {
          label: 'Cache Create', data: timeline.map(p => p.cache_creation_input_tokens),
          borderColor: C.cacheCreate, borderWidth: 1.5, borderDash: [2, 2],
          fill: false, tension: 0.35, pointRadius: timeline.length > 60 ? 0 : 2, pointHoverRadius: 4,
        },
      ],
    },
    options: {
      ...OPTS,
      plugins: {
        legend: {
          position: 'top', align: 'end',
          labels: {
            color: C.text, boxWidth: 16, boxHeight: 2, padding: 12,
            font: { size: 11 },
            // Cache 全为 0 时隐藏对应 legend 项，避免误导
            generateLabels: (chart: any) => {
              const base = Chart.defaults.plugins.legend.labels.generateLabels(chart)
              return base.filter((item: any) => {
                const ds = chart.data.datasets[item.datasetIndex]
                const sum = (ds.data as number[]).reduce((s, v) => s + (v || 0), 0)
                return sum > 0
              })
            },
          },
        },
        tooltip: {
          backgroundColor: '#1e293b', titleColor: C.text, bodyColor: C.text,
          borderColor: C.border, borderWidth: 1, padding: 10,
          titleFont: { size: 12, weight: 'bold' },
          bodyFont: { size: 11 },
          callbacks: {
            title: (items: any[]) => {
              const idx = items[0]?.dataIndex
              return idx !== undefined ? (timeline[idx]?.date ?? '') : ''
            },
            label: (ctx: any) => `${ctx.dataset.label}: ${Number(ctx.parsed.y || 0).toLocaleString()}`,
            afterBody: (items: any[]) => {
              const idx = items[0]?.dataIndex
              if (idx === undefined) return []
              const p = timeline[idx]
              if (!p) return []
              const total = p.input_tokens + p.output_tokens + p.cache_read_input_tokens + p.cache_creation_input_tokens
              return ['', `Total: ${total.toLocaleString()}`, `Requests: ${p.request_count.toLocaleString()}`]
            },
          },
        },
      },
      scales: {
        x: {
          ticks: { color: C.textMuted, maxTicksLimit: 15, font: { size: 10 }, maxRotation: 0, autoSkipPadding: 12 },
          grid: { color: C.border, display: false },
        },
        y: {
          beginAtZero: true,
          suggestedMax: dataMax > 0 ? Math.ceil((dataMax * 1.1) / 1000) * 1000 : undefined,
          ticks: { color: C.textMuted, font: { size: 10 }, callback: fmtK, maxTicksLimit: 6 },
          grid: { color: C.border },
        },
      },
    },
  }
}

/**
 * 堆叠横向柱状图 — input + output 堆叠，Y 轴 key 超过 11 字符截断（tooltip 显示全名）
 */
export function buildBreakdownConfig(
  _dimension: string,
  buckets: UsageBucket[]
): any {
  const sorted = [...buckets]
    .sort((a, b) => (b.input_tokens + b.output_tokens) - (a.input_tokens + a.output_tokens))
    .slice(0, 12)
  const dataMax = sorted.reduce((m, b) => {
    const t = b.input_tokens + b.output_tokens + b.cache_read_input_tokens + b.cache_creation_input_tokens
    return t > m ? t : m
  }, 0)
  const cfg: any = {
    type: 'bar',
    data: {
      labels: sorted.map(b => truncateKey(b.key)),
      datasets: [
        {
          label: 'Input', data: sorted.map(b => b.input_tokens),
          backgroundColor: C.input, stack: 'a',
          borderRadius: 2,
        },
        {
          label: 'Output', data: sorted.map(b => b.output_tokens),
          backgroundColor: C.output, stack: 'a',
          borderRadius: 2,
        },
      ],
    },
    options: {
      ...OPTS,
      indexAxis: 'y',
      plugins: {
        legend: { position: 'top', align: 'end', labels: { color: C.text, boxWidth: 12, font: { size: 11 }, padding: 12 } },
        tooltip: {
          backgroundColor: '#1e293b', titleColor: C.text, bodyColor: C.text,
          borderColor: C.border, borderWidth: 1, padding: 10,
          titleFont: { size: 12, weight: 'bold' },
          bodyFont: { size: 11 },
          callbacks: {
            title: (items: any[]) => {
              // 显示完整 key 名（不受 Y 轴 label 截断影响）
              const idx = items[0]?.dataIndex
              if (idx === undefined) return ''
              return sorted[idx]?.key ?? ''
            },
            label: (ctx: any) => `${ctx.dataset.label}: ${Number(ctx.parsed.x || 0).toLocaleString()}`,
            afterBody: (items: any[]) => {
              const idx = items[0]?.dataIndex
              if (idx === undefined) return []
              const b = sorted[idx]
              if (!b) return []
              const total = b.input_tokens + b.output_tokens + b.cache_read_input_tokens + b.cache_creation_input_tokens
              return ['', `Total: ${total.toLocaleString()}`, `Requests: ${b.request_count.toLocaleString()}`]
            },
          },
        },
      },
      scales: {
        x: {
          stacked: true, beginAtZero: true,
          suggestedMax: dataMax > 0 ? Math.ceil((dataMax * 1.1) / 1000) * 1000 : undefined,
          ticks: { color: C.textMuted, font: { size: 10 }, callback: fmtAxisK, maxTicksLimit: 6 },
          grid: { color: C.border },
        },
        y: {
          type: 'category',
          stacked: true,
          ticks: {
            color: C.textMuted, font: { size: 11 },
            autoSkip: false,
          },
          grid: { display: false },
        },
      },
    },
  }
  return cfg
}



