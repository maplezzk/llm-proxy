import i18next from 'i18next'
import { Chart } from 'chart.js'
import {
  buildTimelineConfig,
  buildBreakdownConfig,
  buildBreakdownPieConfig,
  buildProviderPieConfig,
  type TimelinePoint,
  type UsageBucket,
} from './usage-charts.js'

interface DbInfo {
  events: number
  aggregates: number
  sizeBytes: number
}

type BreakdownRange = 'today' | '7d' | '30d' | 'all'
type BreakdownDimension = 'provider' | 'adapter' | 'model'
type TimelineDays = 7 | 30 | 90

export function dashboardPage() {
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

  return {
    // ========== 数据状态 ==========
    timeline: [] as TimelinePoint[],
    timelineDays: 30 as TimelineDays,
    breakdown: [] as UsageBucket[],
    breakdownDimension: 'provider' as BreakdownDimension,
    breakdownRange: 'today' as BreakdownRange,
    dbInfo: { events: 0, aggregates: 0, sizeBytes: 0 } as DbInfo,
    loadingCharts: false,
    cleaning: false,

    // ========== Chart 实例 ==========
    _timelineChart: null as Chart | null,
    _breakdownChart: null as Chart | null,
    _pieChart: null as Chart | null,

    // ========== 生命周期 ==========
    init() {
      this.loadCharts()
      // 每次 dashboard 数据刷新时同步图表（每 10 秒一次）
      // 这里订阅 store 的 tokenStats 变化不优雅，改成在外部 store 主动调用
      const store = (window as any).Alpine.store('app')
      const orig = store.loadDashboard.bind(store)
      store.loadDashboard = async () => {
        await orig()
        // dashboard 刷新后重新拉图表（轻量查询）
        this.loadCharts()
      }
    },

    destroy() {
      this._timelineChart?.destroy()
      this._breakdownChart?.destroy()
      this._pieChart?.destroy()
      this._timelineChart = null
      this._breakdownChart = null
      this._pieChart = null
    },

    // ========== 数据加载 ==========
    async loadCharts() {
      this.loadingCharts = true
      const fetchJson = (window as any).Alpine.store('app').fetch
      const [timelineRes, breakdownRes, dbInfoRes] = await Promise.all([
        fetchJson(`/admin/token-stats/timeline?days=${this.timelineDays}`).catch(() => null),
        fetchJson(`/admin/token-stats/breakdown?dimension=${this.breakdownDimension}&range=${this.breakdownRange}`).catch(() => null),
        fetchJson('/admin/token-stats/db-info').catch(() => null),
      ])
      this.timeline = timelineRes?.data ?? []
      this.breakdown = breakdownRes?.data ?? []
      this.dbInfo = dbInfoRes?.data ?? this.dbInfo
      this.loadingCharts = false
      // 等 DOM 更新完再渲染图表
      await (window as any).Alpine.nextTick()
      this.renderCharts()
    },

    renderCharts() {
      const today = (window as any).Alpine.store('app').tokenStats?.today
      this.renderTimelineChart()
      this.renderBreakdownChart()
      this.renderPieChart(today)
    },

    renderTimelineChart() {
      const canvas = document.getElementById('chart-timeline') as HTMLCanvasElement | null
      if (!canvas) return
      this._timelineChart?.destroy()
      this._timelineChart = new Chart(canvas, buildTimelineConfig(this.timeline))
    },

    renderBreakdownChart() {
      const canvas = document.getElementById('chart-breakdown') as HTMLCanvasElement | null
      if (!canvas) return
      this._breakdownChart?.destroy()
      this._breakdownChart = new Chart(canvas, buildBreakdownConfig(this.breakdownDimension, this.breakdown))
    },

    renderPieChart(today: any) {
      const canvas = document.getElementById('chart-pie') as HTMLCanvasElement | null
      if (!canvas) return
      this._pieChart?.destroy()
      // 饼图优先展示今日结构；如果今日为空但有 7d 数据，按当前范围展示 provider 占比
      if (today && (today.input_tokens + today.output_tokens) > 0) {
        this._pieChart = new Chart(canvas, buildBreakdownPieConfig(today))
      } else if (this.breakdown.length > 0 && this.breakdownDimension === 'provider') {
        this._pieChart = new Chart(canvas, buildProviderPieConfig(this.breakdown))
      } else {
        this._pieChart = new Chart(canvas, buildBreakdownPieConfig({
          input_tokens: 0, output_tokens: 0,
          cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
        }))
      }
    },

    // ========== 用户操作 ==========
    async setTimelineDays(days: TimelineDays) {
      this.timelineDays = days
      await this.loadCharts()
    },

    async setBreakdownDimension(dim: BreakdownDimension) {
      this.breakdownDimension = dim
      await this.loadCharts()
    },

    async setBreakdownRange(range: BreakdownRange) {
      this.breakdownRange = range
      await this.loadCharts()
    },

    async cleanupUsage() {
      const days = 90
      if (!window.confirm(t('admin.dashboard.usage.cleanupConfirm', { days }))) return
      this.cleaning = true
      const res = await (window as any).Alpine.store('app').fetch('/admin/token-stats/cleanup', {
        method: 'POST',
        body: JSON.stringify({ days }),
      }).catch(() => null)
      this.cleaning = false
      if (res?.success) {
        (window as any).Alpine.store('app').toast(
          t('admin.dashboard.usage.cleanupDone', { events: res.data.events, aggregates: res.data.aggregates }),
          'success'
        )
        await this.loadCharts()
      } else {
        (window as any).Alpine.store('app').toast(t('admin.dashboard.usage.cleanupFailed'), 'error')
      }
    },

    // ========== 现有 dashboard 卡片（保留） ==========
    get stats() {
      const store = (window as any).Alpine.store('app')
      const ok = store.health?.success
      const providers = store.config?.providers ?? []
      const modelCount = providers.reduce((s: number, p: any) => s + (p.models?.length ?? 0), 0)
      const adapters = store.config?.adapters ?? []
      return [
        { label: t('admin.dashboard.status'), value: ok ? t('admin.common.normal') : t('admin.common.error'), clr: ok ? 'var(--success)' : 'var(--danger)', icon: ok ? '✓' : '✕', accent: ok ? 'var(--success)' : 'var(--danger)' },
        { label: t('admin.dashboard.providerCount'), value: providers.length, clr: 'var(--text)', icon: '◉', accent: 'var(--accent)' },
        { label: t('admin.dashboard.modelCount'), value: modelCount, clr: 'var(--text)', icon: '▣', accent: '#8b5cf6' },
        { label: t('admin.dashboard.adapterCount'), value: adapters.length, clr: 'var(--text)', icon: '⇄', accent: '#0ea5e9' },
      ]
    },

    get tokenCards() {
      const store = (window as any).Alpine.store('app')
      const ts = store.tokenStats?.today
      if (!ts) return []
      const input = ts.input_tokens || 0
      const output = ts.output_tokens || 0
      const cacheRead = ts.cache_read_input_tokens || 0
      const cacheCreate = ts.cache_creation_input_tokens || 0
      const total = input + output
      const cacheHitRate = input > 0 ? pct(cacheRead, input) : '0%'
      return [
        { label: t('admin.dashboard.requests'), value: ts.request_count || 0, clr: 'var(--text)', desc: t('admin.dashboard.today'), icon: '↑↓', accent: 'var(--text-muted)' },
        { label: t('admin.dashboard.inputTokens'), value: fmtNum(input), clr: 'var(--accent)', desc: `${t('admin.dashboard.output')} ${fmtNum(output)} / ${t('admin.dashboard.total')} ${fmtNum(total)}`, icon: '◈', accent: 'var(--accent)' },
        { label: t('admin.dashboard.cacheHits'), value: fmtNum(cacheRead), clr: 'var(--success)', desc: t('admin.dashboard.hitRate', { rate: cacheHitRate }), icon: '⚡', accent: 'var(--success)' },
        { label: t('admin.dashboard.cacheCreation'), value: fmtNum(cacheCreate), clr: 'var(--warn)', desc: t('admin.dashboard.newCacheTokens'), icon: '✷', accent: 'var(--warn)' },
      ]
    },

    // ========== 图表辅助 ==========
    get breakdownDimensionOptions(): Array<{ value: BreakdownDimension; label: string }> {
      return [
        { value: 'provider', label: t('admin.dashboard.usage.dimProvider') },
        { value: 'adapter', label: t('admin.dashboard.usage.dimAdapter') },
        { value: 'model', label: t('admin.dashboard.usage.dimModel') },
      ]
    },

    get breakdownRangeOptions(): Array<{ value: BreakdownRange; label: string }> {
      return [
        { value: 'today', label: t('admin.dashboard.usage.rangeToday') },
        { value: '7d', label: t('admin.dashboard.usage.range7d') },
        { value: '30d', label: t('admin.dashboard.usage.range30d') },
        { value: 'all', label: t('admin.dashboard.usage.rangeAll') },
      ]
    },

    get timelineDaysOptions(): Array<{ value: TimelineDays; label: string }> {
      return [
        { value: 7, label: t('admin.dashboard.usage.days7') },
        { value: 30, label: t('admin.dashboard.usage.days30') },
        { value: 90, label: t('admin.dashboard.usage.days90') },
      ]
    },

    fmtNum,
    fmtBytes,
  }
}