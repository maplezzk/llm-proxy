// P1.12 阶段 A：从 legacy-test/log/logger.test.ts 机械迁移（node:test → vitest）
// 断言语义保持不变，仅替换测试栈与断言 API。
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Logger } from '../../../legacy-src/log/logger.js'

describe('log/logger', () => {
  it('记录系统事件日志', () => {
    const log = new Logger(100)
    log.log('system', '代理启动', { port: 9000 })
    const entries = log.getLogs()
    expect(entries.length).toBe(1)
    expect(entries[0].type).toBe('system')
    expect(entries[0].message).toBe('代理启动')
    expect((entries[0].details as Record<string, unknown>)?.port).toBe(9000)
    expect(entries[0].level).toBe('info')
  })

  it('默认 level 为 info', () => {
    const log = new Logger(100)
    log.log('system', 'info msg', undefined, 'info')
    log.log('system', 'debug msg', undefined, 'debug')
    expect(log.getStats().total).toBe(1)
  })

  it('设置为 debug 级别时记录所有日志', () => {
    const log = new Logger(100, undefined, 'debug')
    log.log('system', 'debug msg', undefined, 'debug')
    log.log('system', 'info msg', undefined, 'info')
    log.log('system', 'warn msg', undefined, 'warn')
    log.log('system', 'error msg', undefined, 'error')
    expect(log.getStats().total).toBe(4)
  })

  it('设置为 warn 级别时不记录 info 和 debug', () => {
    const log = new Logger(100, undefined, 'warn')
    log.log('system', 'debug msg', undefined, 'debug')
    log.log('system', 'info msg', undefined, 'info')
    log.log('system', 'warn msg', undefined, 'warn')
    log.log('system', 'error msg', undefined, 'error')
    expect(log.getStats().total).toBe(2)
  })

  it('设置为 error 级别时只记录 error', () => {
    const log = new Logger(100, undefined, 'error')
    log.log('system', 'info msg', undefined, 'info')
    log.log('system', 'warn msg', undefined, 'warn')
    log.log('system', 'error msg', undefined, 'error')
    expect(log.getStats().total).toBe(1)
  })

  it('getLogs 支持 level 过滤', () => {
    const log = new Logger(100)
    log.log('request', 'req1', undefined, 'info')
    log.log('request', 'req2', undefined, 'error')
    log.log('request', 'req3', undefined, 'warn')
    const errors = log.getLogs(100, undefined, 'error')
    expect(errors.length).toBe(1)
    expect(errors[0].message).toBe('req2')
    const warns = log.getLogs(100, undefined, 'warn')
    expect(warns.length).toBe(1)
    expect(warns[0].message).toBe('req3')
  })

  it('记录请求日志', () => {
    const log = new Logger(100)
    log.log('request', 'test-provider/openai', { model: 'gpt-4', latency: 150 })
    const entries = log.getLogs()
    expect(entries[0].type).toBe('request')
    expect(entries[0].message).toBe('test-provider/openai')
  })

  it('getLogs 返回最新的日志在前', () => {
    const log = new Logger(100)
    log.log('system', 'first')
    log.log('system', 'second')
    log.log('system', 'third')
    const entries = log.getLogs(2)
    expect(entries.length).toBe(2)
    expect(entries[0].message).toBe('third')
    expect(entries[1].message).toBe('second')
  })

  it('超过 maxEntries 自动裁剪', () => {
    const log = new Logger(5)
    for (let i = 0; i < 10; i++) log.log('system', `entry-${i}`)
    expect(log.getStats().total).toBe(5)
    expect(log.getLogs()[0].message).toBe('entry-9')
  })

  it('before 参数过滤', () => {
    const log = new Logger(100)
    for (let i = 1; i <= 5; i++) log.log('system', `msg-${i}`)
    const entries = log.getLogs(100, 4) // before id 4
    expect(entries.every((e) => e.id < 4)).toBeTruthy()
  })

  it('getStats 返回统计', () => {
    const log = new Logger(100)
    log.log('system', 'start')
    log.log('request', 'req1')
    log.log('request', 'req2')
    const stats = log.getStats()
    expect(stats.total).toBe(3)
    expect(stats.requestCount).toBe(2)
    expect(stats.systemCount).toBe(1)
  })

  it('从文件回读日志（新格式含级别）', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'llm-proxy-test-'))
    const logDir = join(tmpDir, 'logs')
    try {
      const today = new Date().toISOString().slice(0, 10)
      const content = [
        `[${today} 10:00:00.000] [REQ] [INFO] 上游请求: POST https://api.openai.com  {"url":"https://api.openai.com","curl":"curl ..."}`,
        `[${today} 10:00:01.000] [SYS] [ERROR] 模型测试失败  {"error":"timeout"}`,
        `[${today} 10:00:02.000] [REQ] [WARN] 上游返回错误: 429  {"status":429}`,
      ].join('\n')
      mkdirSync(logDir, { recursive: true })
      writeFileSync(join(logDir, `llm-proxy-${today}.log`), content, 'utf-8')

      const log = new Logger(100, tmpDir, 'debug')
      expect(log.getStats().total >= 3).toBeTruthy()

      const entries = log.getLogs(100)
      const errorEntry = entries.find((e) => e.level === 'error')
      expect(errorEntry).toBeTruthy()
      expect(errorEntry!.message).toBe('模型测试失败')

      const warnEntry = entries.find((e) => e.level === 'warn')
      expect(warnEntry).toBeTruthy()
      expect(warnEntry!.message).toBe('上游返回错误: 429')
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
          `[${day1} 10:00:00.000] [REQ] [INFO] 第一天请求1`,
          `[${day1} 10:00:01.000] [REQ] [INFO] 第一天请求2`,
          `[${day1} 10:00:02.000] [REQ] [INFO] 第一天请求3`,
        ].join('\n'), 'utf-8')
      writeFileSync(join(logDir, `llm-proxy-${day2}.log`),
        [
          `[${day2} 10:00:00.000] [REQ] [INFO] 第二天请求1`,
          `[${day2} 10:00:01.000] [REQ] [INFO] 第二天请求2`,
        ].join('\n'), 'utf-8')

      const log = new Logger(100, tmpDir, 'debug')

      // 查第一天
      const day1Logs = log.getLogs(100, undefined, undefined, undefined, day1)
      expect(day1Logs.length, '应返回第一天3条').toBe(3)
      expect(day1Logs.every(e => e.timestamp.startsWith(day1)), '所有条目时间戳应为第一天').toBeTruthy()

      // 查第二天
      const day2Logs = log.getLogs(100, undefined, undefined, undefined, day2)
      expect(day2Logs.length, '应返回第二天2条').toBe(2)
      expect(day2Logs.every(e => e.timestamp.startsWith(day2)), '所有条目时间戳应为第二天').toBeTruthy()

      // 不传 date 返回全部（内存最多 100 条，这儿总共 5 条）
      const allLogs = log.getLogs(100)
      expect(allLogs.length, '不传 date 应返回全部5条').toBe(5)
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
      expect(log.getStats().total, '内存应只保留 3 条').toBe(3)

      // 不加 date：内存 3 条，limit=10 不够会从文件补，最终 5 条
      const noDate = log.getLogs(10)
      expect(noDate.length, '不加 date 内存不够会从文件补全 5 条').toBe(5)

      // 加 date='2026-04-30'：内存只有 3 条（来自昨天），但通过文件补全到 5 条
      const withDate = log.getLogs(10, undefined, undefined, undefined, yesterday)
      expect(withDate.length, '加 date 应返回 5 条（内存3+文件补2）').toBe(5)

      // 关键测试：加一个不存在的日期，应返回 0 条
      const noExist = log.getLogs(10, undefined, undefined, undefined, '2026-01-01')
      expect(noExist.length, '不存在的日期应返回 0 条').toBe(0)
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
      expect(all.length, '不传 date 返回全部 5 条').toBe(5)

      // 查今天（文件不存在）：无数据
      const todayLogs = log.getLogs(10, undefined, undefined, undefined, today)
      // 内存里没有今天的，文件也没有今天的，应该返回空
      expect(todayLogs.length, '今日无日志应返回 0 条').toBe(0)
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
        `[${today} 10:00:00.000] [REQ] 上游请求: POST https://api.openai.com  {"url":"https://api.openai.com"}`,
        `[${today} 10:00:01.000] [SYS] 代理启动  {"port":9000}`,
      ].join('\n')
      mkdirSync(logDir, { recursive: true })
      writeFileSync(join(logDir, `llm-proxy-${today}.log`), content, 'utf-8')

      const log = new Logger(100, tmpDir, 'debug')
      const entries = log.getLogs(100)
      const startupEntry = entries.find((e) => e.message === '代理启动')
      expect(startupEntry).toBeTruthy()
      expect(startupEntry!.level).toBe('info')
      expect((startupEntry!.details as any).port).toBe(9000)

      const reqEntry = entries.find((e) => e.type === 'request')
      expect(reqEntry).toBeTruthy()
      expect(reqEntry!.level).toBe('info')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
