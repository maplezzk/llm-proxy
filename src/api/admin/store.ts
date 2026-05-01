import Alpine from 'alpinejs'

export function initStore() {
  const store: any = {
    // Shared state
    config: null,
    health: null,
    status: 'loading',
    tokenStats: null,

    // Router state
    currentTab: 'dashboard',
    tabNames: {
      dashboard: '仪表盘',
      providers: '模型供应商',
      adapters: '适配器',
      logs: '日志',
      capture: '协议抓包',
    },
    tabIcons: {
      dashboard: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>`,
      logs: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 10h16M4 14h10M4 18h7"/></svg>`,
      providers: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.64 5.64l1.42 1.42M16.95 16.95l1.41 1.41M5.64 18.36l1.42-1.42M16.95 7.05l1.41-1.41"/></svg>`,
      adapters: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h16M4 15h16"/><circle cx="9" cy="9" r="2"/><circle cx="15" cy="15" r="2"/></svg>`,
      capture: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/></svg>`,
    },

    // Confirm dialog state
    confirmResolve: null,
    showConfirm: false,
    confirmMessage: '',

    // Shared methods
    async fetch(path: string, opts: RequestInit = {}) {
      const r = await fetch(path, {
        ...opts,
        headers: { 'Content-Type': 'application/json', ...opts.headers },
      })
      return r.json()
    },

    toast(message: string, type = 'info') {
      const el = document.createElement('div')
      el.className = 'toast toast-' + type
      el.textContent = message
      document.getElementById('toastContainer')!.appendChild(el)
      setTimeout(() => {
        el.style.opacity = '0'
        el.style.transition = 'opacity 0.3s'
        setTimeout(() => el.remove(), 300)
      }, 3000)
    },

    confirm(msg: string) {
      return new Promise(resolve => {
        this.confirmMessage = msg
        this.confirmResolve = resolve
        this.showConfirm = true
      })
    },

    switchTab(tab: string) {
      this.currentTab = tab
      location.hash = '#' + tab
    },

    // Dashboard polling
    _dashboardInterval: null as any,
    startPolling() {
      if (this._dashboardInterval) return
      this._dashboardInterval = setInterval(() => this.loadDashboard(), 10000)
    },
    stopPolling() {
      if (this._dashboardInterval) {
        clearInterval(this._dashboardInterval)
        this._dashboardInterval = null
      }
    },

    async loadDashboard() {
      const [health, config, tokenStats] = await Promise.all([
        this.fetch('/admin/health').catch(() => null),
        this.fetch('/admin/config').catch(() => null),
        this.fetch('/admin/token-stats').catch(() => null),
      ])
      this.health = health
      this.config = config?.data ?? null
      this.tokenStats = tokenStats?.data ?? null
      this.status = health?.success ? 'running' : 'offline'
    },
  }
  Alpine.store('app', store)
}
