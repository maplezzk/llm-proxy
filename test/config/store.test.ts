import { describe, it } from 'node:test'
import assert from 'node:assert'
import { ConfigStore } from '../../src/config/store.js'
import type { Config } from '../../src/config/types.js'

function validConfig(): Config {
  return {
    providers: [
      { name: 'test', type: 'openai', apiKey: 'sk-test', models: [{ id: 'mv' }] },
    ],
  }
}

describe('config/store', () => {
  it('创建 Store 并获取初始配置', () => {
    const config = validConfig()
    const store = new ConfigStore('/fake/path', config)
    const { config: retrieved, version } = store.getConfig()
    assert.strictEqual(retrieved.providers[0].name, 'test')
    assert.strictEqual(version, 0)
  })

  it('reload 失败不影响运行时配置', async () => {
    const config = validConfig()
    const store = new ConfigStore('/nonexistent/path.yaml', config)

    const { config: before } = store.getConfig()
    assert.strictEqual(before.providers[0].apiKey, 'sk-test')

    const result = await store.reload()
    assert.strictEqual(result.success, false)

    const { config: after, version } = store.getConfig()
    assert.strictEqual(after.providers[0].apiKey, 'sk-test')
    assert.strictEqual(version, 0)
  })

  it('初始版本号为 0', () => {
    const store = new ConfigStore('/fake/path', validConfig())
    assert.strictEqual(store.getConfig().version, 0)
  })
})
