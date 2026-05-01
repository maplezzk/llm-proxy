import { describe, it } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Logger } from '../../src/log/logger.js'

describe('log/logger', () => {
  it('记录系统事件日志', () => {
    const log = new Logger(100)
    log.log('system', '代理启动', { port: 9000 })
    const entries = log.getLogs()
    assert.strictEqual(entries.length, 1)
    assert.strictEqual(entries[0].type, 'system')
    assert.strictEqual(entries[0].message, '代理启动')
    assert.strictEqual((entries[0].details as Record<string, unknown>)?.port, 9000)
    assert.strictEqual(entries[0].level, 'info')
  })

  it('默认 level 为 info', () => {
    const log = new Logger(100)
    log.log('system', 'info msg', undefined, 'info')
    log.log('system', 'debug msg', undefined, 'debug')
    assert.strictEqual(log.getStats().total, 1)
  })

  it('设置为 debug 级别时记录所有日志', () => {
    const log = new Logger(100, undefined, 'debug')
    log.log('system', 'debug msg', undefined, 'debug')
    log.log('system', 'info msg', undefined, 'info')
    log.log('system', 'warn msg', undefined, 'warn')
    log.log('system', 'error msg', undefined, 'error')
    assert.strictEqual(log.getStats().total, 4)
  })

  it('设置为 warn 级别时不记录 info 和 debug', () => {
    const log = new Logger(100, undefined, 'warn')
    log.log('system', 'debug msg', undefined, 'debug')
    log.log('system', 'info msg', undefined, 'info')
    log.log('system', 'warn msg', undefined, 'warn')
    log.log('system', 'error msg', undefined, 'error')
    assert.strictEqual(log.getStats().total, 2)
  })

  it('设置为 error 级别时只记录 error', () => {
    const log = new Logger(100, undefined, 'error')
    log.log('system', 'info msg', undefined, 'info')
    log.log('system', 'warn msg', undefined, 'warn')
    log.log('system', 'error msg', undefined, 'error')
    assert.strictEqual(log.getStats().total, 1)
  })

  it('getLogs 支持 level 过滤', () => {
    const log = new Logger(100)
    log.log('request', 'req1', undefined, 'info')
    log.log('request', 'req2', undefined, 'error')
    log.log('request', 'req3', undefined, 'warn')
    const errors = log.getLogs(100, undefined, 'error')
    assert.strictEqual(errors.length, 1)
    assert.strictEqual(errors[0].message, 'req2')
    const warns = log.getLogs(100, undefined, 'warn')
    assert.strictEqual(warns.length, 1)
    assert.strictEqual(warns[0].message, 'req3')
  })

  it('记录请求日志', () => {
    const log = new Logger(100)
    log.log('request', 'test-provider/openai', { model: 'gpt-4', latency: 150 })
    const entries = log.getLogs()
    assert.strictEqual(entries[0].type, 'request')
    assert.strictEqual(entries[0].message, 'test-provider/openai')
  })

  it('getLogs 返回最新的日志在前', () => {
    const log = new Logger(100)
    log.log('system', 'first')
    log.log('system', 'second')
    log.log('system', 'third')
    const entries = log.getLogs(2)
    assert.strictEqual(entries.length, 2)
    assert.strictEqual(entries[0].message, 'third')
    assert.strictEqual(entries[1].message, 'second')
  })

  it('超过 maxEntries 自动裁剪', () => {
    const log = new Logger(5)
    for (let i = 0; i < 10; i++) log.log('system', `entry-${i}`)
    assert.strictEqual(log.getStats().total, 5)
    assert.strictEqual(log.getLogs()[0].message, 'entry-9')
  })

  it('before 参数过滤', () => {
    const log = new Logger(100)
    for (let i = 1; i <= 5; i++) log.log('system', `msg-${i}`)
    const entries = log.getLogs(100, 4) // before id 4
    assert.ok(entries.every((e) => e.id < 4))
  })

  it('getStats 返回统计', () => {
    const log = new Logger(100)
    log.log('system', 'start')
    log.log('request', 'req1')
    log.log('request', 'req2')
    const stats = log.getStats()
    assert.strictEqual(stats.total, 3)
    assert.strictEqual(stats.requestCount, 2)
    assert.strictEqual(stats.systemCount, 1)
  })

  it('从文件回读日志（新格式含级别）', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'llm-proxy-test-'))
    const logDir = join(tmpDir, 'logs')
    try {
      const today = new Date().toISOString().slice(0, 10)
      const content = [
        `[${today} 10:00:00] [REQ] [INFO] 上游请求: POST https://api.openai.com  {"url":"https://api.openai.com","curl":"curl ..."}`,
        `[${today} 10:00:01] [SYS] [ERROR] 模型测试失败  {"error":"timeout"}`,
        `[${today} 10:00:02] [REQ] [WARN] 上游返回错误: 429  {"status":429}`,
      ].join('\n')
      mkdirSync(logDir, { recursive: true })
      writeFileSync(join(logDir, `llm-proxy-${today}.log`), content, 'utf-8')

      const log = new Logger(100, tmpDir, 'debug')
      assert.ok(log.getStats().total >= 3)

      const entries = log.getLogs(100)
      const errorEntry = entries.find((e) => e.level === 'error')
      assert.ok(errorEntry)
      assert.strictEqual(errorEntry.message, '模型测试失败')

      const warnEntry = entries.find((e) => e.level === 'warn')
      assert.ok(warnEntry)
      assert.strictEqual(warnEntry.message, '上游返回错误: 429')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('从文件回读日志（旧格式无级别，默认 info）', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'llm-proxy-test-'))
    const logDir = join(tmpDir, 'logs')
    try {
      const today = new Date().toISOString().slice(0, 10)
      const content = [
        `[${today} 10:00:00] [REQ] 上游请求: POST https://api.openai.com  {"url":"https://api.openai.com"}`,
        `[${today} 10:00:01] [SYS] 代理启动  {"port":9000}`,
      ].join('\n')
      mkdirSync(logDir, { recursive: true })
      writeFileSync(join(logDir, `llm-proxy-${today}.log`), content, 'utf-8')

      const log = new Logger(100, tmpDir, 'debug')
      const entries = log.getLogs(100)
      const startupEntry = entries.find((e) => e.message === '代理启动')
      assert.ok(startupEntry)
      assert.strictEqual(startupEntry.level, 'info')
      assert.strictEqual((startupEntry.details as any).port, 9000)

      const reqEntry = entries.find((e) => e.type === 'request')
      assert.ok(reqEntry)
      assert.strictEqual(reqEntry.level, 'info')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
