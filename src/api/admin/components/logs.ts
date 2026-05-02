export function logsPage() {
  function todayStr() {
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`
  }

  return {
    allLogs: [] as any[],
    filter: 'all',
    levelFilter: 'all',
    dateFilter: '',
    search: '',
    page: 1,
    pageSize: 50,
    currentLogLevel: 'info',

    init() {
      this.load()
      this.loadLogLevel()
    },

    formatTime(ts: string): string {
      const d = new Date(ts)
      const pad = (n: number) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`
    },

    get filteredLogs() {
      // 先复制避免 排序 修改原数组
      let logs = this.allLogs.slice().sort((a: any, b: any) => b.timestamp.localeCompare(a.timestamp))
      if (this.filter !== 'all') {
        logs = logs.filter((l: any) => l.type === this.filter)
      }
      if (this.levelFilter !== 'all') {
        logs = logs.filter((l: any) => l.level === this.levelFilter)
      }
      if (this.search) {
        const q = this.search.toLowerCase()
        logs = logs.filter((l: any) =>
          (l.message || '').toLowerCase().includes(q) ||
          (l.details ? JSON.stringify(l.details).toLowerCase() : '').includes(q)
        )
      }
      // Reset page if out of bounds
      const maxPage = Math.max(1, Math.ceil(logs.length / this.pageSize))
      if (this.page > maxPage) this.page = maxPage
      return logs
    },

    get pagedLogs() {
      const start = (this.page - 1) * this.pageSize
      return this.filteredLogs.slice(start, start + this.pageSize)
    },

    get totalPages() {
      return Math.max(1, Math.ceil(this.filteredLogs.length / this.pageSize))
    },

    get totalCount() {
      return this.filteredLogs.length
    },

    prevPage() { if (this.page > 1) this.page-- },
    nextPage() { if (this.page < this.totalPages) this.page++ },

    async loadLogLevel() {
      const data = await (window as any).Alpine.store('app').fetch('/admin/log-level').catch(() => null)
      this.currentLogLevel = data?.data?.level ?? 'info'
    },

    async setLogLevel(level: string) {
      const res = await (window as any).Alpine.store('app').fetch('/admin/log-level', {
        method: 'PUT', body: JSON.stringify({ level }),
      }).catch(() => null)
      if (res?.success) {
        this.currentLogLevel = level
        ;(window as any).Alpine.store('app').toast(`日志级别已设为 ${level}`, 'success')
      }
    },

    async load() {
      const params = new URLSearchParams({ limit: '1000' })
      if (this.dateFilter) params.set('date', this.dateFilter)
      const data = await (window as any).Alpine.store('app').fetch('/admin/logs?' + params.toString()).catch(() => null)
      this.allLogs = data?.data?.logs ?? []
      this.page = 1
    },

    formatDetails(details: any): string {
      if (!details) return ''
      return JSON.stringify(details, null, 2)
    },

    copyJson(details: any) {
      navigator.clipboard.writeText(JSON.stringify(details)).then(
        () => (window as any).Alpine.store('app').toast('已复制', 'success'),
        () => {}
      )
    },
  }
}
