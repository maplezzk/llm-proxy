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
    sessionStart: 0,

    phases: PHASES,

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
      this.running = true
      this.entries = []
      this.selectedId = null
      this.sessionStart = Date.now()

      fetch('/admin/debug/captures')
        .then(r => r.json())
        .then(d => {
          if (d.success) {
            this.entries = d.data.filter((e: any) => e.timestamp >= this.sessionStart)
          }
        })
        .catch(() => {})

      this.es = new EventSource('/admin/debug/captures/stream')
      this.es.onmessage = (ev) => {
        try {
          const entry = JSON.parse(ev.data)
          if (entry.timestamp >= this.sessionStart) {
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
          }
        } catch {}
      }
    },

    stopCapture() {
      this.running = false
      this.es?.close()
      this.es = null
    },

    endCapture() {
      this.stopCapture()
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

    activePhases(): any[] {
      const entry = this.selected
      if (!entry) return []
      return PHASES.filter(p => entry[p.key])
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

      const active = this.activePhases()
      containers.forEach((el, i) => {
        const htmlEl = el as HTMLElement
        htmlEl.innerHTML = ''
        const phase = active[i]
        if (!phase) return

        htmlEl.style.cssText = 'overflow:auto;padding:12px;font-size:11px;font-family:monospace;white-space:pre-wrap;line-height:1.6;background:var(--surface);color:var(--text);border-radius:0;min-height:80px'

        const data = entry[phase.key]
        if (!data) {
          htmlEl.textContent = '(暂无数据)'
          return
        }

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
