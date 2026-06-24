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
} from 'chart.js'

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

/**
 * 面积折线图 — input/output/cache read/cache create 四条线，带渐变填充
 */
export function buildTimelineConfig(timeline: TimelinePoint[]): any {
  const labels = timeline.map(p => p.date.slice(5))
  return {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Input', data: timeline.map(p => p.input_tokens),
          borderColor: C.input, backgroundColor: C.input + '20',
          fill: { target: 'origin', above: C.input + '18' },
          tension: 0.35, pointRadius: timeline.length > 60 ? 0 : 2,
        },
        {
          label: 'Output', data: timeline.map(p => p.output_tokens),
          borderColor: C.output, backgroundColor: C.output + '20',
          fill: { target: 'origin', above: C.output + '18' },
          tension: 0.35, pointRadius: timeline.length > 60 ? 0 : 2,
        },
        {
          label: 'Cache Read', data: timeline.map(p => p.cache_read_input_tokens),
          borderColor: C.cacheRead, backgroundColor: C.cacheRead + '20',
          fill: { target: 'origin', above: C.cacheRead + '18' },
          tension: 0.35, pointRadius: timeline.length > 60 ? 0 : 2,
        },
        {
          label: 'Cache Create', data: timeline.map(p => p.cache_creation_input_tokens),
          borderColor: C.cacheCreate, backgroundColor: C.cacheCreate + '20',
          fill: { target: 'origin', above: C.cacheCreate + '18' },
          tension: 0.35, pointRadius: timeline.length > 60 ? 0 : 2,
        },
      ],
    },
    options: {
      ...OPTS,
      plugins: {
        legend: { position: 'top', labels: { color: C.text, boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          backgroundColor: '#1e293b', titleColor: C.text, bodyColor: C.text,
          borderColor: C.border, borderWidth: 1,
        },
      },
      scales: {
        x: { ticks: { color: C.textMuted, maxTicksLimit: 15, font: { size: 10 } }, grid: { color: C.border } },
        y: {
          beginAtZero: true,
          ticks: { color: C.textMuted, font: { size: 10 }, callback: fmtK },
          grid: { color: C.border },
        },
      },
    },
  }
}

/**
 * 堆叠横向柱状图 — input + output 堆叠
 */
export function buildBreakdownConfig(
  _dimension: string,
  buckets: UsageBucket[]
): any {
  const sorted = [...buckets]
    .sort((a, b) => (b.input_tokens + b.output_tokens) - (a.input_tokens + a.output_tokens))
    .slice(0, 12)
  return {
    type: 'bar',
    data: {
      labels: sorted.map(b => b.key),
      datasets: [
        {
          label: 'Input', data: sorted.map(b => b.input_tokens),
          backgroundColor: C.input, stack: 'a',
        },
        {
          label: 'Output', data: sorted.map(b => b.output_tokens),
          backgroundColor: C.output, stack: 'a',
        },
      ],
    },
    options: {
      ...OPTS,
      indexAxis: 'y',
      plugins: {
        legend: { position: 'top', labels: { color: C.text, boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          backgroundColor: '#1e293b', titleColor: C.text, bodyColor: C.text,
          borderColor: C.border, borderWidth: 1,
          callbacks: {
            afterBody: (items: any[]) => {
              const idx = items[0]?.dataIndex
              if (idx === undefined) return []
              return [`Requests: ${sorted[idx].request_count.toLocaleString()}`]
            },
          },
        },
      },
      scales: {
        x: { stacked: true, beginAtZero: true, ticks: { color: C.textMuted, font: { size: 10 }, callback: fmtK }, grid: { color: C.border } },
        y: { stacked: true, ticks: { color: C.textMuted, font: { size: 11 } }, grid: { display: false } },
      },
    },
  }
}

// =============================================
// Doughnut center-text plugin
// =============================================
export const doughnutCenterPlugin = {
  id: 'doughnutCenter',
  afterDraw(chart: Chart) {
    const { ctx, chartArea: { width, height, top, left } } = chart
    const meta = (chart as any).centerMeta
    if (!meta) return
    ctx.save()
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    // 主标题
    const cx = left + width / 2
    const cy = top + height / 2
    ctx.font = 'bold 18px -apple-system,BlinkMacSystemFont,sans-serif'
    ctx.fillStyle = C.text
    ctx.fillText(meta.total, cx, cy - 6)
    // 副标题
    ctx.font = '11px -apple-system,BlinkMacSystemFont,sans-serif'
    ctx.fillStyle = C.textMuted
    ctx.fillText(meta.label, cx, cy + 14)
    ctx.restore()
  },
}

Chart.register(doughnutCenterPlugin)

/**
 * 环形图 — input/output/cache read/cache create，中心文字
 */
export function buildBreakdownPieConfig(today: {
  input_tokens: number; output_tokens: number
  cache_read_input_tokens: number; cache_creation_input_tokens: number
}): any {
  const data = [
    { label: 'Input', value: today.input_tokens, color: C.input },
    { label: 'Output', value: today.output_tokens, color: C.output },
    { label: 'Cache Read', value: today.cache_read_input_tokens, color: C.cacheRead },
    { label: 'Cache Create', value: today.cache_creation_input_tokens, color: C.cacheCreate },
  ]
  const total = data.reduce((s, d) => s + d.value, 0)
  return {
    type: 'doughnut',
    data: {
      labels: data.map(d => d.label),
      datasets: [{
        data: data.map(d => d.value),
        backgroundColor: data.map(d => d.color),
        borderColor: '#1e293b', borderWidth: 2,
      }],
    },
    options: {
      ...OPTS,
      cutout: '65%',
      plugins: {
        legend: { position: 'right', labels: { color: C.text, boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          backgroundColor: '#1e293b', titleColor: C.text, bodyColor: C.text,
          borderColor: C.border, borderWidth: 1,
          callbacks: {
            label: (ctx: any) => {
              const v = Number(ctx.parsed)
              const pct = total > 0 ? ((v / total) * 100).toFixed(1) : '0'
              return `${ctx.label}: ${v.toLocaleString()} (${pct}%)`
            },
          },
        },
      },
    },
    // 写入自定义 meta 供 plugin 读取
    centerMeta: {
      total: total.toLocaleString(),
      label: '总计',
    },
  } as any
}
