export const LEGACY_ADMIN_KEY_STORAGE_KEY = 'llm-proxy-admin-key'
const ADMIN_KEY_STORAGE_PREFIX = 'llm-proxy-admin-key:'

export interface BrowserLocationLike {
  origin: string
  pathname: string
}

export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface AdminHandoffFragment {
  code: string
  tab: string
}

const sessionCredentials = new Map<string, string>()
let lastStorageMode: 'persistent' | 'session' = 'persistent'

export function managementBasePath(pathname: string): string {
  const normalized = pathname.replace(/\/+$/, '') || '/'
  const match = normalized.match(/^(.*)\/admin(?:\/.*)?$/)
  if (!match) return ''
  const base = match[1].replace(/\/+$/, '')
  return base === '/' ? '' : base
}

export function managementServiceURL(location: BrowserLocationLike): string {
  return `${location.origin}${managementBasePath(location.pathname)}`
}

export function resolveManagementPath(path: string, location: BrowserLocationLike): string {
  if (/^https?:\/\//i.test(path)) return path
  const basePath = managementBasePath(location.pathname)
  if (!basePath || path === basePath || path.startsWith(`${basePath}/`)) return path
  if (path === '/admin' || path.startsWith('/admin/')) return `${basePath}${path}`
  return path
}

export function isManagementServiceRequest(path: string, location: BrowserLocationLike): boolean {
  try {
    const target = new URL(path, `${location.origin}/`)
    if (target.origin !== location.origin) return false
    const adminBase = `${managementBasePath(location.pathname)}/admin`
    return target.pathname === adminBase || target.pathname.startsWith(`${adminBase}/`)
  } catch {
    return false
  }
}

export function scopedAdminKeyStorageKey(location: BrowserLocationLike): string {
  const scope = managementBasePath(location.pathname) || '/'
  return `${ADMIN_KEY_STORAGE_PREFIX}${encodeURIComponent(scope)}`
}

export function parseAdminHandoffFragment(hash: string): AdminHandoffFragment | null {
  const raw = hash.replace(/^#/, '')
  const params = new URLSearchParams(raw)
  const code = params.get('handoff')?.trim() ?? ''
  if (!/^[A-Za-z0-9_-]{40,128}$/.test(code)) return null
  return { code, tab: params.get('tab')?.trim() || 'dashboard' }
}

export function browserLocalStorage(): KeyValueStorage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function readAdminCredential(
  location: BrowserLocationLike,
  storage: KeyValueStorage | null,
): string {
  const scopedKey = scopedAdminKeyStorageKey(location)
  try {
    const stored = storage?.getItem(scopedKey)?.trim() ?? ''
    if (stored) {
      lastStorageMode = 'persistent'
      return stored
    }

    // 旧版按 origin 只保存一个值。首次访问时迁移到当前反代路径，避免后续串用。
    const legacy = storage?.getItem(LEGACY_ADMIN_KEY_STORAGE_KEY)?.trim() ?? ''
    if (legacy) {
      storage?.setItem(scopedKey, legacy)
      storage?.removeItem(LEGACY_ADMIN_KEY_STORAGE_KEY)
      lastStorageMode = 'persistent'
      return legacy
    }
    if (storage) {
      lastStorageMode = 'persistent'
      return ''
    }
  } catch {
    // localStorage 可能因隐私策略抛出 SecurityError，降级到标签页内存。
  }
  lastStorageMode = 'session'
  return sessionCredentials.get(scopedKey) ?? ''
}

export function writeAdminCredential(
  credential: string,
  location: BrowserLocationLike,
  storage: KeyValueStorage | null,
): 'persistent' | 'session' {
  const scopedKey = scopedAdminKeyStorageKey(location)
  const normalized = credential.trim()
  try {
    if (!storage) throw new Error('storage unavailable')
    if (normalized) storage.setItem(scopedKey, normalized)
    else storage.removeItem(scopedKey)
    storage.removeItem(LEGACY_ADMIN_KEY_STORAGE_KEY)
    sessionCredentials.delete(scopedKey)
    lastStorageMode = 'persistent'
    return lastStorageMode
  } catch {
    if (normalized) sessionCredentials.set(scopedKey, normalized)
    else sessionCredentials.delete(scopedKey)
    lastStorageMode = 'session'
    return lastStorageMode
  }
}

export function adminCredentialStorageMode(): 'persistent' | 'session' {
  return lastStorageMode
}
