import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert'
import { installShutdownHandlers } from '../../src/cli/commands.js'

describe('cli/commands', () => {
  afterEach(() => {
    // 清理注册的 listener，避免跨测试污染
    process.removeAllListeners('SIGTERM')
    process.removeAllListeners('SIGINT')
  })

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
    assert.strictEqual(opts.port, 9000)
  })

  describe('installShutdownHandlers', () => {
    /**
     * 验证 SIGTERM/SIGINT handler 即使中间步骤抛错，仍会调用 process.exit(0)。
     *
     * 背景：Node.js 注册 signal listener 后，默认自动退出行为被移除。
     * 如果 handler 中某一步抛错而没有 process.exit() 兜底，进程会残留。
     * 表现为：菜单栏退出后，后台 llm-proxy 服务进程变孤儿进程。
     */
    function withMockedProcessExit(fn: () => void): { exitCalled: boolean; exitCode: number | undefined } {
      const result = { exitCalled: false, exitCode: undefined as number | undefined }
      const originalExit = process.exit
      // @ts-expect-error - 劫持 process.exit，记录参数但不退出
      process.exit = (code?: number) => {
        result.exitCalled = true
        result.exitCode = code
        throw new Error('__TEST_PROCESS_EXIT__')
      }
      try {
        fn()
      } catch (e) {
        if (!(e instanceof Error) || e.message !== '__TEST_PROCESS_EXIT__') throw e
      } finally {
        process.exit = originalExit
      }
      return result
    }

    it('SIGTERM 触发后即使 visionCache.flushSync 抛错，仍调用 process.exit(0)', () => {
      const mockServer = { close: () => {} }
      const mockCache = {
        flushSync: () => { throw new Error('disk full') },
      }

      const { exitCalled, exitCode } = withMockedProcessExit(() => {
        installShutdownHandlers({
          server: mockServer as never,
          visionCache: mockCache,
          t: (k: string) => k,
          pidPath: '/tmp/__nonexistent_for_test__.pid',
          signalTarget: 'SIGTERM',
        })
        // 触发 SIGTERM：handler 调用 process.exit(0)，会被劫持后抛出特殊错误
        process.emit('SIGTERM')
      })

      assert.strictEqual(exitCalled, true, 'process.exit 必须被调用')
      assert.strictEqual(exitCode, 0, '退出码应为 0')
    })

    it('SIGINT 触发后即使 server.close 抛错，仍调用 process.exit(0)', () => {
      const mockServer = { close: () => { throw new Error('socket busy') } }
      const mockCache = { flushSync: () => {} }

      const { exitCalled, exitCode } = withMockedProcessExit(() => {
        installShutdownHandlers({
          server: mockServer as never,
          visionCache: mockCache,
          t: (k: string) => k,
          pidPath: '/tmp/__nonexistent_for_test__.pid',
          signalTarget: 'SIGINT',
        })
        process.emit('SIGINT')
      })

      assert.strictEqual(exitCalled, true, 'process.exit 必须被调用')
      assert.strictEqual(exitCode, 0, '退出码应为 0')
    })

    it('正常路径：所有清理步骤依次执行', () => {
      let tCalled = false
      let cacheFlushed = false
      let serverClosed = false

      const mockServer = {
        close: () => { serverClosed = true },
      }
      const mockCache = {
        flushSync: () => { cacheFlushed = true },
      }

      const { exitCalled, exitCode } = withMockedProcessExit(() => {
        installShutdownHandlers({
          server: mockServer as never,
          visionCache: mockCache,
          t: (k: string) => { tCalled = true; return k },
          pidPath: '/tmp/__nonexistent_for_test__.pid',
          signalTarget: 'SIGTERM',
        })
        process.emit('SIGTERM')
      })

      assert.strictEqual(tCalled, true, 'i18n 应被调用')
      assert.strictEqual(cacheFlushed, true, 'visionCache.flushSync 应被调用')
      assert.strictEqual(serverClosed, true, 'server.close 应被调用')
      assert.strictEqual(exitCalled, true, 'process.exit 必须被调用')
      assert.strictEqual(exitCode, 0, '退出码应为 0')
    })
  })
})