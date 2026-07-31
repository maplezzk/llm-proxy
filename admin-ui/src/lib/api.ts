export const ADMIN_KEY_STORAGE_KEY = 'llm-proxy-admin-key'
export const ADMIN_KEY_CHANGED_EVENT = 'llm-proxy-admin-key-changed'

export function getAdminKey(): string {
  return localStorage.getItem(ADMIN_KEY_STORAGE_KEY)?.trim() ?? ''
}

export function setAdminKey(key: string): void {
  const normalized = key.trim()
  if (normalized) localStorage.setItem(ADMIN_KEY_STORAGE_KEY, normalized)
  else localStorage.removeItem(ADMIN_KEY_STORAGE_KEY)
  window.dispatchEvent(new Event(ADMIN_KEY_CHANGED_EVENT))
}

/** 管理 UI 的统一请求入口：自动附加当前浏览器保存的管理 API Key。 */
export async function adminFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  const headers = new Headers(opts.headers)
  const adminKey = getAdminKey()
  if (adminKey && !headers.has('Authorization') && !headers.has('x-api-key')) {
    headers.set('Authorization', `Bearer ${adminKey}`)
  }
  return fetch(path, { ...opts, headers })
}

/**
 * fetchJson — 对齐旧 store.fetch 行为：
 * 默认携带 Content-Type: application/json，返回解析后的 JSON。
 */
export async function fetchJson<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers = new Headers(opts.headers)
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const r = await adminFetch(path, { ...opts, headers })
  return r.json() as Promise<T>
}
