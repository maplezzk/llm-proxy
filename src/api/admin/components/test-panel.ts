export function testPanel() {
  return {
    visible: false,
    providerName: '',
    providerType: '',
    selectedModel: '',
    endpoint: 'chat',
    models: [] as any[],
    results: [] as any[],
    running: false,

    init() {
      window.addEventListener('open-test-panel', (e: Event) => {
        const detail = (e as CustomEvent).detail
        this.providerName = detail.providerName
        this.providerType = detail.provider?.type || ''
        this.models = detail.provider.models || []
        this.selectedModel = this.models[0]?.id || ''
        this.endpoint = 'chat'
        this.visible = true
      })
    },

    async run() {
      if (!this.selectedModel) { ;(window as any).Alpine.store('app').toast('请选择模型', 'error'); return }
      this.running = true
      const config = (window as any).Alpine.store('app').config
      const p = config?.providers?.find((x: any) => x.name === this.providerName)
      const res = await (window as any).Alpine.store('app').fetch('/admin/test-model', {
        method: 'POST',
        body: JSON.stringify({
          type: p?.type,
          api_key: p?.api_key,
          api_base: p?.api_base,
          model: this.selectedModel,
          providerName: this.providerName,
          endpoint: this.providerType === 'openai' ? this.endpoint : undefined,
        }),
      }).catch(() => ({ success: true, data: { reachable: false, latency: 0, error: '请求失败' } }))

      this.running = false
      const d = res.data || {}
      const ok = d.reachable === true
      this.results.unshift({
        model: this.selectedModel,
        ok,
        latency: d.latency,
        error: d.error,
        time: new Date().toLocaleTimeString(),
      })
    },

    clear() {
      this.results = []
    },
  }
}
