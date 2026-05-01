export function adaptersPage() {
  return {
    adapters: [] as any[],
    search: '',
    editingName: null as string | null,
    showModal: false,
    form: { name: '', type: 'openai', models: [] as any[] },
    adapterTestModal: { visible: false, adapterName: '', selectedModelId: '', models: [] as any[], results: [] as any[], running: false },

    init() {
      this.load()
    },

    get filteredAdapters() {
      const q = this.search.toLowerCase()
      return q
        ? this.adapters.filter((a: any) => a.name.toLowerCase().includes(q))
        : this.adapters
    },

    get providers() {
      return (window as any).Alpine.store('app').config?.providers ?? []
    },

    getProviderModels(providerName: string) {
      const p = this.providers.find((p: any) => p.name === providerName)
      return p?.models ?? []
    },

    async load() {
      const data = await (window as any).Alpine.store('app').fetch('/admin/adapters').catch(() => null)
      this.adapters = data?.data?.adapters ?? []
    },

    openForm(name?: string | null) {
      this.editingName = name ?? null
      this.form = { name: '', type: 'openai', models: [] }
      if (name) {
        const a = this.adapters.find((x: any) => x.name === name)
        if (a) {
          this.form = {
            name: a.name,
            type: a.type,
            models: (a.models || []).map((m: any) => ({
              sourceModelId: m.sourceModelId,
              provider: m.provider,
              targetModelId: m.targetModelId,
              thinking: m.thinking ? { budget_tokens: m.thinking.budget_tokens } : {},
              reasoning_effort: (m as any).reasoning_effort || '',
            })),
          }
        }
      }
      if (this.form.models.length === 0) this.addMappingRow()
      this.showModal = true
    },

    addMappingRow() {
      this.form.models.push({ sourceModelId: '', provider: '', targetModelId: '', thinking: {}, reasoning_effort: '' })
    },

    removeMappingRow(index: number) {
      this.form.models.splice(index, 1)
    },

    onProviderChange(index: number) {
      const m = this.form.models[index]
      if (m) m.targetModelId = ''
    },

    async save() {
      const { name, type, models } = this.form
      const validModels = models
        .filter((m: any) => m.sourceModelId.trim() && m.provider && m.targetModelId)
        .map((m: any) => {
          const base = { sourceModelId: m.sourceModelId, provider: m.provider, targetModelId: m.targetModelId }
          if (type === 'anthropic') {
            const bt = parseInt(m.thinking?.budget_tokens, 10)
            if (bt > 0) (base as any).thinking = { budget_tokens: bt }
          } else if (m.reasoning_effort && ['low', 'medium', 'high'].includes(m.reasoning_effort)) {
            (base as any).thinking = { reasoning_effort: m.reasoning_effort }
          }
          return base
        })
      if (!name || validModels.length === 0) {
        ;(window as any).Alpine.store('app').toast('请填写名称和模型映射', 'error')
        return
      }

      const body = { name, type, models: validModels }
      let res
      if (this.editingName) {
        res = await (window as any).Alpine.store('app').fetch(`/admin/adapters/${this.editingName}`, {
          method: 'PUT', body: JSON.stringify(body),
        })
      } else {
        res = await (window as any).Alpine.store('app').fetch('/admin/adapters', {
          method: 'POST', body: JSON.stringify(body),
        })
      }
      if (!res.success) {
        ;(window as any).Alpine.store('app').toast(res.error || '保存失败', 'error')
        return
      }
      ;(window as any).Alpine.store('app').toast(this.editingName ? '适配器已更新' : '适配器已创建', 'success')
      this.showModal = false
      this.load()
    },

    async confirmDelete(name: string) {
      const ok = await (window as any).Alpine.store('app').confirm(`确定删除适配器 "${name}" 吗？`)
      if (!ok) return
      const res = await (window as any).Alpine.store('app').fetch(`/admin/adapters/${name}`, { method: 'DELETE' })
      if (!res.success) {
        ;(window as any).Alpine.store('app').toast(res.error || '删除失败', 'error')
        return
      }
      ;(window as any).Alpine.store('app').toast('适配器已删除', 'success')
      this.load()
    },

    openTestPanel(adapterName: string) {
      const a = this.adapters.find((x: any) => x.name === adapterName)
      if (!a) { (window as any).Alpine.store('app').toast('适配器未找到', 'error'); return }
      const models = (a.models || []).map((m: any) => ({ id: m.sourceModelId, status: m.status }))
      this.adapterTestModal = {
        visible: true,
        adapterName,
        selectedModelId: models[0]?.id || '',
        models,
        results: [],
        running: false,
      }
    },

    async runAdapterTest() {
      const { adapterName, selectedModelId } = this.adapterTestModal
      if (!selectedModelId) { (window as any).Alpine.store('app').toast('请选择模型', 'error'); return }
      this.adapterTestModal.running = true
      const res = await (window as any).Alpine.store('app').fetch('/admin/test-adapter', {
        method: 'POST',
        body: JSON.stringify({ adapterName, modelId: selectedModelId }),
      }).catch(() => ({ success: true, data: { reachable: false, latency: 0, error: '请求失败' } }))
      this.adapterTestModal.running = false
      const d = res.data || {}
      this.adapterTestModal.results.unshift({
        model: selectedModelId,
        ok: d.reachable === true,
        latency: d.latency,
        error: d.error,
        time: new Date().toLocaleTimeString(),
      })
    },
  }
}
