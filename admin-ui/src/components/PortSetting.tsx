import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plug } from '@appica/icons-react'
import { Button } from '@appica/ui-react/button'
import { Input } from '@appica/ui-react/input'
import { fetchJson } from '../lib/api'
import { useToast } from '../lib/toast'

/**
 * 端口内联编辑组件（侧栏页脚）。
 * GET/PUT /admin/port；端口范围 1-65535，非法不发请求并 toast 错误。
 * 对齐旧 src/api/admin/components/port-setting.ts。
 */
export default function PortSetting() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [port, setPort] = useState('')
  const [configPort, setConfigPort] = useState<number | null>(null)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)

  // 加载当前配置端口。
  const load = useCallback(async () => {
    const data = await fetchJson<any>('/admin/port').catch(() => null)
    const p = data?.data?.port ?? null
    setConfigPort(p)
    setPort(p ? String(p) : '')
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // 切换编辑态；退出编辑时复位为已保存端口。
  const toggleEdit = () => {
    const next = !editing
    if (!next) setPort(configPort ? String(configPort) : '')
    setEditing(next)
  }

  // 校验并保存端口；空值表示恢复默认（port=null）。
  const save = async () => {
    setSaving(true)
    const portVal = port ? parseInt(port, 10) : null
    if (port && (Number.isNaN(portVal as number) || (portVal as number) < 1 || (portVal as number) > 65535)) {
      toast('Port must be between 1 and 65535', 'error')
      setSaving(false)
      return
    }
    const res = await fetchJson<any>('/admin/port', {
      method: 'PUT',
      body: JSON.stringify({ port: portVal }),
    }).catch(() => null)
    setSaving(false)
    if (res?.success) {
      toast(t('admin.sidebar.portSetSuccess'), 'success')
      setConfigPort(portVal)
      setEditing(false)
    }
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={toggleEdit}
        title={t('admin.sidebar.port')}
        className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-muted-foreground transition-colors hover:text-foreground"
      >
        <Plug className="size-3.5" />
        <span>{configPort || 9000}</span>
      </button>
    )
  }

  return (
    <div className="flex items-center gap-1">
      <Input
        type="number"
        min={1}
        max={65535}
        value={port}
        placeholder={t('admin.sidebar.portPlaceholder')}
        onChange={(e) => setPort(e.target.value)}
        className="h-7 w-24 text-xs"
      />
      <Button variant="ghost" size="icon-sm" disabled={saving} onClick={() => void save()} aria-label={t('admin.common.save')}>
        ✓
      </Button>
      <Button variant="ghost" size="icon-sm" onClick={toggleEdit} aria-label={t('admin.common.cancel')}>
        ✕
      </Button>
    </div>
  )
}
