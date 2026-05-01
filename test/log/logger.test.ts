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

  it('getLogs 按日期筛选', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'llm-proxy-test-'))
    const logDir = join(tmpDir, 'logs')
    try {
      mkdirSync(logDir, { recursive: true })
      // 写两天的日志文件
      const day1 = '2026-04-30'
      const day2 = '2026-05-01'
      writeFileSync(join(logDir, `llm-proxy-${day1}.log`),
        [
          `[${day1} 10:00:00] [REQ] [INFO] 第一天请求1`,
          `[${day1} 10:00:01] [REQ] [INFO] 第一天请求2`,
          `[${day1} 10:00:02] [REQ] [INFO] 第一天请求3`,
        ].join('\n'), 'utf-8')
      writeFileSync(join(logDir, `llm-proxy-${day2}.log`),
        [
          `[${day2} 10:00:00] [REQ] [INFO] 第二天请求1`,
          `[${day2} 10:00:01] [REQ] [INFO] 第二天请求2`,
        ].join('\n'), 'utf-8')

      const log = new Logger(100, tmpDir, 'debug')

      // 查第一天
      const day1Logs = log.getLogs(100, undefined, undefined, undefined, day1)
      assert.strictEqual(day1Logs.length, 3, '应返回第一天3条')
      assert.ok(day1Logs.every(e => e.timestamp.startsWith(day1)), '所有条目时间戳应为第一天')

      // 查第二天
      const day2Logs = log.getLogs(100, undefined, undefined, undefined, day2)
      assert.strictEqual(day2Logs.length, 2, '应返回第二天2条')
      assert.ok(day2Logs.every(e => e.timestamp.startsWith(day2)), '所有条目时间戳应为第二天')

      // 不传 date 返回全部（内存最多 100 条，这儿总共 5 条）
      const allLogs = log.getLogs(100)
      assert.strictEqual(allLogs.length, 5, '不传 date 应返回全部5条')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('getLogs 日期查询：内存满了之后从文件补', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'llm-proxy-test-'))
    const logDir = join(tmpDir, 'logs')
    try {
      mkdirSync(logDir, { recursive: true })
      const yesterday = '2026-04-30'
      const today = new Date().toISOString().slice(0, 10)
      // 昨天文件写入 5 条
      writeFileSync(join(logDir, `llm-proxy-${yesterday}.log`),
        Array.from({ length: 5 }, (_, i) =>
          `[${yesterday} ${String(10 + i).padStart(2, '0')}:00:00] [REQ] [INFO] 昨日日志${i}`
        ).join('\n'), 'utf-8')

      // 创建小内存 Logger（只保留 3 条），加载时昨天文件读 5 条但只能留 3 条
      const log = new Logger(3, tmpDir, 'debug')

      // 此时内存只有 3 条，昨天共 5 条
      assert.strictEqual(log.getStats().total, 3, '内存应只保留 3 条')

      // 不加 date：内存 3 条，limit=10 不够会从文件补，最终 5 条
      const noDate = log.getLogs(10)
      assert.strictEqual(noDate.length, 5, '不加 date 内存不够会从文件补全 5 条')

      // 加 date='2026-04-30'：内存只有 3 条（来自昨天），但通过文件补全到 5 条
      const withDate = log.getLogs(10, undefined, undefined, undefined, yesterday)
      assert.strictEqual(withDate.length, 5, '加 date 应返回 5 条（内存3+文件补2）')

      // 关键测试：加一个不存在的日期，应返回 0 条
      const noExist = log.getLogs(10, undefined, undefined, undefined, '2026-01-01')
      assert.strictEqual(noExist.length, 0, '不存在的日期应返回 0 条')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('getLogs 日期查询：内存有数据但当日日志文件不存在', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'llm-proxy-test-'))
    const logDir = join(tmpDir, 'logs')
    try {
      mkdirSync(logDir, { recursive: true })
      const yesterday = '2026-04-30'
      const today = '2026-05-01'
      // 只写昨天文件
      writeFileSync(join(logDir, `llm-proxy-${yesterday}.log`),
        Array.from({ length: 5 }, (_, i) =>
          `[${yesterday} ${String(10 + i).padStart(2, '0')}:00:00] [REQ] [INFO] 日志${i}`
        ).join('\n'), 'utf-8')

      const log = new Logger(10, tmpDir, 'debug')

      // 不传 date：返回全部
      const all = log.getLogs(10)
      assert.strictEqual(all.length, 5, '不传 date 返回全部 5 条')

      // 查今天（文件不存在）：无数据
      const todayLogs = log.getLogs(10, undefined, undefined, undefined, today)
      // 内存里没有今天的，文件也没有今天的，应该返回空
      assert.strictEqual(todayLogs.length, 0, '今日无日志应返回 0 条')
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
