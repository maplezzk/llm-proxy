import i18next from 'i18next'

export function portSettingForm() {
  return {
    port: '',
    configPort: null as number | null,
    editing: false,
    saving: false,

    init() {
      this.load()
    },

    async load() {
      const data = await (window as any).Alpine.store('app').fetch('/admin/port').catch(() => null)
      this.configPort = data?.data?.port ?? null
      this.port = this.configPort ? String(this.configPort) : ''
    },

    toggleEdit() {
      this.editing = !this.editing
      if (!this.editing) {
        this.port = this.configPort ? String(this.configPort) : ''
      }
    },

    async save() {
      this.saving = true
      const portVal = this.port ? parseInt(this.port, 10) : null
      if (this.port && (isNaN(portVal!) || portVal! < 1 || portVal! > 65535)) {
        ;(window as any).Alpine.store('app').toast('Port must be between 1 and 65535', 'error')
        this.saving = false
        return
      }
      const res = await (window as any).Alpine.store('app').fetch('/admin/port', {
        method: 'PUT',
        body: JSON.stringify({ port: portVal }),
      }).catch(() => null)
      this.saving = false
      if (res?.success) {
        ;(window as any).Alpine.store('app').toast(
          i18next.t('admin.sidebar.portSetSuccess'),
          'success'
        )
        this.configPort = portVal
        this.editing = false
      }
    },

    async remove() {
      this.port = ''
      await this.save()
    },
  }
}
