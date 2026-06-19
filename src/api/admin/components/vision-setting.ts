import i18next from 'i18next'

interface VisionFormData {
  enabled: boolean
  provider: string
  model: string
  prompt: string
}

// 与后端 src/proxy/vision.ts 的 DEFAULT_VISION_PROMPT 保持一致
const DEFAULT_VISION_PROMPT = '请详细描述这张图片的内容，包括其中的文字、物体、场景、颜色等关键信息。'

export function visionSettingForm() {
  return {
    form: { enabled: false, provider: '', model: '', prompt: '' } as VisionFormData,
    providers: [] as Array<{ name: string; models: Array<{ id: string; input?: string[] }> }>,
    loading: false,
    saving: false,

    init() {
      this.load()
    },

    async load() {
      this.loading = true
      const [visionRes, providersRes] = await Promise.all([
        (window as any).Alpine.store('app').fetch('/admin/vision').catch(() => null),
        (window as any).Alpine.store('app').fetch('/admin/config').catch(() => null),
      ])
      this.loading = false

      // 1. 先设 providers（让 <option> 先渲染）
      this.providers = providersRes?.data?.providers || []

      const visionData = visionRes?.data
      const hasVision = visionData && (visionData.provider || visionData.model)

      if (!hasVision) {
        this.form = { enabled: false, provider: '', model: '', prompt: DEFAULT_VISION_PROMPT }
        return
      }

      // 2. 需要设三个值（provider、model、prompt），Alpine x-model 对 select 的同步
      // 要求 option 先在 DOM 里存在。策略：先设 provider + 等待其 option 列表出现，
      // 再设 model（availableModels 依赖 provider） + 等待其 option 列表出现
      this.form = { enabled: true, provider: '', model: '', prompt: '' }
      await (window as any).Alpine.nextTick()

      this.form.provider = visionData.provider || ''
      await (window as any).Alpine.nextTick()

      this.form.model = visionData.model || ''
      // prompt 为空表示用默认——预填默认 prompt 让用户能看到、能改
      this.form.prompt = visionData.prompt || DEFAULT_VISION_PROMPT
    },

    get availableModels() {
      const p = this.providers.find((x) => x.name === this.form.provider)
      if (!p) return [] as Array<{ id: string }>
      return p.models
    },

    providerHasImage(p: any): boolean {
      return (p.models || []).some((m: any) => Array.isArray(m.input) && m.input.includes('image'))
    },

    modelHasImage(m: any): boolean {
      return Array.isArray(m.input) && m.input.includes('image')
    },

    selectedModelHasImage(): boolean {
      const p = this.providers.find((x: any) => x.name === this.form.provider)
      if (!p) return false
      const m = p.models.find((x: any) => x.id === this.form.model)
      return m ? this.modelHasImage(m) : false
    },

    async save() {
      this.saving = true
      // prompt 等于默认值时发空字符串（表示用默认，不写入 config）
      const promptTrimmed = this.form.prompt.trim()
      const promptToSend = promptTrimmed === DEFAULT_VISION_PROMPT ? '' : promptTrimmed
      const payload = this.form.enabled
        ? { provider: this.form.provider.trim(), model: this.form.model.trim(), prompt: promptToSend }
        : { provider: '', model: '', prompt: '' }
      const res = await (window as any).Alpine.store('app').fetch('/admin/vision', {
        method: 'PUT',
        body: JSON.stringify(payload),
      }).catch(() => null)
      this.saving = false
      if (res?.success) {
        ;(window as any).Alpine.store('app').toast(
          this.form.enabled
            ? i18next.t('admin.vision.saved')
            : i18next.t('admin.vision.removed'),
          'success'
        )
      } else {
        ;(window as any).Alpine.store('app').toast(
          res?.error || i18next.t('admin.vision.saveFailed'),
          'error'
        )
      }
    },
  }
}
