import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  LEGACY_ADMIN_KEY_STORAGE_KEY,
  isManagementServiceRequest,
  managementBasePath,
  managementServiceURL,
  parseAdminHandoffFragment,
  readAdminCredential,
  resolveManagementPath,
  scopedAdminKeyStorageKey,
  writeAdminCredential,
  type KeyValueStorage,
} from '../../admin-ui/src/lib/client-settings.js'

class MemoryStorage implements KeyValueStorage {
  values = new Map<string, string>()

  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
  removeItem(key: string): void { this.values.delete(key) }
}

const root = { origin: 'https://proxy.example.com', pathname: '/admin' }
const prefixed = { origin: 'https://proxy.example.com', pathname: '/llm-proxy/admin/' }

describe('admin UI client settings', () => {
  it('resolves root and reverse-proxy management paths', () => {
    assert.strictEqual(managementBasePath(root.pathname), '')
    assert.strictEqual(managementBasePath(prefixed.pathname), '/llm-proxy')
    assert.strictEqual(resolveManagementPath('/admin/health', root), '/admin/health')
    assert.strictEqual(resolveManagementPath('/admin/health', prefixed), '/llm-proxy/admin/health')
    assert.strictEqual(managementServiceURL(prefixed), 'https://proxy.example.com/llm-proxy')
    assert.strictEqual(isManagementServiceRequest('/llm-proxy/admin/health', prefixed), true)
    assert.strictEqual(isManagementServiceRequest('/other/admin/health', prefixed), false)
    assert.strictEqual(isManagementServiceRequest('https://evil.example/admin/health', prefixed), false)
  })

  it('isolates credentials for services mounted below different paths', () => {
    assert.notStrictEqual(
      scopedAdminKeyStorageKey(prefixed),
      scopedAdminKeyStorageKey({ ...prefixed, pathname: '/other/admin' }),
    )
  })

  it('migrates the legacy origin-wide credential to the current path', () => {
    const storage = new MemoryStorage()
    storage.setItem(LEGACY_ADMIN_KEY_STORAGE_KEY, 'legacy-secret')

    assert.strictEqual(readAdminCredential(prefixed, storage), 'legacy-secret')
    assert.strictEqual(storage.getItem(LEGACY_ADMIN_KEY_STORAGE_KEY), null)
    assert.strictEqual(storage.getItem(scopedAdminKeyStorageKey(prefixed)), 'legacy-secret')
  })

  it('treats an available but empty persistent store as persistent', () => {
    const storage = new MemoryStorage()
    assert.strictEqual(readAdminCredential(prefixed, storage), '')
    assert.strictEqual(writeAdminCredential('saved-secret', prefixed, storage), 'persistent')
    assert.strictEqual(readAdminCredential(prefixed, storage), 'saved-secret')
  })

  it('falls back to session memory when persistent storage is unavailable', () => {
    assert.strictEqual(writeAdminCredential('session-secret', prefixed, null), 'session')
    assert.strictEqual(readAdminCredential(prefixed, null), 'session-secret')
    assert.strictEqual(readAdminCredential({ ...prefixed, pathname: '/other/admin' }, null), '')
  })

  it('accepts only high-entropy handoff fragments', () => {
    const code = 'a'.repeat(43)
    assert.deepStrictEqual(
      parseAdminHandoffFragment(`#handoff=${code}&tab=settings`),
      { code, tab: 'settings' },
    )
    assert.strictEqual(parseAdminHandoffFragment('#handoff=short'), null)
    assert.strictEqual(parseAdminHandoffFragment('#dashboard'), null)
  })
})
