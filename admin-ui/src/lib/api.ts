/**
 * fetchJson — 对齐旧 store.fetch 行为：
 * 默认携带 Content-Type: application/json，返回解析后的 JSON。
 */
export async function fetchJson<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const r = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...opts.headers },
  })
  return r.json() as Promise<T>
}
