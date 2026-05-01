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

  return {
    get stats() {
      const store = (window as any).Alpine.store('app')
      const ok = store.health?.success
      const providers = store.config?.providers ?? []
      const modelCount = providers.reduce((s: number, p: any) => s + (p.models?.length ?? 0), 0)
      const adapters = store.config?.adapters ?? []
      return [
        { label: '运行状态', value: ok ? '正常' : '离线', clr: ok ? 'var(--success)' : 'var(--danger)' },
        { label: '供应商数', value: providers.length, clr: 'var(--text)' },
        { label: '模型总数', value: modelCount, clr: 'var(--text)' },
        { label: '适配器数', value: adapters.length, clr: 'var(--text)' },
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
      const cacheHitRate = input > 0 ? pct(cacheRead, input) : '0%'
      return [
        { label: '请求数', value: ts.request_count || 0, clr: 'var(--text)', desc: '今日' },
        { label: '输入 Token', value: fmtNum(input), clr: 'var(--accent)', desc: `输出 ${fmtNum(output)} / 总计 ${fmtNum(total)}` },
        { label: '缓存命中', value: fmtNum(cacheRead), clr: 'var(--success)', desc: `命中率 ${cacheHitRate}` },
        { label: '缓存创建', value: fmtNum(cacheCreate), clr: 'var(--warn)', desc: '新写入缓存 token' },
      ]
    },
  }
}
