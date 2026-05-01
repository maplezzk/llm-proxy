export function capturePage() {
  let leftEditor: any = null
  let rightEditor: any = null

  return {
    entries: [] as any[],
    selectedId: null as number | null,
    running: false,
    es: null as EventSource | null,
    sourceFilter: '',
    sessionStart: 0,

    fmtTime(ts: number): string {
      const d = new Date(ts)
      const pad = (n: number) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    },

    fmtSize(s: string): string {
      const b = s.length
      if (b > 1024) return (b / 1024).toFixed(1) + 'KB'
      return b + 'B'
    },

    dirIcon(d: string): string {
      switch (d) {
        case 'request-in': return '▲'
        case 'request-out': return '▼'
        case 'response-in': return '▲'
        case 'response-out': return '▼'
        default: return '?'
      }
    },

    dirLabel(d: string): string {
      switch (d) {
        case 'request-in': return '客户端→代理'
        case 'request-out': return '代理→上游'
        case 'response-in': return '上游→代理'
        case 'response-out': return '代理→客户端'
        default: return d
      }
    },

    get filteredEntries(): any[] {
      if (!this.sourceFilter) return this.entries
      return this.entries.filter((e: any) => e.source === this.sourceFilter || e.source?.startsWith(this.sourceFilter))
    },

    startCapture() {
      this.running = true
      this.entries = []
      this.selectedId = null
      this.sessionStart = Date.now()

      // Only load captures from this session onwards
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
            this.entries.push(entry)
            if (this.entries.length > 200) this.entries = this.entries.slice(-200)
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

    get pairedEntries(): any[] {
      if (!this.selected) return []
      return this.entries.filter((e: any) => e.pairId === this.selected.pairId).sort((a: any, b: any) => a.id - b.id)
    },

    renderEditors() {
      if (leftEditor) { leftEditor.destroy(); leftEditor = null }
      if (rightEditor) { rightEditor.destroy(); rightEditor = null }

      const paired = this.pairedEntries
      if (paired.length === 0) return

      const JsonEditor = (window as any).JSONEditor
      if (!JsonEditor) return

      const containers = document.querySelectorAll('.jsoneditor-container')
      if (containers.length === 0) return

      paired.forEach((entry: any, i: number) => {
        if (i >= containers.length) return
        const container = containers[i] as HTMLElement
        container.innerHTML = ''
        const isStream = entry.direction === 'response-in' || entry.direction === 'response-out'

        if (isStream) {
          container.className = ''
          container.style.cssText = 'overflow:auto;padding:12px;font-size:11px;font-family:monospace;white-space:pre-wrap;line-height:1.6;background:var(--surface);color:var(--text);border-radius:0'
          container.textContent = entry.rawData
          return
        }

        let json
        try { json = JSON.parse(entry.rawData) } catch { json = entry.rawData }

        const editor = new JsonEditor(container, {
          mode: 'tree',
          modes: ['tree', 'code', 'text'],
          mainMenuBar: false,
          navigationBar: false,
          statusBar: false,
          readOnly: true,
        }, json)

        if (i === 0) leftEditor = editor
        else rightEditor = editor
      })
    },

    copyRaw(raw: string) {
      navigator.clipboard.writeText(raw).catch(() => {})
    },

    getDiffLines(left: string, right: string): string[] {
      const diffs: string[] = []
      try {
        const l = JSON.parse(left)
        const r = JSON.parse(right)
        if (typeof l !== 'object' || typeof r !== 'object') return diffs

        const lKeys = new Set(Object.keys(l))
        const rKeys = new Set(Object.keys(r))
        for (const k of lKeys) {
          if (!rKeys.has(k)) diffs.push(`- ${k} (已移除)`)
        }
        for (const k of rKeys) {
          if (!lKeys.has(k)) diffs.push(`+ ${k} (新增)`)
        }

        if (l.messages && r.messages && Array.isArray(l.messages) && Array.isArray(r.messages)) {
          const lastL = l.messages[l.messages.length - 1]
          const lastR = r.messages[r.messages.length - 1]
          if (lastL?.content && Array.isArray(lastL.content)) {
            const hasThinking = lastL.content.some((b: any) => b.type === 'thinking')
            const hasToolUse = lastL.content.some((b: any) => b.type === 'tool_use')
            if (hasThinking && lastR?.reasoning_content) diffs.push('✓ thinking → reasoning_content')
            if (hasToolUse && lastR?.tool_calls) diffs.push('✓ tool_use → tool_calls')
          }
          if (lastL?.tool_calls && lastR?.content?.length) {
            const hasToolUse = lastR.content.some((b: any) => b.type === 'tool_use')
            if (hasToolUse) diffs.push('✓ tool_calls → tool_use block')
          }
        }

        if (!l.tools && r.tools) diffs.push('✓ tools 格式转换')
        if (l.system && !r.system && r.messages?.[0]?.role === 'system') diffs.push('✓ system → messages[0]')
      } catch {
        diffs.push('⚠ JSON 解析失败，无法 diff')
      }
      return diffs
    },
  }
}
