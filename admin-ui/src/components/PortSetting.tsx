import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@appica/ui-react/button'
import { Input } from '@appica/ui-react/input'
import { fetchJson } from '../lib/api'
import { useToast } from '../lib/toast'
import { useConfirm } from '../lib/confirm'

/**
 * 端口设置行（设置页-通用卡片）。
 * GET/PUT /admin/port；端口范围 1-65535，非法不发请求并 toast 错误。
 * 对齐旧 src/api/admin/components/port-setting.ts。
 */
export default function PortSetting() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const { confirm } = useConfirm()
  const [port, setPort] = useState('')
  const [configPort, setConfigPort] = useState<number | null>(null)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)

  // 加载当前配置端口。
  const load = useCallback(async () => {
    const data = await fetchJson<any>('/admin/port').catch((err) => {
      console.warn('[port-setting] 端口配置加载失败', err)
      toast(t('admin.common.requestFailed'), 'error')
      return null
    })
    const p = data?.data?.port ?? null
    setConfigPort(p)
    setPort(p ? String(p) : '')
  }, [t, toast])

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
    const portVal = port ? parseInt(port, 10) : null
    if (port && (Number.isNaN(portVal as number) || (portVal as number) < 1 || (portVal as number) > 65535)) {
      toast('Port must be between 1 and 65535', 'error')
      return
    }
    const approved = await confirm(t('admin.general.portChangeConfirm'))
    if (!approved) return
    setSaving(true)
    const res = await fetchJson<any>('/admin/port', {
      method: 'PUT',
      body: JSON.stringify({ port: portVal }),
    }).catch((err) => {
      console.warn('[port-setting] 端口保存失败', err)
      return null
    })
    setSaving(false)
    if (res?.success) {
      toast(t('admin.sidebar.portSetSuccess'), 'success')
      setConfigPort(portVal)
      setEditing(false)
    } else {
      toast(t('admin.common.requestFailed'), 'error')
    }
  }

  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[13px] text-foreground">{t('admin.sidebar.port')}</span>
      {editing ? (
        <div className="flex items-center gap-1.5">
          <Input
            type="number"
            min={1}
            max={65535}
            value={port}
            placeholder={t('admin.sidebar.portPlaceholder')}
            onChange={(e) => setPort(e.target.value)}
            inputSize="sm"
            className="w-28"
          />
          <Button variant="primary" size="sm" disabled={saving} onClick={() => void save()}>
            {t('admin.common.save')}
          </Button>
          <Button variant="ghost" size="sm" onClick={toggleEdit}>
            {t('admin.common.cancel')}
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <span className="font-mono text-[13px] text-muted-foreground">{configPort || 9000}</span>
          <Button variant="ghost" size="sm" onClick={toggleEdit}>
            {t('admin.common.edit')}
          </Button>
        </div>
      )}
    </div>
  )
}
