export function capturePage() {
  let leftEditor: any = null
  let rightEditor: any = null

  const PHASES = [
    { key: 'requestIn', label: '客户端→代理 (原始请求)' },
    { key: 'requestOut', label: '代理→上游 (转换后请求)' },
    { key: 'responseIn', label: '上游→代理 (原始响应)' },
    { key: 'responseOut', label: '代理→客户端 (转换后响应)' },
  ]

  return {
    entries: [] as any[],
    selectedId: null as number | null,
    running: false,
    es: null as EventSource | null,
    sourceFilter: '',
    sessionStart: 0,
    leftPhase: 'requestIn',
    rightPhase: 'responseOut',
    collapsed: false,

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

    phaseCount(entry: any): number {
      let n = 0
      for (const p of PHASES) {
        if (entry[p.key]) n++
      }
      return n
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
            // Check if entry already exists (update from SSE)
            const idx = this.entries.findIndex((e: any) => e.pairId === entry.pairId)
            if (idx >= 0) {
              this.entries[idx] = entry
              this.entries = this.entries.slice() // trigger reactivity
            } else {
              this.entries.push(entry)
              if (this.entries.length > 200) this.entries = this.entries.slice(-200)
            }
            // Re-render editors if this is the selected entry
            if (this.selectedId === entry.id) {
              setTimeout(() => this.renderEditors(), 50)
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
      this.leftPhase = 'requestIn'
      this.rightPhase = 'responseOut'
      if (this.selectedId !== null) {
        setTimeout(() => this.renderEditors(), 50)
      }
    },

    get selected(): any | null {
      if (this.selectedId === null) return null
      return this.entries.find((e: any) => e.id === this.selectedId) ?? null
    },

    switchLeftPhase(key: string) {
      this.leftPhase = key
      setTimeout(() => this.renderEditors(), 50)
    },

    switchRightPhase(key: string) {
      this.rightPhase = key
      setTimeout(() => this.renderEditors(), 50)
    },

    renderEditors() {
      if (leftEditor) { leftEditor.destroy(); leftEditor = null }
      if (rightEditor) { rightEditor.destroy(); rightEditor = null }

      const entry = this.selected
      if (!entry) return

      const leftData = entry[this.leftPhase]
      const rightData = entry[this.rightPhase]

      const JsonEditor = (window as any).JSONEditor
      if (!JsonEditor) return

      const containers = document.querySelectorAll('.jsoneditor-container')
      if (containers.length === 0) return

      const leftEl = containers[0] as HTMLElement
      const rightEl = containers[1] as HTMLElement

      if (leftEl) {
        leftEl.innerHTML = ''
        leftEl.style.cssText = 'overflow:auto;padding:12px;font-size:11px;font-family:monospace;white-space:pre-wrap;line-height:1.6;background:var(--surface);color:var(--text);border-radius:0'
        if (leftData) {
          try {
            const json = JSON.parse(leftData)
            const editor = new JsonEditor(leftEl, {
              mode: 'tree',
              modes: ['tree', 'code', 'text'],
              mainMenuBar: false,
              navigationBar: false,
              statusBar: false,
              readOnly: true,
            }, json)
            leftEditor = editor
          } catch {
            leftEl.textContent = leftData
          }
        } else {
          leftEl.textContent = '(暂无数据)'
          leftEl.style.display = 'flex'
          leftEl.style.alignItems = 'center'
          leftEl.style.justifyContent = 'center'
          leftEl.style.color = 'var(--text-dim)'
        }
      }

      if (rightEl) {
        rightEl.innerHTML = ''
        rightEl.style.cssText = 'overflow:auto;padding:12px;font-size:11px;font-family:monospace;white-space:pre-wrap;line-height:1.6;background:var(--surface);color:var(--text);border-radius:0'
        if (rightData) {
          try {
            const json = JSON.parse(rightData)
            const editor = new JsonEditor(rightEl, {
              mode: 'tree',
              modes: ['tree', 'code', 'text'],
              mainMenuBar: false,
              navigationBar: false,
              statusBar: false,
              readOnly: true,
            }, json)
            rightEditor = editor
          } catch {
            rightEl.textContent = rightData
          }
        } else {
          rightEl.textContent = '(暂无数据)'
          rightEl.style.display = 'flex'
          rightEl.style.alignItems = 'center'
          rightEl.style.justifyContent = 'center'
          rightEl.style.color = 'var(--text-dim)'
        }
      }
    },

    copyRaw(raw: string) {
      navigator.clipboard.writeText(raw).catch(() => {})
    },

    getDiffLines(left: string | null, right: string | null): string[] {
      const diffs: string[] = []
      if (!left || !right) return diffs
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

    // 快捷比较模式
    compareClient() {
      this.leftPhase = 'requestIn'
      this.rightPhase = 'responseOut'
      setTimeout(() => this.renderEditors(), 50)
    },

    compareUpstream() {
      this.leftPhase = 'requestOut'
      this.rightPhase = 'responseIn'
      setTimeout(() => this.renderEditors(), 50)
    },
  }
}
