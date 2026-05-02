import i18next from 'i18next'

function t(key: string, opts?: Record<string, unknown>): string {
  return i18next.t(key, opts)
}

const toast = (msg: string, type = 'info') =>
  (window as any).Alpine.store('app').toast(msg, type)

const confirm = (msg: string) =>
  (window as any).Alpine.store('app').confirm(msg)

export function adaptersPage() {
  return {
    adapters: [] as any[],
    search: '',
    editingName: null as string | null,
    showModal: false,
    form: { name: '', type: 'openai', max_tokens: '', models: [] as any[] },
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
      this.form = { name: '', type: 'openai', max_tokens: '', models: [] }
      if (name) {
        const a = this.adapters.find((x: any) => x.name === name)
        if (a) {
          this.form = {
            name: a.name,
            type: a.type,
            max_tokens: a.max_tokens ?? '',
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
        toast(t('admin.common.validationName'), 'error')
        return
      }

      const body = { name, type, max_tokens: parseInt(this.form.max_tokens, 10) || undefined, models: validModels }
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
        toast(res.error || t('admin.adapters.saveFailed'), 'error')
        return
      }
      toast(this.editingName ? t('admin.adapters.updated') : t('admin.adapters.created'), 'success')
      this.showModal = false
      this.load()
    },

    async confirmDelete(name: string) {
      const ok = await confirm(t('admin.adapters.deleteConfirm', { name }))
      if (!ok) return
      const res = await (window as any).Alpine.store('app').fetch(`/admin/adapters/${name}`, { method: 'DELETE' })
      if (!res.success) {
        toast(res.error || t('admin.adapters.deleteFailed'), 'error')
        return
      }
      toast(t('admin.adapters.deleted'), 'success')
      this.load()
    },

    openTestPanel(adapterName: string) {
      const a = this.adapters.find((x: any) => x.name === adapterName)
      if (!a) { toast(t('admin.adapters.notFound'), 'error'); return }
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
      if (!selectedModelId) { toast(t('admin.common.validationName'), 'error'); return }
      this.adapterTestModal.running = true
      const res = await (window as any).Alpine.store('app').fetch('/admin/test-adapter', {
        method: 'POST',
        body: JSON.stringify({ adapterName, modelId: selectedModelId }),
      }).catch(() => ({ success: true, data: { reachable: false, latency: 0, error: t('admin.test.requestFailed') } }))
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
