import i18next from 'i18next'

function t(key: string, opts?: Record<string, unknown>): string {
  return i18next.t(key, opts)
}

export function testPanel() {
  return {
    visible: false,
    providerName: '',
    providerType: '',
    models: [] as any[],
    selectedModel: '',
    running: false,
    results: [] as any[],

    init() {
      window.addEventListener('open-test-panel', ((e: CustomEvent) => {
        this.providerName = e.detail.providerName
        this.providerType = e.detail.provider.type
        this.models = e.detail.provider.models ?? []
        this.selectedModel = this.models[0]?.id || ''
        this.results = []
        this.visible = true
      }) as EventListener)
    },

    get providerNames(): string {
      return this.providerName
    },

    async run() {
      if (!this.selectedModel) return
      this.running = true
      const res = await (window as any).Alpine.store('app').fetch('/admin/test-model', {
        method: 'POST',
        body: JSON.stringify({
          providerName: this.providerName,
          model: this.selectedModel,
          type: this.providerType,
        }),
      }).catch(() => ({ success: true, data: { reachable: false, latency: 0, error: t('admin.test.requestFailed') } }))
      this.running = false
      const d = res.data || {}
      this.results.unshift({
        model: this.selectedModel,
        ok: d.reachable === true,
        latency: d.latency,
        error: d.error,
        time: new Date().toLocaleTimeString(),
        requestUrl: d.requestUrl,
        requestHeaders: d.requestHeaders,
        requestBody: d.requestBody,
        responseStatus: d.responseStatus,
        responseBody: d.responseBody,
        _showDetails: true,
      })
    },

    clear() {
      this.results = []
    },
  }
}
