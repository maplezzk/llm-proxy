export function capturePage() {
  const PHASES = [
    { key: 'requestIn', label: '客户端→代理', color: 'var(--success)' },
    { key: 'requestOut', label: '代理→上游', color: 'var(--accent)' },
    { key: 'responseIn', label: '上游→代理', color: 'var(--success)' },
    { key: 'responseOut', label: '代理→客户端', color: 'var(--accent)' },
  ]

  let editors: any[] = []

  return {
    entries: [] as any[],
    selectedId: null as number | null,
    running: false,
    es: null as EventSource | null,
    sourceFilter: '',

    phases: PHASES,

    init() {
      // 页面刷新/加载后自动连接，无需手动点击「开始」
      this.startCapture()
    },

    /** 调用后端抓包控制 API */
    async apiControl(enabled: boolean, clear = false) {
      try {
        await fetch('/admin/debug/captures/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled, clear }),
        })
      } catch {}
    },

    fmtTime(ts: number): string {
      const d = new Date(ts)
      const pad = (n: number) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    },

    fmtSize(s: string | null): string {
      if (!s) return '0B'
      const b = s.length
      if (b > 1024) return (b / 1024).toFixed(1) + 'KB'
      return b + 'B'
    },

    get sources(): string[] {
      return [...new Set(this.entries.map(e => e.source))].sort()
    },

    get filteredEntries(): any[] {
      if (!this.sourceFilter) return this.entries
      return this.entries.filter((e: any) => e.source === this.sourceFilter)
    },

    startCapture() {
      // 关闭旧连接（防止重复）
      if (this.es) {
        this.es.close()
        this.es = null
      }

      // 启用后端抓包 + 清空旧缓存
      this.apiControl(true, true)

      this.running = true
      this.entries = []
      this.selectedId = null

      // 获取所有历史数据
      fetch('/admin/debug/captures')
        .then(r => r.json())
        .then(d => {
          if (d.success) {
            this.entries = d.data
          }
        })
        .catch(() => {})

      // 建立 SSE 连接持续接收新数据
      this.es = new EventSource('/admin/debug/captures/stream')
      this.es.onmessage = (ev) => {
        try {
          const entry = JSON.parse(ev.data)
          const idx = this.entries.findIndex((e: any) => e.pairId === entry.pairId)
          if (idx >= 0) {
            this.entries[idx] = entry
            this.entries = this.entries.slice()
            if (this.selectedId === entry.id) {
              setTimeout(() => this.renderEditors(), 50)
            }
          } else {
            this.entries.push(entry)
            if (this.entries.length > 200) this.entries = this.entries.slice(-200)
          }
        } catch {}
      }
    },

    stopCapture() {
      // 停用后端抓包
      this.apiControl(false)
      this.running = false
      this.es?.close()
      this.es = null
    },

    endCapture() {
      // 停用后端抓包 + 清空后端缓存
      this.apiControl(false, true)
      this.running = false
      this.es?.close()
      this.es = null
      this.entries = []
      this.selectedId = null
    },

    select(id: number) {
      this.selectedId = this.selectedId === id ? null : id
      if (this.selectedId !== null) {
        setTimeout(() => this.renderEditors(), 50)
      }
    },

    get selected(): any | null {
      if (this.selectedId === null) return null
      return this.entries.find((e: any) => e.id === this.selectedId) ?? null
    },

    renderEditors() {
      for (const ed of editors) { ed?.destroy() }
      editors = []

      const entry = this.selected
      if (!entry) return

      const JsonEditor = (window as any).JSONEditor
      if (!JsonEditor) return

      const containers = document.querySelectorAll('.phase-editor-container')
      if (containers.length === 0) return

      containers.forEach((el, i) => {
        const htmlEl = el as HTMLElement
        htmlEl.innerHTML = ''
        htmlEl.style.cssText = 'overflow:auto;padding:12px;font-size:11px;font-family:monospace;white-space:pre-wrap;line-height:1.6;background:var(--surface);color:var(--text);border-radius:0;min-height:80px'

        const phase = PHASES[i]
        if (!phase) return

        const data = entry[phase.key]
        if (!data) {
          htmlEl.textContent = '(暂无数据)'
          htmlEl.style.display = 'flex'
          htmlEl.style.alignItems = 'center'
          htmlEl.style.justifyContent = 'center'
          htmlEl.style.color = 'var(--text-dim)'
          return
        }

        htmlEl.style.display = ''
        const isStream = phase.key === 'responseIn' || phase.key === 'responseOut'
        if (isStream) {
          htmlEl.textContent = data
          return
        }

        try {
          const json = JSON.parse(data)
          const editor = new JsonEditor(htmlEl, {
            mode: 'tree',
            modes: ['tree', 'code', 'text'],
            mainMenuBar: false,
            navigationBar: false,
            statusBar: false,
            readOnly: true,
          }, json)
          editors.push(editor)
        } catch {
          htmlEl.textContent = data
        }
      })
    },

    copyRaw(raw: string) {
      navigator.clipboard.writeText(raw).catch(() => {})
    },
  }
}
