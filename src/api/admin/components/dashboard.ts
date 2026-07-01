import i18next from 'i18next'
import { Chart } from 'chart.js'
import {
  buildTimelineConfig,
  buildBreakdownConfig,
  type TimelinePoint,
  type UsageBucket,
} from './usage-charts.js'

interface DbInfo {
  events: number; aggregates: number; sizeBytes: number
}

/** 今天往前 N 天，返回 YYYY-MM-DD */
function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

export function dashboardPage() {
  const store = () => (window as any).Alpine.store('app')
  const fetchJson = () => store().fetch

  function fmtNum(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
    return String(n)
  }
  function fmtBytes(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + ' MB'
    if (n >= 1_000) return (n / 1_000).toFixed(1) + ' KB'
    return n + ' B'
  }
  function pct(n: number, total: number): string {
    if (!total) return '0%'
    return ((n / total) * 100).toFixed(1) + '%'
  }
  const t = (key: string, opts?: Record<string, unknown>) => i18next.t(key, opts)

  const todayStr = new Date().toISOString().slice(0, 10)

  return {
    // ──── 日期范围 ────
    dateStart: daysAgo(30) as string,
    dateEnd: todayStr as string,
    presetDays: 30 as number, // 快捷按钮用的天数（0 = 自定义）

    // ──── Chart 数据 ────
    timeline: [] as TimelinePoint[],
    breakdown: [] as UsageBucket[],
    dbInfo: { events: 0, aggregates: 0, sizeBytes: 0 } as DbInfo,
    loadingCharts: false,
    cleaning: false,

    // ──── 维度 ────
    breakdownDimension: 'provider' as 'provider' | 'adapter' | 'model',

    // ──── Chart 实例引用 ────
    _tl: null as Chart | null,
    _bd: null as Chart | null,
    _poll: null as ReturnType<typeof setInterval> | null,

    // ═══════════════════════════════════════
    // 生命周期
    // ═══════════════════════════════════════
    init() {
      this.ensureCharts()
      this.loadCharts()
      this._poll = setInterval(() => this.refreshToday(), 30_000)
    },

    destroy() {
      this._tl?.destroy(); this._tl = null
      this._bd?.destroy(); this._bd = null
      if (this._poll) { clearInterval(this._poll); this._poll = null }
    },

    /** 只刷新今日 stats（轻量），不重绘图表 */
    async refreshToday() {
      const res = await fetchJson()('/admin/token-stats').catch(() => null)
      if (res?.data) store().tokenStats = res.data
    },

    // ═══════════════════════════════════════
    // 数据加载
    // ═══════════════════════════════════════
    async loadCharts() {
      this.loadingCharts = true

      // timeline + breakdown 共用同一对 startDate/endDate（预设天数会同步到 dateStart/dateEnd）
      // 不再用 range=${days}d — 后端白名单只有 today/7d/30d/all，presetDays=1 会变 range=1d 被拒
      const tlUrl = `/admin/token-stats/timeline?startDate=${this.dateStart}&endDate=${this.dateEnd}`
      const bdUrl = `/admin/token-stats/breakdown?dimension=${this.breakdownDimension}&startDate=${this.dateStart}&endDate=${this.dateEnd}`

      const [tlRes, bdRes, dbRes] = await Promise.all([
        fetchJson()(tlUrl).catch(() => null),
        fetchJson()(bdUrl).catch(() => null),
        fetchJson()('/admin/token-stats/db-info').catch(() => null),
      ])
      this.timeline = tlRes?.data ?? []
      this.breakdown = bdRes?.data ?? []
      this.dbInfo = dbRes?.data ?? this.dbInfo
      this.loadingCharts = false

      await (window as any).Alpine.nextTick()
      this.renderCharts()
    },

    // ═══════════════════════════════════════
    // Chart 管理
    // ═══════════════════════════════════════
    ensureCharts() {
      // 等数据到达再创建 chart：避免空 data → Chart.js 锁定 Y scale 0-1，后续填充数据后 Y scale 不会重算
      if (this.timeline.length > 0 && !this._tl) {
        const tlCanvas = document.getElementById('chart-timeline') as HTMLCanvasElement | null
        if (tlCanvas) {
          Chart.getChart(tlCanvas)?.destroy()
          this._tl = new Chart(tlCanvas, buildTimelineConfig(this.timeline))
        }
      }
      if (this.breakdown.length > 0 && !this._bd) {
        const bdCanvas = document.getElementById('chart-breakdown') as HTMLCanvasElement | null
        if (bdCanvas) {
          Chart.getChart(bdCanvas)?.destroy()
          this._bd = new Chart(bdCanvas, buildBreakdownConfig(this.breakdownDimension, this.breakdown))
        }
      }
    },

    renderCharts() {
      this.ensureCharts()
      this._updateTimeline()
      this._updateBreakdown()
    },

    _updateTimeline() {
      const ch = this._tl
      const canvas = ch?.canvas as HTMLCanvasElement | undefined
      if (!ch || !canvas?.isConnected) { this._tl = null; this.ensureCharts(); return }
      const cfg = buildTimelineConfig(this.timeline)
      ch.data.labels = cfg.data.labels
      ch.data.datasets.forEach((ds: any, i: number) => {
        const nd = cfg.data.datasets[i]
        if (!nd) return
        ds.data = nd.data
        ds.pointRadius = nd.pointRadius
      })
      // 不修改 ch.options.scales — 复制 scale config 包含 ticks.callback 引用，
      // Chart.js 在 update 时会按 _scriptable 代理处理，触发 Recursion detected
      // scale 上限让 Chart.js 根据新 data 自动重算（dataMax 变 → suggestedMax 跟着变）
      try { ch.update('none') } catch { this._tl = null }
    },

    _updateBreakdown() {
      const ch = this._bd
      const canvas = ch?.canvas as HTMLCanvasElement | undefined
      if (!ch || !canvas?.isConnected) { this._bd = null; this.ensureCharts(); return }
      const cfg = buildBreakdownConfig(this.breakdownDimension, this.breakdown)
      ch.data.labels = cfg.data.labels
      ch.data.datasets.forEach((ds: any, i: number) => {
        const nd = cfg.data.datasets[i]
        if (!nd) return
        ds.data = nd.data
        ds.backgroundColor = nd.backgroundColor
      })
      // 不修改 ch.options.scales（同上原因，避免 _scriptable 循环）
      try { ch.update('none') } catch { this._bd = null }
    },

    // ═══════════════════════════════════════
    // 用户操作
    // ═══════════════════════════════════════
    setPreset(days: number) {
      this.presetDays = days
      this.dateStart = daysAgo(days - 1)
      this.dateEnd = todayStr
      this.loadCharts()
    },

    setCustomDate() {
      this.presetDays = 0
      if (!this.dateStart || !this.dateEnd) return
      if (this.dateStart > this.dateEnd) {
        [this.dateStart, this.dateEnd] = [this.dateEnd, this.dateStart]
      }
      this.loadCharts()
    },

    setBreakdownDim(dim: string) {
      this.breakdownDimension = dim as any
      this.loadCharts()
    },

    async cleanupUsage() {
      const days = 90
      if (!window.confirm(t('admin.dashboard.usage.cleanupConfirm', { days }))) return
      this.cleaning = true
      const res = await fetchJson()('/admin/token-stats/cleanup', {
        method: 'POST', body: JSON.stringify({ days }),
      }).catch(() => null)
      this.cleaning = false
      if (res?.success) {
        store().toast(t('admin.dashboard.usage.cleanupDone', { events: res.data.events, aggregates: res.data.aggregates }), 'success')
        this.loadCharts()
      } else {
        store().toast(t('admin.dashboard.usage.cleanupFailed'), 'error')
      }
    },

    // ═══════════════════════════════════════
    // Getters（HTML 模板用）
    // ═══════════════════════════════════════
    get stats() {
      const ok = store().health?.success
      const providers = store().config?.providers ?? []
      const models = providers.reduce((s: number, p: any) => s + (p.models?.length ?? 0), 0)
      const adapters = store().config?.adapters ?? []
      const tt = t
      return [
        { label: tt('admin.dashboard.status'), value: ok ? tt('admin.common.normal') : tt('admin.common.error'), clr: ok ? 'var(--success)' : 'var(--danger)', icon: ok ? '✓' : '✕', accent: ok ? 'var(--success)' : 'var(--danger)' },
        { label: tt('admin.dashboard.providerCount'), value: providers.length, clr: 'var(--text)', icon: '◉', accent: 'var(--accent)' },
        { label: tt('admin.dashboard.modelCount'), value: models, clr: 'var(--text)', icon: '▣', accent: '#8b5cf6' },
        { label: tt('admin.dashboard.adapterCount'), value: adapters.length, clr: 'var(--text)', icon: '⇄', accent: '#0ea5e9' },
      ]
    },

    /** 各图表的空态文案供 HTML 模板使用 */
    get timelineEmpty() {
      const preset = this.presetDays > 0 ? this.presetDays : null
      const range = preset ? `${preset} ${t('admin.dashboard.usage.daysUnit')}` : `${this.dateStart} ~ ${this.dateEnd}`
      return { icon: '📉', title: t('admin.dashboard.usage.emptyTitle'), desc: t('admin.dashboard.usage.emptyDesc', { range }) }
    },
    get breakdownEmpty() {
      const preset = this.presetDays > 0 ? this.presetDays : null
      const range = preset ? `${preset} ${t('admin.dashboard.usage.daysUnit')}` : `${this.dateStart} ~ ${this.dateEnd}`
      return { icon: '📊', title: t('admin.dashboard.usage.emptyTitle'), desc: t('admin.dashboard.usage.emptyDesc', { range }) }
    },

    get tokenCards() {
      const ts = store().tokenStats?.today
      if (!ts) return []
      const inp = ts.input_tokens || 0
      const out = ts.output_tokens || 0
      const cr = ts.cache_read_input_tokens || 0
      const cc = ts.cache_creation_input_tokens || 0
      const total = inp + out
      const totalTokens = inp + out + cr + cc
      const cacheHitRate = totalTokens > 0 ? pct(cr, totalTokens) : '0%'
      const tt = t
      return [
        { label: tt('admin.dashboard.requests'), value: ts.request_count || 0, clr: 'var(--text)', desc: tt('admin.dashboard.today'), icon: '↑↓', accent: 'var(--text-muted)' },
        { label: tt('admin.dashboard.inputTokens'), value: fmtNum(inp), clr: 'var(--accent)', desc: `${tt('admin.dashboard.output')} ${fmtNum(out)} / ${tt('admin.dashboard.total')} ${fmtNum(total)}`, icon: '◈', accent: 'var(--accent)' },
        { label: tt('admin.dashboard.cacheHits'), value: fmtNum(cr), clr: 'var(--success)', desc: tt('admin.dashboard.hitRate', { rate: cacheHitRate }), icon: '⚡', accent: 'var(--success)' },
        { label: tt('admin.dashboard.cacheCreation'), value: fmtNum(cc), clr: 'var(--warn)', desc: tt('admin.dashboard.newCacheTokens'), icon: '✷', accent: 'var(--warn)' },
      ]
    },

    get dimOptions() { return ['provider', 'adapter', 'model'].map(v => ({ v, l: t(`admin.dashboard.usage.dim${v[0].toUpperCase() + v.slice(1)}`) })) },
    get presets() { return [1, 7, 30, 90].map(v => ({ v, l: t(`admin.dashboard.usage.days${v}`) })) },

    fmtNum, fmtBytes,
  }
}