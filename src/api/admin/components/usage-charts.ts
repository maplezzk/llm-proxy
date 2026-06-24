import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  BarController,
  BarElement,
  DoughnutController,
  ArcElement,
  CategoryScale,
  LinearScale,
  Tooltip,
  Legend,
  Filler,
  type ChartConfiguration,
} from 'chart.js'

// Tree-shake 友好：只注册用到的 controllers + elements + plugins
Chart.register(
  LineController, LineElement, PointElement,
  BarController, BarElement,
  DoughnutController, ArcElement,
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

/**
 * 主题色：与 admin-ui.html 的 CSS 变量保持一致
 */
const COLORS = {
  input: '#3b82f6',        // var(--accent) - 蓝色
  output: '#8b5cf6',       // 紫色
  cacheRead: '#10b981',    // var(--success) - 绿色
  cacheCreate: '#f59e0b',  // var(--warn) - 橙色
  text: '#cbd5e1',
  textMuted: '#94a3b8',
  border: 'rgba(148, 163, 184, 0.15)',
}

const PROVIDER_PALETTE = [
  '#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#ec4899',
  '#06b6d4', '#f43f5e', '#a855f7', '#22c55e', '#eab308',
]

/**
 * 30 天趋势折线图配置：输入/输出/缓存命中/缓存创建 4 条线
 */
export function buildTimelineConfig(timeline: TimelinePoint[]): ChartConfiguration<'line'> {
  const labels = timeline.map(p => p.date.slice(5))  // MM-DD
  return {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Input',
          data: timeline.map(p => p.input_tokens),
          borderColor: COLORS.input,
          backgroundColor: COLORS.input + '20',
          tension: 0.3,
          fill: false,
          pointRadius: timeline.length > 60 ? 0 : 2,
        },
        {
          label: 'Output',
          data: timeline.map(p => p.output_tokens),
          borderColor: COLORS.output,
          backgroundColor: COLORS.output + '20',
          tension: 0.3,
          fill: false,
          pointRadius: timeline.length > 60 ? 0 : 2,
        },
        {
          label: 'Cache Read',
          data: timeline.map(p => p.cache_read_input_tokens),
          borderColor: COLORS.cacheRead,
          backgroundColor: COLORS.cacheRead + '20',
          tension: 0.3,
          fill: false,
          pointRadius: timeline.length > 60 ? 0 : 2,
        },
        {
          label: 'Cache Create',
          data: timeline.map(p => p.cache_creation_input_tokens),
          borderColor: COLORS.cacheCreate,
          backgroundColor: COLORS.cacheCreate + '20',
          tension: 0.3,
          fill: false,
          pointRadius: timeline.length > 60 ? 0 : 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'top',
          labels: { color: COLORS.text, boxWidth: 12, font: { size: 11 } },
        },
        tooltip: {
          backgroundColor: '#1e293b',
          titleColor: COLORS.text,
          bodyColor: COLORS.text,
          borderColor: COLORS.border,
          borderWidth: 1,
        },
      },
      scales: {
        x: {
          ticks: { color: COLORS.textMuted, maxTicksLimit: 15, font: { size: 10 } },
          grid: { color: COLORS.border },
        },
        y: {
          beginAtZero: true,
          ticks: {
            color: COLORS.textMuted,
            font: { size: 10 },
            callback: (v) => {
              const n = Number(v)
              if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
              if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
              return String(n)
            },
          },
          grid: { color: COLORS.border },
        },
      },
    },
  }
}

/**
 * 按供应商/适配器/模型分桶柱状图：横向柱状，按 input_tokens 排序
 */
