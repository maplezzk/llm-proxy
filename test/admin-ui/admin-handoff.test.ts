import { describe, it } from 'node:test'
import assert from 'node:assert'
import { bootstrapAdminHandoff } from '../../admin-ui/src/lib/admin-handoff.js'

describe('admin UI handoff bootstrap', () => {
  it('removes the code before exchange and stores the returned credential', async () => {
    const events: string[] = []
    let saved = ''
    const result = await bootstrapAdminHandoff({
      hash: `#handoff=${'a'.repeat(43)}&tab=dashboard`,
      pathname: '/prefix/admin',
      search: '',
      replaceURL: (url) => events.push(`replace:${url}`),
      exchange: async () => {
        events.push('exchange')
        return 'admin-secret'
      },
      saveCredential: (credential) => {
        events.push('save')
        saved = credential
      },
      showManualEntry: () => events.push('manual'),
    })

    assert.strictEqual(result, 'success')
    assert.strictEqual(saved, 'admin-secret')
    assert.deepStrictEqual(events, [
      'replace:/prefix/admin#dashboard',
      'exchange',
      'save',
    ])
  })

  it('falls back to manual entry after an exchange failure', async () => {
    const events: string[] = []
    const result = await bootstrapAdminHandoff({
      hash: `#handoff=${'b'.repeat(43)}`,
      pathname: '/admin',
      search: '?from=app',
      replaceURL: (url) => events.push(`replace:${url}`),
      exchange: async () => { throw new Error('old server') },
      saveCredential: () => events.push('save'),
      showManualEntry: () => events.push('manual'),
    })

    assert.strictEqual(result, 'failed')
    assert.deepStrictEqual(events, [
      'replace:/admin?from=app#dashboard',
      'manual',
    ])
  })

  it('ignores normal tab fragments', async () => {
    const result = await bootstrapAdminHandoff({
      hash: '#settings',
      pathname: '/admin',
      search: '',
      replaceURL: () => assert.fail('should not replace URL'),
      exchange: async () => assert.fail('should not exchange'),
      saveCredential: () => assert.fail('should not save'),
      showManualEntry: () => assert.fail('should not show manual entry'),
    })
    assert.strictEqual(result, 'none')
  })
})
