import i18next from 'i18next'

function t(key: string, opts?: Record<string, unknown>): string {
  return i18next.t(key, opts)
}

const toast = (msg: string, type = 'info') =>
  (window as any).Alpine.store('app').toast(msg, type)

const confirm = (msg: string) =>
  (window as any).Alpine.store('app').confirm(msg)

/**
 * 从后端响应中提取人类可读的错误消息。
 * 支持三种格式：
 * 1. `{success: false, error: "..."}` — 业务错误
 * 2. `{success: false, error: "...", errors: [{field, message}]}` — 校验错误（带明细）
 * 3. `{error: {message: "..."}}` — 路由 404 / catch-all 抛错
 * 4. null / undefined — 返回 null 让调用方自己处理
 */
export function extractError(res: any, fallback: string): string | null {
  if (!res) return null
  // 格式 3: error 是对象 {message: ...}
  if (typeof res.error === 'object' && res.error !== null) {
    if (typeof res.error.message === 'string' && res.error.message) return res.error.message
    return fallback
  }
  // 格式 1/2: error 是字符串
  if (typeof res.error === 'string' && res.error) {
    // 格式 2: errors 数组
    if (Array.isArray(res.errors) && res.errors.length > 0) {
      const lines = res.errors.map((e: any) => {
        const field = e.field || ''
        const msg = e.message || ''
        return field ? `• ${field}: ${msg}` : `• ${msg}`
      })
      return res.error + '\n' + lines.join('\n')
    }
    return res.error
  }
  // 没有 error 字段但有 errors 数组（理论上不会发生）
  if (Array.isArray(res.errors) && res.errors.length > 0) {
    return res.errors.map((e: any) => `• ${e.field || ''}: ${e.message || ''}`).join('\n')
  }
  return null
}

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
            models: (p.models || []).map((m: any) => ({
              ...m,
              thinking: m.thinking ?? {},
              reasoning_effort: (m as any).reasoning_effort ?? '',
              input: Array.isArray((m as any).input) ? (m as any).input : [],
            })),
          }
        }
      }
      if (this.form.models.length === 0) this.addModelRow()
      this.showModal = true
    },

    addModelRow(id?: string) {
      this.form.models.push({ id: id || '', thinking: {}, reasoning_effort: '', input: [] })
    },

    removeModelRow(index: number) {
      this.form.models.splice(index, 1)
    },

    /** 勾选/取消勾选输入模态（如 image） */
    toggleModality(m: any, modality: string, checked: boolean) {
      if (!Array.isArray(m.input)) m.input = []
      const has = m.input.includes(modality)
      if (checked && !has) m.input.push(modality)
      if (!checked && has) m.input = m.input.filter((x: string) => x !== modality)
      // 至少保留 text
      if (!m.input.includes('text')) m.input.unshift('text')
    },

    async save() {
      const { name, type, apiKey, apiBase, models } = this.form
      const validModels = models
        .filter((m: any) => m.id.trim())
        .map((m: any) => {
          const base: Record<string, any> = { id: m.id.trim() }
          if (type === 'anthropic') {
            const bt = parseInt(m.thinking?.budget_tokens, 10)
            if (bt > 0) base.thinking = { ...(base.thinking ?? {}), budget_tokens: bt }
            // Anthropic 也允许配 reasoning_effort，运行时查表映射为 budget_tokens
            if (m.reasoning_effort && ['low', 'medium', 'high', 'xhigh', 'max'].includes(m.reasoning_effort)) {
              base.thinking = { ...(base.thinking ?? {}), reasoning_effort: m.reasoning_effort }
            }
          } else if (m.reasoning_effort && ['low', 'medium', 'high', 'xhigh', 'max'].includes(m.reasoning_effort)) {
            base.thinking = { reasoning_effort: m.reasoning_effort }
          }
          // thinking.type 对所有 provider type 生效（如 MiniMax adaptive）
          if (m.thinking?.type && ['adaptive', 'auto', 'enabled', 'disabled'].includes(m.thinking.type)) {
            base.thinking = { ...(base.thinking ?? {}), type: m.thinking.type }
          }
          // input 模态：未勾选或仅 text 时不写入；勾选了 image 才序列化
          const inputArr = Array.isArray(m.input) ? m.input.filter((x: string) => ['text', 'image'].includes(x)) : []
          if (inputArr.length > 0) base.input = inputArr
          return base
        })
      if (!name) {
        toast(t('admin.providers.validationName'), 'error')
        return
      }
      if (validModels.length === 0) {
        toast(t('admin.providers.validationModels'), 'error')
        return
      }
      if (!this.editingName && !apiKey) {
        toast(t('admin.providers.validationApiKey'), 'error')
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
        const detail = extractError(res, t('admin.providers.saveFailed')) || t('admin.providers.saveFailed')
        toast(detail, 'error')
        return
      }
      toast(this.editingName ? t('admin.providers.updated') : t('admin.providers.created'), 'success')
      this.showModal = false
      this.load()
    },

    async confirmDelete(name: string) {
      const ok = await confirm(t('admin.providers.deleteConfirm', { name }))
      if (!ok) return
      const res = await (window as any).Alpine.store('app').fetch(`/admin/providers/${name}`, { method: 'DELETE' })
      if (!res.success) {
        const detail = extractError(res, t('admin.providers.deleteFailed')) || t('admin.providers.deleteFailed')
        toast(detail, 'error')
        return
      }
      toast(t('admin.providers.deleted'), 'success')
      this.load()
    },

    async openPullModels() {
      const { name, type, apiKey, apiBase } = this.form
      const effectiveName = name || this.editingName
      if (!effectiveName) {
        toast(t('admin.providers.validationProviderName'), 'error')
        return
      }
      if (!apiKey && !this.editingName) {
        toast(t('admin.providers.validationApiKey'), 'error')
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
        const detail = extractError(res, t('admin.providers.pullModelsError')) || t('admin.providers.pullModelsError')
        this.pullModal = { visible: true, models: [], existing: [], loading: false, error: detail }
        return
      }
      const models = (res.data.models || []).map((m: any) => ({
        ...m,
        checked: !res.data.existing?.includes(m.id),
      }))
      this.pullModal = { visible: true, models, existing: res.data.existing || [], loading: false, error: '' }
    },

    importPullModels() {
      const existingIds = new Set(this.form.models.map((m: any) => m.id))
      const selected = this.pullModal.models.filter((m: any) => m.checked)
      let added = 0
      for (const m of selected) {
        if (!existingIds.has(m.id)) {
          this.form.models.push({ id: m.id })
          existingIds.add(m.id)
          added++
        }
      }
      const total = selected.length
      const msg = total > added
        ? `${t('admin.providers.importedModels', { added })}${t('admin.providers.importedModelsSkip', { skipped: total - added })}`
        : t('admin.providers.importedModels', { added })
      toast(msg, 'success')
      this.pullModal.visible = false
    },

    openTestPanel(name: string) {
      const config = (window as any).Alpine.store('app').config
      const p = config?.providers?.find((x: any) => x.name === name)
      if (!p) { toast(t('admin.providers.notFound'), 'error'); return }
      window.dispatchEvent(new CustomEvent('open-test-panel', {
        detail: { providerName: name, provider: p },
      }))
    },
  }
}
