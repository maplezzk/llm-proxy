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
      // 同步创建 3 个 chart 实例，避免后续 polling 反复 destroy+new 引发 ctx null race
      this.ensureCharts()
      this.loadCharts()
      // 每次 dashboard 数据刷新时同步图表（每 10 秒一次）
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

    /**
     * 确保 3 个 chart 实例存在。幂等：重复调用不会 destroy 已有实例。
     * 关键：第一次创建后，后续数据更新走 chart.update()，避免 destroy+new 导致的
     * animation frame race（Chart.js 内部 _update 跑到一半时 ctx 被清空 → TypeError）。
     *
     * 额外护栏：先用 Chart.getChart(canvas) 检查 Chart.js 全局缓存里是否已有实例
     * （避免 canvas DOM 被复用但全局实例未清理时报 'Canvas is already in use'）。
     */
    ensureCharts() {
      const tlCanvas = document.getElementById('chart-timeline') as HTMLCanvasElement | null
      if (tlCanvas && !this._timelineChart) {
        const existing = Chart.getChart(tlCanvas)
        if (existing) {
          this._timelineChart = existing
        } else {
          this._timelineChart = new Chart(tlCanvas, buildTimelineConfig(this.timeline))
        }
      }
      const bdCanvas = document.getElementById('chart-breakdown') as HTMLCanvasElement | null
      if (bdCanvas && !this._breakdownChart) {
        const existing = Chart.getChart(bdCanvas)
        if (existing) {
          this._breakdownChart = existing
        } else {
          this._breakdownChart = new Chart(bdCanvas, buildBreakdownConfig(this.breakdownDimension, this.breakdown))
        }
      }
      const pieCanvas = document.getElementById('chart-pie') as HTMLCanvasElement | null
      if (pieCanvas && !this._pieChart) {
        const existing = Chart.getChart(pieCanvas)
        if (existing) {
          this._pieChart = existing
        } else {
          const today = (window as any).Alpine.store('app').tokenStats?.today
          if (today && (today.input_tokens + today.output_tokens) > 0) {
            this._pieChart = new Chart(pieCanvas, buildBreakdownPieConfig(today))
          } else {
            this._pieChart = new Chart(pieCanvas, buildBreakdownPieConfig({
              input_tokens: 0, output_tokens: 0,
              cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
            }))
          }
        }
      }
    },

    renderCharts() {
      const today = (window as any).Alpine.store('app').tokenStats?.today
      // canvas 可能已被替换（如 x-if 切换），重新创建（仅限实例不存在的情况）
      this.ensureCharts()
      this.updateTimelineChart()
      this.updateBreakdownChart()
      this.updatePieChart(today)
    },

    /** 刷新折线图数据（in-place update，不重建实例） */
    updateTimelineChart() {
      const chart = this._timelineChart
      const canvas = chart?.canvas as HTMLCanvasElement | undefined
      if (!chart || !canvas?.isConnected) {
        this._timelineChart = null
        this.ensureCharts()
        return
      }
      const config = buildTimelineConfig(this.timeline)
      chart.data.labels = config.data.labels
      chart.data.datasets.forEach((ds, i) => {
        const newDs = config.data.datasets[i]
        if (newDs) {
          ds.data = newDs.data as any
          // line dataset 上才有 pointRadius，强制设置避免 TS 错误
          (ds as any).pointRadius = newDs.pointRadius
        }
      })
      try {
        chart.update('none')  // 'none' = 跳过动画，避免 _update race
      } catch {
        // chart 实例已销毁（页面跳转、组件卸载），静默忽略
        this._timelineChart = null
      }
    },

    /** 刷新柱状图数据 */
    updateBreakdownChart() {
      const chart = this._breakdownChart
      const canvas = chart?.canvas as HTMLCanvasElement | undefined
      if (!chart || !canvas?.isConnected) {
        this._breakdownChart = null
        this.ensureCharts()
        return
      }
      const config = buildBreakdownConfig(this.breakdownDimension, this.breakdown)
      chart.data.labels = config.data.labels
      chart.data.datasets.forEach((ds, i) => {
        const newDs = config.data.datasets[i]
        if (newDs) {
          ds.data = newDs.data as any
          ds.backgroundColor = newDs.backgroundColor
        }
      })
      try {
        chart.update('none')
      } catch {
        this._breakdownChart = null
      }
    },

    /** 刷新环形图：今日优先，否则展示 provider 分布 */
    updatePieChart(today: any) {
      const chart = this._pieChart
      const canvas = chart?.canvas as HTMLCanvasElement | undefined
      if (!chart || !canvas?.isConnected) {
        this._pieChart = null
        this.ensureCharts()
        return
      }
      // 选择数据源：今日结构 vs provider 占比 vs 全 0
      let config
      if (today && (today.input_tokens + today.output_tokens) > 0) {
        config = buildBreakdownPieConfig(today)
      } else if (this.breakdown.length > 0 && this.breakdownDimension === 'provider') {
        config = buildProviderPieConfig(this.breakdown)
      } else {
        config = buildBreakdownPieConfig({
          input_tokens: 0, output_tokens: 0,
          cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
        })
      }
      chart.data.labels = config.data.labels
      chart.data.datasets.forEach((ds, i) => {
        const newDs = config.data.datasets[i]
        if (newDs) {
          ds.data = newDs.data as any
          ds.backgroundColor = newDs.backgroundColor
        }
      })
      try {
        chart.update('none')
      } catch {
        this._pieChart = null
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