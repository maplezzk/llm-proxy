import i18next from 'i18next'

export function dashboardPage() {
  function fmtNum(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
    return String(n)
  }

  function pct(n: number, total: number): string {
    if (!total) return '0%'
    return ((n / total) * 100).toFixed(1) + '%'
  }

  const t = (key: string, opts?: Record<string, unknown>) => i18next.t(key, opts)

  return {
    get stats() {
      const store = (window as any).Alpine.store('app')
      const ok = store.health?.success
      const providers = store.config?.providers ?? []
      const modelCount = providers.reduce((s: number, p: any) => s + (p.models?.length ?? 0), 0)
      const adapters = store.config?.adapters ?? []
      return [
        { label: t('admin.dashboard.status'), value: ok ? t('admin.common.normal') : t('admin.common.error'), clr: ok ? 'var(--success)' : 'var(--danger)' },
        { label: t('admin.dashboard.providerCount'), value: providers.length, clr: 'var(--text)' },
        { label: t('admin.dashboard.modelCount'), value: modelCount, clr: 'var(--text)' },
        { label: t('admin.dashboard.adapterCount'), value: adapters.length, clr: 'var(--text)' },
      ]
    },

    get tokenCards() {
      const store = (window as any).Alpine.store('app')
      const ts = store.tokenStats?.today
      if (!ts) return []
      const input = ts.input_tokens || 0
      const output = ts.output_tokens || 0
      const cacheRead = ts.cache_read_input_tokens || 0
      const cacheCreate = ts.cache_creation_input_tokens || 0
      const total = input + output
      const cacheTotal = cacheRead + cacheCreate
      const cacheHitRate = cacheTotal > 0 ? pct(cacheRead, cacheTotal) : '0%'
      return [
        { label: t('admin.dashboard.requests'), value: ts.request_count || 0, clr: 'var(--text)', desc: t('admin.dashboard.today') },
        { label: t('admin.dashboard.inputTokens'), value: fmtNum(input), clr: 'var(--accent)', desc: `${t('admin.dashboard.output')} ${fmtNum(output)} / ${t('admin.dashboard.total')} ${fmtNum(total)}` },
        { label: t('admin.dashboard.cacheHits'), value: fmtNum(cacheRead), clr: 'var(--success)', desc: t('admin.dashboard.hitRate', { rate: cacheHitRate }) },
        { label: t('admin.dashboard.cacheCreation'), value: fmtNum(cacheCreate), clr: 'var(--warn)', desc: t('admin.dashboard.newCacheTokens') },
      ]
    },
  }
}
