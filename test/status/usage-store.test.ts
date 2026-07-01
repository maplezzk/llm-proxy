import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { UsageStore } from '../../src/status/usage-store.js'

// 同时支持 Node ESM 和 Bun runtime：createRequire 动态加载内部 adapter
const localRequire = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { openSqliteDatabase } = localRequire('../../src/lib/sqlite-client.js') as { openSqliteDatabase: (path: string) => any }

describe('status/usage-store', () => {
  let dir: string
  let dbPath: string
  let store: UsageStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'usage-store-'))
    dbPath = join(dir, 'usage.db')
    store = new UsageStore(dbPath)
  })

  afterEach(() => {
    store.close()
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  })

  describe('record + getStats', () => {
    it('初始无数据时返回全 0', () => {
      const stats = store.getStats()
      assert.strictEqual(stats.today.input_tokens, 0)
      assert.strictEqual(stats.today.output_tokens, 0)
      assert.strictEqual(stats.today.cache_read_input_tokens, 0)
      assert.strictEqual(stats.today.cache_creation_input_tokens, 0)
      assert.strictEqual(stats.today.request_count, 0)
      assert.deepStrictEqual(stats.history, [])
      assert.deepStrictEqual(stats.byProvider, {})
    })

    it('record 后 today 累加', () => {
      store.record({
        provider: 'anthropic', adapter: null, model: 'claude-sonnet', upstreamModel: 'claude-sonnet-4',
        protocol: 'anthropic', source: 'proxy',
        inputTokens: 100, outputTokens: 50, cacheRead: 80, cacheCreate: 0,
      })
      const stats = store.getStats()
      assert.strictEqual(stats.today.input_tokens, 100)
      assert.strictEqual(stats.today.output_tokens, 50)
      assert.strictEqual(stats.today.cache_read_input_tokens, 80)
      assert.strictEqual(stats.today.cache_creation_input_tokens, 0)
      assert.strictEqual(stats.today.request_count, 1)
      assert.strictEqual(stats.byProvider.anthropic.input_tokens, 100)
    })

    it('byProvider 按 provider 分组', () => {
      store.record({ provider: 'anthropic', adapter: null, model: 'm1', upstreamModel: 'm1', protocol: 'anthropic', source: 'proxy', inputTokens: 100, outputTokens: 50, cacheRead: 80, cacheCreate: 0 })
      store.record({ provider: 'deepseek', adapter: null, model: 'm2', upstreamModel: 'm2', protocol: 'openai', source: 'proxy', inputTokens: 200, outputTokens: 100, cacheRead: 0, cacheCreate: 50 })
      const stats = store.getStats()
      assert.strictEqual(stats.byProvider.anthropic.input_tokens, 100)
      assert.strictEqual(stats.byProvider.deepseek.input_tokens, 200)
      assert.strictEqual(stats.byProvider.deepseek.cache_creation_input_tokens, 50)
    })

    it('多次 record 累加', () => {
      for (let i = 0; i < 3; i++) {
        store.record({ provider: 'p1', adapter: null, model: 'm', upstreamModel: 'm', protocol: 'openai', source: 'proxy', inputTokens: 10, outputTokens: 5, cacheRead: 0, cacheCreate: 0 })
      }
      const stats = store.getStats()
      assert.strictEqual(stats.today.request_count, 3)
      assert.strictEqual(stats.today.input_tokens, 30)
      assert.strictEqual(stats.today.output_tokens, 15)
    })
  })

  describe('adapter 维度', () => {
    it('adapter 不为 null 时正确记录', () => {
      store.record({ provider: 'anthropic', adapter: 'my-tool', model: 'claude-sonnet', upstreamModel: 'claude-sonnet-4', protocol: 'anthropic', source: 'my-tool', inputTokens: 100, outputTokens: 50, cacheRead: 80, cacheCreate: 0 })
      const breakdown = store.getBreakdown('adapter', { range: 'today' })
      assert.strictEqual(breakdown.length, 1)
      assert.strictEqual(breakdown[0].key, 'my-tool')
      assert.strictEqual(breakdown[0].input_tokens, 100)
    })

    it('adapter 为 null 时显示为 (direct proxy)', () => {
      store.record({ provider: 'deepseek', adapter: null, model: 'deepseek-chat', upstreamModel: 'deepseek-chat', protocol: 'openai', source: 'proxy', inputTokens: 100, outputTokens: 50, cacheRead: 0, cacheCreate: 0 })
      const breakdown = store.getBreakdown('adapter', { range: 'today' })
      assert.strictEqual(breakdown[0].key, '(direct proxy)')
    })

    it('同一 provider 下不同 adapter 分别记录', () => {
      store.record({ provider: 'anthropic', adapter: null, model: 'm', upstreamModel: 'm', protocol: 'anthropic', source: 'proxy', inputTokens: 100, outputTokens: 50, cacheRead: 0, cacheCreate: 0 })
      store.record({ provider: 'anthropic', adapter: 'tool-a', model: 'm', upstreamModel: 'm', protocol: 'anthropic', source: 'tool-a', inputTokens: 200, outputTokens: 80, cacheRead: 100, cacheCreate: 0 })
      store.record({ provider: 'anthropic', adapter: 'tool-b', model: 'm', upstreamModel: 'm', protocol: 'anthropic', source: 'tool-b', inputTokens: 300, outputTokens: 100, cacheRead: 0, cacheCreate: 50 })

      const breakdown = store.getBreakdown('adapter', { range: 'today' })
      // 排序：input_tokens DESC，所以顺序应为 tool-b(300) > tool-a(200) > (direct proxy)(100)
      assert.strictEqual(breakdown.length, 3)
      assert.strictEqual(breakdown[0].key, 'tool-b')
      assert.strictEqual(breakdown[1].key, 'tool-a')
      assert.strictEqual(breakdown[2].key, '(direct proxy)')
      assert.strictEqual(breakdown[0].input_tokens, 300)
    })

    it('getBreakdown by model 正确分组', () => {
      store.record({ provider: 'p1', adapter: null, model: 'gpt-4', upstreamModel: 'gpt-4', protocol: 'openai', source: 'proxy', inputTokens: 100, outputTokens: 50, cacheRead: 0, cacheCreate: 0 })
      store.record({ provider: 'p1', adapter: null, model: 'gpt-3.5', upstreamModel: 'gpt-3.5', protocol: 'openai', source: 'proxy', inputTokens: 200, outputTokens: 80, cacheRead: 0, cacheCreate: 0 })
      store.record({ provider: 'p1', adapter: null, model: 'gpt-4', upstreamModel: 'gpt-4', protocol: 'openai', source: 'proxy', inputTokens: 50, outputTokens: 25, cacheRead: 0, cacheCreate: 0 })
      const breakdown = store.getBreakdown('model', { range: 'today' })
      assert.strictEqual(breakdown.length, 2)
      assert.strictEqual(breakdown[0].key, 'gpt-3.5')  // 200 > 150
      assert.strictEqual(breakdown[1].key, 'gpt-4')
      assert.strictEqual(breakdown[1].request_count, 2)
    })
  })

  describe('持久化（重启保留）', () => {
    it('close 后重新打开数据仍在', () => {
      store.record({ provider: 'p1', adapter: null, model: 'm', upstreamModel: 'm', protocol: 'openai', source: 'proxy', inputTokens: 100, outputTokens: 50, cacheRead: 10, cacheCreate: 20 })
      store.close()

      // 模拟重启：重新打开同一个 db
      const store2 = new UsageStore(dbPath)
      const stats = store2.getStats()
      assert.strictEqual(stats.today.input_tokens, 100)
      assert.strictEqual(stats.today.output_tokens, 50)
      assert.strictEqual(stats.today.cache_read_input_tokens, 10)
      assert.strictEqual(stats.today.cache_creation_input_tokens, 20)
      assert.strictEqual(stats.today.request_count, 1)
      store2.close()
    })

    it('db 文件确实被创建', () => {
      store.record({ provider: 'p1', adapter: null, model: 'm', upstreamModel: 'm', protocol: 'openai', source: 'proxy', inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheCreate: 0 })
      store.close()
      assert.ok(existsSync(dbPath), 'usage.db 应被创建')
      const stat = statSync(dbPath)
      assert.ok(stat.size > 0, 'usage.db 不应为空')
    })
  })

  describe('getTimeline', () => {
    it('无历史数据时返回 N 天全 0', () => {
      const timeline = store.getTimeline({ days: 7 })
      assert.strictEqual(timeline.length, 7)
      for (const p of timeline) {
        assert.strictEqual(p.input_tokens, 0)
        assert.strictEqual(p.request_count, 0)
      }
      // 日期连续、升序
      assert.ok(timeline[0].date < timeline[6].date)
    })

    it('请求数据正确反映在 timeline', () => {
      store.record({ provider: 'p1', adapter: null, model: 'm', upstreamModel: 'm', protocol: 'openai', source: 'proxy', inputTokens: 100, outputTokens: 50, cacheRead: 10, cacheCreate: 0 })
      const timeline = store.getTimeline({ days: 7 })
      const today = timeline[timeline.length - 1]
      assert.strictEqual(today.input_tokens, 100)
      assert.strictEqual(today.request_count, 1)
    })

    it('days=1 只返回今天', () => {
      const timeline = store.getTimeline({ days: 1 })
      assert.strictEqual(timeline.length, 1)
    })

    it('默认参数等价于 days=30', () => {
      const timeline = store.getTimeline()
      assert.strictEqual(timeline.length, 30)
    })

    it('自定义 startDate/endDate 返回 [start, end] 范围内连续日期（含两端）', () => {
      const db = openSqliteDatabase(dbPath)
      // 插入历史日期数据（避开 today，避免边界混淆）
      db.prepare(`
        INSERT INTO daily_aggregates (date, provider, adapter, model, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, request_count)
        VALUES ('2025-06-15', 'p1', '', 'm', 100, 50, 0, 0, 1)
      `).run()
      db.prepare(`
        INSERT INTO daily_aggregates (date, provider, adapter, model, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, request_count)
        VALUES ('2025-06-17', 'p1', '', 'm', 200, 80, 0, 0, 2)
      `).run()
      db.close()

      const timeline = store.getTimeline({ startDate: '2025-06-15', endDate: '2025-06-17' })
      assert.strictEqual(timeline.length, 3, '应返回 3 天连续日期')
      assert.strictEqual(timeline[0].date, '2025-06-15')
      assert.strictEqual(timeline[1].date, '2025-06-16')
      assert.strictEqual(timeline[2].date, '2025-06-17')
      assert.strictEqual(timeline[0].input_tokens, 100, '06-15 数据应回填')
      assert.strictEqual(timeline[1].input_tokens, 0, '06-16 缺失补 0')
      assert.strictEqual(timeline[2].input_tokens, 200, '06-17 数据应回填')
      assert.strictEqual(timeline[1].request_count, 0)
    })

    it('startDate === endDate 只返回那一天', () => {
      const db = openSqliteDatabase(dbPath)
      db.prepare(`
        INSERT INTO daily_aggregates (date, provider, adapter, model, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, request_count)
        VALUES ('2025-06-15', 'p1', '', 'm', 100, 50, 0, 0, 1)
      `).run()
      db.close()

      const timeline = store.getTimeline({ startDate: '2025-06-15', endDate: '2025-06-15' })
      assert.strictEqual(timeline.length, 1)
      assert.strictEqual(timeline[0].input_tokens, 100)
    })
  })

  describe('getBreakdown 自定义日期范围', () => {
    it('startDate/endDate 与 days 互不影响', () => {
      const db = openSqliteDatabase(dbPath)
      db.prepare(`INSERT INTO daily_aggregates (date, provider, adapter, model, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, request_count) VALUES ('2025-06-15', 'p1', '', 'm', 100, 50, 0, 0, 1)`).run()
      db.prepare(`INSERT INTO daily_aggregates (date, provider, adapter, model, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, request_count) VALUES ('2025-06-16', 'p2', '', 'm', 200, 80, 0, 0, 2)`).run()
      db.close()

      // 自定义范围：只含 06-15
      const b1 = store.getBreakdown('provider', { startDate: '2025-06-15', endDate: '2025-06-15' })
      assert.deepStrictEqual(b1.map(b => b.key), ['p1'])
      // range=7d：今天被记录但 p1/p2 是历史，不返
      const b2 = store.getBreakdown('provider', { range: '7d' })
      assert.deepStrictEqual(b2, [])
      // range=all：p1 + p2
      const b3 = store.getBreakdown('provider', { range: 'all' })
      assert.deepStrictEqual(b3.map(b => b.key).sort(), ['p1', 'p2'])
    })

    it('startDate/endDate 合并多天同维度数据', () => {
      const db = openSqliteDatabase(dbPath)
      db.prepare(`INSERT INTO daily_aggregates (date, provider, adapter, model, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, request_count) VALUES ('2025-06-15', 'p1', '', 'm', 100, 50, 0, 0, 1)`).run()
      db.prepare(`INSERT INTO daily_aggregates (date, provider, adapter, model, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, request_count) VALUES ('2025-06-16', 'p1', '', 'm', 200, 80, 0, 0, 2)`).run()
      db.close()

      const b = store.getBreakdown('provider', { startDate: '2025-06-15', endDate: '2025-06-16' })
      assert.strictEqual(b.length, 1)
      assert.strictEqual(b[0].key, 'p1')
      assert.strictEqual(b[0].input_tokens, 300, '两天 input_tokens 应合并')
      assert.strictEqual(b[0].request_count, 3)
    })
  })

  describe('cleanup', () => {
    it('清理 90 天前的数据', () => {
      // 模拟插入一条历史日期的数据（通过直接 SQL，因为 record 只插今天）
      const db = openSqliteDatabase(dbPath)
      const oldDate = '2020-01-01'
      db.prepare(`
        INSERT INTO daily_aggregates (date, provider, adapter, model, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, request_count)
        VALUES (?, 'p1', '', 'm', 100, 50, 0, 0, 1)
      `).run(oldDate)
      db.prepare(`
        INSERT INTO usage_events (ts, date, provider, adapter, model, upstream_model, protocol, source, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens)
        VALUES (?, ?, 'p1', NULL, 'm', 'm', 'openai', 'proxy', 100, 50, 0, 0)
      `).run(Date.now(), oldDate)
      db.close()

      const result = store.cleanup(90)
      assert.ok(result.events >= 1, '应清理至少 1 条事件')
      assert.ok(result.aggregates >= 1, '应清理至少 1 条聚合')

      // 验证：今天的统计数据不受影响
      store.record({ provider: 'p1', adapter: null, model: 'm', upstreamModel: 'm', protocol: 'openai', source: 'proxy', inputTokens: 5, outputTokens: 5, cacheRead: 0, cacheCreate: 0 })
      const stats = store.getStats()
      assert.strictEqual(stats.today.input_tokens, 5, '今日数据应保留')
    })
  })

  describe('stats', () => {
    it('返回条目数与文件大小', () => {
      store.record({ provider: 'p1', adapter: null, model: 'm', upstreamModel: 'm', protocol: 'openai', source: 'proxy', inputTokens: 10, outputTokens: 5, cacheRead: 0, cacheCreate: 0 })
      const s = store.stats()
      assert.ok(s.events >= 1)
      assert.ok(s.aggregates >= 1)
      assert.ok(s.sizeBytes > 0)
    })
  })

  describe('并发安全', () => {
    it('连续 record 无数据丢失', () => {
      const N = 1000
      for (let i = 0; i < N; i++) {
        store.record({ provider: 'p1', adapter: null, model: 'm', upstreamModel: 'm', protocol: 'openai', source: 'proxy', inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheCreate: 0 })
      }
      const stats = store.getStats()
      assert.strictEqual(stats.today.request_count, N)
      assert.strictEqual(stats.today.input_tokens, N)
      const s = store.stats()
      assert.strictEqual(s.events, N)
    })
  })
})