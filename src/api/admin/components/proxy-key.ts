export function proxyKeyForm() {
  return {
    key: '',
    hasKey: false,
    saving: false,

    init() {
      this.load()
    },

    async load() {
      const data = await (window as any).Alpine.store('app').fetch('/admin/proxy-key').catch(() => null)
      this.hasKey = data?.data?.set ?? false
      this.key = ''
    },

    async save() {
      this.saving = true
      const res = await (window as any).Alpine.store('app').fetch('/admin/proxy-key', {
        method: 'PUT',
        body: JSON.stringify({ key: this.key }),
      }).catch(() => null)
      this.saving = false
      if (res?.success) {
        this.hasKey = !!this.key
        ;(window as any).Alpine.store('app').toast(this.key ? '代理 Key 已设置' : '代理 Key 已移除', 'success')
        this.key = ''
        this.load()
      }
    },

    async remove() {
      this.key = ''
      await this.save()
    },
  }
}