export function buildBreakdownConfig(
  dimension: 'provider' | 'adapter' | 'model',
  buckets: UsageBucket[]
): ChartConfiguration<'bar'> {
  const sorted = [...buckets].sort((a, b) => b.input_tokens - a.input_tokens).slice(0, 10)
  const labels = sorted.map(b => b.key)
  return {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Input',
          data: sorted.map(b => b.input_tokens),
          backgroundColor: COLORS.input,
        },
        {
          label: 'Output',
          data: sorted.map(b => b.output_tokens),
          backgroundColor: COLORS.output,
        },
        {
          label: 'Cache Read',
          data: sorted.map(b => b.cache_read_input_tokens),
          backgroundColor: COLORS.cacheRead,
        },
        {
          label: 'Cache Create',
          data: sorted.map(b => b.cache_creation_input_tokens),
          backgroundColor: COLORS.cacheCreate,
        },
      ],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'top',
          labels: { color: COLORS.text, boxWidth: 12, font: { size: 11 } },
        },
        tooltip: {
          backgroundColor: '#1e293b',
          titleColor: COLORS.text,
          bodyColor: COLORS.text,
          borderColor: COLORS.border,
          borderWidth: 1,
          callbacks: {
            afterBody: (items) => {
              const idx = items[0]?.dataIndex
              if (idx === undefined) return []
              const bucket = sorted[idx]
              return [`Requests: ${bucket.request_count.toLocaleString()}`]
            },
          },
        },
      },
      scales: {
        x: {
          stacked: false,
          beginAtZero: true,
          ticks: {
            color: COLORS.textMuted,
            font: { size: 10 },
            callback: (v) => {
              const n = Number(v)
              if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
              if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
              return String(n)
            },
          },
          grid: { color: COLORS.border },
        },
        y: {
          ticks: { color: COLORS.textMuted, font: { size: 11 } },
          grid: { display: false },
        },
      },
    },
  }
}

/**
 * 今日 token 结构饼图：input / output / cache_read / cache_create
 */
export function buildBreakdownPieConfig(today: {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}): ChartConfiguration<'doughnut'> {
  const data = [
    { label: 'Input', value: today.input_tokens, color: COLORS.input },
    { label: 'Output', value: today.output_tokens, color: COLORS.output },
    { label: 'Cache Read', value: today.cache_read_input_tokens, color: COLORS.cacheRead },
    { label: 'Cache Create', value: today.cache_creation_input_tokens, color: COLORS.cacheCreate },
  ]
  return {
    type: 'doughnut',
    data: {
      labels: data.map(d => d.label),
      datasets: [{
        data: data.map(d => d.value),
        backgroundColor: data.map(d => d.color),
        borderColor: '#1e293b',
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'right',
          labels: { color: COLORS.text, boxWidth: 12, font: { size: 11 } },
        },
        tooltip: {
          backgroundColor: '#1e293b',
          titleColor: COLORS.text,
          bodyColor: COLORS.text,
          borderColor: COLORS.border,
          borderWidth: 1,
          callbacks: {
            label: (ctx) => {
              const v = Number(ctx.parsed)
              const total = data.reduce((s, d) => s + d.value, 0)
              const pct = total > 0 ? ((v / total) * 100).toFixed(1) : '0'
              return `${ctx.label}: ${v.toLocaleString()} (${pct}%)`
            },
          },
        },
      },
    },
  }
}

/**
 * 按 provider 分组的环形图（每个供应商一个色块）
 */
export function buildProviderPieConfig(buckets: UsageBucket[]): ChartConfiguration<'doughnut'> {
  const data = buckets.map((b, i) => ({
    label: b.key,
    value: b.input_tokens + b.output_tokens,
    color: PROVIDER_PALETTE[i % PROVIDER_PALETTE.length],
  }))
  return {
    type: 'doughnut',
    data: {
      labels: data.map(d => d.label),
      datasets: [{
        data: data.map(d => d.value),
        backgroundColor: data.map(d => d.color),
        borderColor: '#1e293b',
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'right',
          labels: { color: COLORS.text, boxWidth: 12, font: { size: 11 } },
        },
        tooltip: {
          backgroundColor: '#1e293b',
          titleColor: COLORS.text,
          bodyColor: COLORS.text,
          borderColor: COLORS.border,
          borderWidth: 1,
          callbacks: {
            label: (ctx) => {
              const v = Number(ctx.parsed)
              const total = data.reduce((s, d) => s + d.value, 0)
              const pct = total > 0 ? ((v / total) * 100).toFixed(1) : '0'
              return `${ctx.label}: ${v.toLocaleString()} (${pct}%)`
            },
          },
        },
      },
    },
  }
}