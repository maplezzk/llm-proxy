export const ADMIN_KEY_CHANGED_EVENT = 'llm-proxy-admin-key-changed'
import {
  adminCredentialStorageMode,
  browserLocalStorage,
  isManagementServiceRequest,
  managementServiceURL,
  readAdminCredential,
  resolveManagementPath,
  writeAdminCredential,
} from './client-settings'

export function getAdminKey(): string {
  return readAdminCredential(window.location, browserLocalStorage())
}

export function setAdminKey(key: string): 'persistent' | 'session' {
  const mode = writeAdminCredential(key, window.location, browserLocalStorage())
  window.dispatchEvent(new Event(ADMIN_KEY_CHANGED_EVENT))
  return mode
}

export function getAdminKeyStorageMode(): 'persistent' | 'session' {
  return adminCredentialStorageMode()
}

export function getManagementServiceURL(): string {
  return managementServiceURL(window.location)
}

/** 管理 UI 的统一请求入口：自动附加当前浏览器保存的管理 API Key。 */
export async function adminFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  const headers = new Headers(opts.headers)
  const adminKey = getAdminKey()
  const resolvedPath = resolveManagementPath(path, window.location)
  if (
    adminKey
    && isManagementServiceRequest(resolvedPath, window.location)
    && !headers.has('Authorization')
    && !headers.has('x-api-key')
  ) {
    headers.set('Authorization', `Bearer ${adminKey}`)
  }
  return fetch(resolvedPath, { ...opts, headers })
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
