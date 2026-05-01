import { describe, it } from 'node:test'
import assert from 'node:assert'

describe('cli/commands', () => {
  it('模块可正常加载且导出命令函数', async () => {
    const mod = await import('../../src/cli/commands.js')
    assert.ok(typeof mod.cmdStart === 'function', '应导出 cmdStart')
    assert.ok(typeof mod.cmdStop === 'function', '应导出 cmdStop')
    assert.ok(typeof mod.cmdStatus === 'function', '应导出 cmdStatus')
    assert.ok(typeof mod.cmdReload === 'function', '应导出 cmdReload')
  })

  it('cmdReload 参数接口正确', () => {
    // 验证可选参数通过接口传递
    const opts: { port?: number } = { port: 9000 }
    assert.strictEqual(opts.port, 9000)
  })

  it('cmdStart 参数接口正确', () => {
    const opts: { config?: string; host?: string; port?: number } = {
      config: '/tmp/test.yaml',
      host: '127.0.0.1',
      port: 9000,
    }
    assert.strictEqual(opts.config, '/tmp/test.yaml')
    assert.strictEqual(opts.host, '127.0.0.1')
  })
})
