export function providersPage() {
  return {
    providers: [] as any[],
    search: '',
    editingName: null as string | null,
    showModal: false,
    showKey: false,
    form: { name: '', type: 'openai', apiKey: '', apiBase: '', models: [] as any[] },
    pullModal: { visible: false, models: [] as any[], existing: [] as string[], loading: false, error: '' },

    init() {
      this.load()
    },

    get filteredProviders() {
      const q = this.search.toLowerCase()
      return q
        ? this.providers.filter((p: any) => p.name.toLowerCase().includes(q))
        : this.providers
    },

    async load() {
      const [statusData, configData] = await Promise.all([
        (window as any).Alpine.store('app').fetch('/admin/status/providers'),
        (window as any).Alpine.store('app').fetch('/admin/config'),
      ])
      const ps = statusData?.data?.providers ?? []
      const configPs = configData?.data?.providers ?? []
      this.providers = ps.map((p: any, i: number) => ({
        ...p,
        api_key: configPs[i]?.api_key,
        api_base: configPs[i]?.api_base,
        models: configPs[i]?.models ?? [],
      }))
      ;(window as any).Alpine.store('app').config = configData?.data
    },

    openForm(name?: string | null) {
      this.showKey = false
      this.editingName = name ?? null
      this.form = { name: '', type: 'openai', apiKey: '', apiBase: '', models: [] }
      if (name) {
        const p = this.providers.find((x: any) => x.name === name)
        if (p) {
          this.form = {
            name: p.name,
            type: p.type,
            apiKey: p.api_key || '',
            apiBase: p.api_base || '',
            models: (p.models || []).map((m: any) => ({ ...m })),
          }
        }
      }
      if (this.form.models.length === 0) this.form.models.push({ id: '' })
      this.showModal = true
    },

    addModelRow(id?: string) {
      this.form.models.push({ id: id || '', thinking: {}, reasoning_effort: '' })
    },

    removeModelRow(index: number) {
      this.form.models.splice(index, 1)
    },

    async save() {
      const { name, type, apiKey, apiBase, models } = this.form
      const validModels = models
        .filter((m: any) => m.id.trim())
        .map((m: any) => {
          const base: Record<string, any> = { id: m.id.trim() }
          if (type === 'anthropic') {
            const bt = parseInt(m.thinking?.budget_tokens, 10)
            if (bt > 0) base.thinking = { budget_tokens: bt }
          } else if (m.reasoning_effort && ['low', 'medium', 'high'].includes(m.reasoning_effort)) {
            base.thinking = { reasoning_effort: m.reasoning_effort }
          }
          return base
        })
      if (!name || validModels.length === 0) {
        ;(window as any).Alpine.store('app').toast('请填写名称和模型列表', 'error')
        return
      }
      if (!this.editingName && !apiKey) {
        ;(window as any).Alpine.store('app').toast('请填写 API Key', 'error')
        return
      }

      const body = { name, type, api_key: apiKey, api_base: apiBase || undefined, models: validModels }
      let res
      if (this.editingName) {
        res = await (window as any).Alpine.store('app').fetch(`/admin/providers/${this.editingName}`, {
          method: 'PUT', body: JSON.stringify(body),
        })
      } else {
        res = await (window as any).Alpine.store('app').fetch('/admin/providers', {
          method: 'POST', body: JSON.stringify(body),
        })
      }
      if (!res.success) {
        ;(window as any).Alpine.store('app').toast(res.error || '保存失败', 'error')
        return
      }
      ;(window as any).Alpine.store('app').toast(this.editingName ? '模型供应商已更新' : '模型供应商已创建', 'success')
      this.showModal = false
      this.load()
    },

    async confirmDelete(name: string) {
      const ok = await (window as any).Alpine.store('app').confirm(`确定删除模型供应商 "${name}" 吗？`)
      if (!ok) return
      const res = await (window as any).Alpine.store('app').fetch(`/admin/providers/${name}`, { method: 'DELETE' })
      if (!res.success) {
        ;(window as any).Alpine.store('app').toast(res.error || '删除失败', 'error')
        return
      }
      ;(window as any).Alpine.store('app').toast('模型供应商已删除', 'success')
      this.load()
    },

    async openPullModels() {
      const { name, type, apiKey, apiBase } = this.form
      const effectiveName = name || this.editingName
      if (!effectiveName) {
        ;(window as any).Alpine.store('app').toast('请先填写供应商名称', 'error')
        return
      }
      if (!apiKey && !this.editingName) {
        ;(window as any).Alpine.store('app').toast('请填写 API Key', 'error')
        return
      }
      this.pullModal = { visible: true, models: [], existing: [], loading: true, error: '' }

      const body: any = { type }
      if (apiKey) body.api_key = apiKey
      if (apiBase) body.api_base = apiBase

      const res = await (window as any).Alpine.store('app').fetch(`/admin/providers/${effectiveName}/pull-models`, {
        method: 'POST', body: JSON.stringify(body),
      }).catch(() => null)

      if (!res?.success) {
        this.pullModal = { visible: true, models: [], existing: [], loading: false, error: res?.error || '请求失败' }
        return
      }
      this.pullModal = { visible: true, models: res.data.models || [], existing: res.data.existing || [], loading: false, error: '' }
    },

    importPullModels() {
      const existingIds = new Set(this.form.models.map((m: any) => m.id))
      let added = 0
      for (const m of this.pullModal.models) {
        if (!existingIds.has(m.id)) {
          this.form.models.push({ id: m.id })
          existingIds.add(m.id)
          added++
        }
      }
      ;(window as any).Alpine.store('app').toast(
        `已导入 ${added} 个模型${this.pullModal.models.length - added > 0 ? `（跳过 ${this.pullModal.models.length - added} 个已存在）` : ''}`,
        'success'
      )
      this.pullModal.visible = false
    },

    openTestPanel(name: string) {
      const config = (window as any).Alpine.store('app').config
      const p = config?.providers?.find((x: any) => x.name === name)
      if (!p) { ;(window as any).Alpine.store('app').toast('供应商未找到', 'error'); return }
      window.dispatchEvent(new CustomEvent('open-test-panel', {
        detail: { providerName: name, provider: p },
      }))
    },
  }
}
