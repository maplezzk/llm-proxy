// P1.12 阶段 B：从 legacy-test/status/usage-store.test.ts 机械迁移（node:test → vitest）
// 断言语义保持不变，仅替换测试栈与断言 API。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UsageStore } from '../../../legacy-src/status/usage-store.js'
// 迁移说明：原 node:test 版本用 createRequire 动态加载 sqlite-client（兼容 tsx/Bun 的 .js→.ts 解析）。
// vitest 的 ESM 解析器原生支持 .js→.ts，故改为普通 ESM import，语义不变（仍是拿 openSqliteDatabase 直接插 SQL）。
import { openSqliteDatabase } from '../../../legacy-src/lib/sqlite-client.js'

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
      expect(stats.today.input_tokens).toBe(0)
      expect(stats.today.output_tokens).toBe(0)
      expect(stats.today.cache_read_input_tokens).toBe(0)
      expect(stats.today.cache_creation_input_tokens).toBe(0)
      expect(stats.today.request_count).toBe(0)
      expect(stats.history).toEqual([])
      expect(stats.byProvider).toEqual({})
    })

    it('record 后 today 累加', () => {
      store.record({
        provider: 'anthropic', adapter: null, model: 'claude-sonnet', upstreamModel: 'claude-sonnet-4',
        protocol: 'anthropic', source: 'proxy',
        inputTokens: 100, outputTokens: 50, cacheRead: 80, cacheCreate: 0,
      })
      const stats = store.getStats()
      expect(stats.today.input_tokens).toBe(100)
      expect(stats.today.output_tokens).toBe(50)
      expect(stats.today.cache_read_input_tokens).toBe(80)
      expect(stats.today.cache_creation_input_tokens).toBe(0)
      expect(stats.today.request_count).toBe(1)
      expect(stats.byProvider.anthropic.input_tokens).toBe(100)
    })

    it('byProvider 按 provider 分组', () => {
      store.record({ provider: 'anthropic', adapter: null, model: 'm1', upstreamModel: 'm1', protocol: 'anthropic', source: 'proxy', inputTokens: 100, outputTokens: 50, cacheRead: 80, cacheCreate: 0 })
      store.record({ provider: 'deepseek', adapter: null, model: 'm2', upstreamModel: 'm2', protocol: 'openai', source: 'proxy', inputTokens: 200, outputTokens: 100, cacheRead: 0, cacheCreate: 50 })
      const stats = store.getStats()
      expect(stats.byProvider.anthropic.input_tokens).toBe(100)
      expect(stats.byProvider.deepseek.input_tokens).toBe(200)
      expect(stats.byProvider.deepseek.cache_creation_input_tokens).toBe(50)
    })

    it('多次 record 累加', () => {
      for (let i = 0; i < 3; i++) {
        store.record({ provider: 'p1', adapter: null, model: 'm', upstreamModel: 'm', protocol: 'openai', source: 'proxy', inputTokens: 10, outputTokens: 5, cacheRead: 0, cacheCreate: 0 })
      }
      const stats = store.getStats()
      expect(stats.today.request_count).toBe(3)
      expect(stats.today.input_tokens).toBe(30)
      expect(stats.today.output_tokens).toBe(15)
    })
  })

  describe('adapter 维度', () => {
    it('adapter 不为 null 时正确记录', () => {
      store.record({ provider: 'anthropic', adapter: 'my-tool', model: 'claude-sonnet', upstreamModel: 'claude-sonnet-4', protocol: 'anthropic', source: 'my-tool', inputTokens: 100, outputTokens: 50, cacheRead: 80, cacheCreate: 0 })
      const breakdown = store.getBreakdown('adapter', { range: 'today' })
      expect(breakdown.length).toBe(1)
      expect(breakdown[0].key).toBe('my-tool')
      expect(breakdown[0].input_tokens).toBe(100)
    })

    it('adapter 为 null 时显示为 (direct proxy)', () => {
      store.record({ provider: 'deepseek', adapter: null, model: 'deepseek-chat', upstreamModel: 'deepseek-chat', protocol: 'openai', source: 'proxy', inputTokens: 100, outputTokens: 50, cacheRead: 0, cacheCreate: 0 })
      const breakdown = store.getBreakdown('adapter', { range: 'today' })
      expect(breakdown[0].key).toBe('(direct proxy)')
    })

    it('同一 provider 下不同 adapter 分别记录', () => {
      store.record({ provider: 'anthropic', adapter: null, model: 'm', upstreamModel: 'm', protocol: 'anthropic', source: 'proxy', inputTokens: 100, outputTokens: 50, cacheRead: 0, cacheCreate: 0 })
      store.record({ provider: 'anthropic', adapter: 'tool-a', model: 'm', upstreamModel: 'm', protocol: 'anthropic', source: 'tool-a', inputTokens: 200, outputTokens: 80, cacheRead: 100, cacheCreate: 0 })
      store.record({ provider: 'anthropic', adapter: 'tool-b', model: 'm', upstreamModel: 'm', protocol: 'anthropic', source: 'tool-b', inputTokens: 300, outputTokens: 100, cacheRead: 0, cacheCreate: 50 })

      const breakdown = store.getBreakdown('adapter', { range: 'today' })
      // 排序：input_tokens DESC，所以顺序应为 tool-b(300) > tool-a(200) > (direct proxy)(100)
      expect(breakdown.length).toBe(3)
      expect(breakdown[0].key).toBe('tool-b')
      expect(breakdown[1].key).toBe('tool-a')
      expect(breakdown[2].key).toBe('(direct proxy)')
      expect(breakdown[0].input_tokens).toBe(300)
    })

    it('getBreakdown by model 正确分组', () => {
      store.record({ provider: 'p1', adapter: null, model: 'gpt-4', upstreamModel: 'gpt-4', protocol: 'openai', source: 'proxy', inputTokens: 100, outputTokens: 50, cacheRead: 0, cacheCreate: 0 })
      store.record({ provider: 'p1', adapter: null, model: 'gpt-3.5', upstreamModel: 'gpt-3.5', protocol: 'openai', source: 'proxy', inputTokens: 200, outputTokens: 80, cacheRead: 0, cacheCreate: 0 })
      store.record({ provider: 'p1', adapter: null, model: 'gpt-4', upstreamModel: 'gpt-4', protocol: 'openai', source: 'proxy', inputTokens: 50, outputTokens: 25, cacheRead: 0, cacheCreate: 0 })
      const breakdown = store.getBreakdown('model', { range: 'today' })
      expect(breakdown.length).toBe(2)
      expect(breakdown[0].key).toBe('gpt-3.5')  // 200 > 150
      expect(breakdown[1].key).toBe('gpt-4')
      expect(breakdown[1].request_count).toBe(2)
    })

    it('getBreakdown by model 按上游真实模型分组（适配器虚拟名不出现）', () => {
      // 适配器请求：model 是虚拟名，upstreamModel 是真实模型 id
      store.record({ provider: 'p1', adapter: 'my-tool', model: 'GPT', upstreamModel: 'gpt-5.5', protocol: 'openai', source: 'my-tool', inputTokens: 300, outputTokens: 100, cacheRead: 0, cacheCreate: 0 })
      // 直连请求：model 与 upstreamModel 相同
      store.record({ provider: 'p1', adapter: null, model: 'gpt-5.5', upstreamModel: 'gpt-5.5', protocol: 'openai', source: 'proxy', inputTokens: 100, outputTokens: 50, cacheRead: 0, cacheCreate: 0 })
      const breakdown = store.getBreakdown('model', { range: 'today' })
      expect(breakdown.length, '同一上游模型应合并为一组').toBe(1)
      expect(breakdown[0].key).toBe('gpt-5.5')
      expect(breakdown[0].input_tokens).toBe(400)
      expect(breakdown[0].request_count).toBe(2)
    })

    it('getBreakdown by adapterModel 只含适配器请求的虚拟模型名', () => {
      // 适配器请求：虚拟名 GPT/MAX
      store.record({ provider: 'p1', adapter: 'my-tool', model: 'GPT', upstreamModel: 'gpt-5.5', protocol: 'openai', source: 'my-tool', inputTokens: 300, outputTokens: 100, cacheRead: 0, cacheCreate: 0 })
      store.record({ provider: 'p1', adapter: 'my-tool', model: 'MAX', upstreamModel: 'claude-opus-4', protocol: 'anthropic', source: 'my-tool', inputTokens: 200, outputTokens: 80, cacheRead: 0, cacheCreate: 0 })
      // 直连请求：真实模型 id，不应出现在适配器模型维度
      store.record({ provider: 'p1', adapter: null, model: 'gpt-5.5', upstreamModel: 'gpt-5.5', protocol: 'openai', source: 'proxy', inputTokens: 999, outputTokens: 50, cacheRead: 0, cacheCreate: 0 })
      const breakdown = store.getBreakdown('adapterModel', { range: 'today' })
      expect(breakdown.length).toBe(2)
      expect(breakdown[0].key).toBe('GPT') // 300 > 200
      expect(breakdown[1].key).toBe('MAX')
      expect(!breakdown.some((b) => b.key === 'gpt-5.5'), '直连请求的真实模型不应混入').toBeTruthy()
    })
  })

  describe('持久化（重启保留）', () => {
    it('close 后重新打开数据仍在', () => {
      store.record({ provider: 'p1', adapter: null, model: 'm', upstreamModel: 'm', protocol: 'openai', source: 'proxy', inputTokens: 100, outputTokens: 50, cacheRead: 10, cacheCreate: 20 })
      store.close()

      // 模拟重启：重新打开同一个 db
      const store2 = new UsageStore(dbPath)
      const stats = store2.getStats()
      expect(stats.today.input_tokens).toBe(100)
      expect(stats.today.output_tokens).toBe(50)
      expect(stats.today.cache_read_input_tokens).toBe(10)
      expect(stats.today.cache_creation_input_tokens).toBe(20)
      expect(stats.today.request_count).toBe(1)
      store2.close()
    })

    it('db 文件确实被创建', () => {
      store.record({ provider: 'p1', adapter: null, model: 'm', upstreamModel: 'm', protocol: 'openai', source: 'proxy', inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheCreate: 0 })
      store.close()
      expect(existsSync(dbPath), 'usage.db 应被创建').toBeTruthy()
      const stat = statSync(dbPath)
      expect(stat.size > 0, 'usage.db 不应为空').toBeTruthy()
    })
  })

  describe('getTimeline', () => {
    it('无历史数据时返回 N 天全 0', () => {
      const timeline = store.getTimeline({ days: 7 })
      expect(timeline.length).toBe(7)
      for (const p of timeline) {
        expect(p.input_tokens).toBe(0)
        expect(p.request_count).toBe(0)
      }
      // 日期连续、升序
      expect(timeline[0].date < timeline[6].date).toBeTruthy()
    })

    it('请求数据正确反映在 timeline', () => {
      store.record({ provider: 'p1', adapter: null, model: 'm', upstreamModel: 'm', protocol: 'openai', source: 'proxy', inputTokens: 100, outputTokens: 50, cacheRead: 10, cacheCreate: 0 })
      const timeline = store.getTimeline({ days: 7 })
      const today = timeline[timeline.length - 1]
      expect(today.input_tokens).toBe(100)
      expect(today.request_count).toBe(1)
    })

    it('days=1 只返回今天', () => {
      const timeline = store.getTimeline({ days: 1 })
      expect(timeline.length).toBe(1)
    })

    it('默认参数等价于 days=30', () => {
      const timeline = store.getTimeline()
      expect(timeline.length).toBe(30)
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
      expect(timeline.length, '应返回 3 天连续日期').toBe(3)
      expect(timeline[0].date).toBe('2025-06-15')
      expect(timeline[1].date).toBe('2025-06-16')
      expect(timeline[2].date).toBe('2025-06-17')
      expect(timeline[0].input_tokens, '06-15 数据应回填').toBe(100)
      expect(timeline[1].input_tokens, '06-16 缺失补 0').toBe(0)
      expect(timeline[2].input_tokens, '06-17 数据应回填').toBe(200)
      expect(timeline[1].request_count).toBe(0)
    })

    it('startDate === endDate 只返回那一天', () => {
      const db = openSqliteDatabase(dbPath)
      db.prepare(`
        INSERT INTO daily_aggregates (date, provider, adapter, model, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, request_count)
        VALUES ('2025-06-15', 'p1', '', 'm', 100, 50, 0, 0, 1)
      `).run()
      db.close()

      const timeline = store.getTimeline({ startDate: '2025-06-15', endDate: '2025-06-15' })
      expect(timeline.length).toBe(1)
      expect(timeline[0].input_tokens).toBe(100)
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
      expect(b1.map(b => b.key)).toEqual(['p1'])
      // range=7d：今天被记录但 p1/p2 是历史，不返
      const b2 = store.getBreakdown('provider', { range: '7d' })
      expect(b2).toEqual([])
      // range=all：p1 + p2
      const b3 = store.getBreakdown('provider', { range: 'all' })
      expect(b3.map(b => b.key).sort()).toEqual(['p1', 'p2'])
    })

    it('startDate/endDate 合并多天同维度数据', () => {
      const db = openSqliteDatabase(dbPath)
      db.prepare(`INSERT INTO daily_aggregates (date, provider, adapter, model, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, request_count) VALUES ('2025-06-15', 'p1', '', 'm', 100, 50, 0, 0, 1)`).run()
      db.prepare(`INSERT INTO daily_aggregates (date, provider, adapter, model, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, request_count) VALUES ('2025-06-16', 'p1', '', 'm', 200, 80, 0, 0, 2)`).run()
      db.close()

      const b = store.getBreakdown('provider', { startDate: '2025-06-15', endDate: '2025-06-16' })
      expect(b.length).toBe(1)
      expect(b[0].key).toBe('p1')
      expect(b[0].input_tokens, '两天 input_tokens 应合并').toBe(300)
      expect(b[0].request_count).toBe(3)
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
      expect(result.events >= 1, '应清理至少 1 条事件').toBeTruthy()
      expect(result.aggregates >= 1, '应清理至少 1 条聚合').toBeTruthy()

      // 验证：今天的统计数据不受影响
      store.record({ provider: 'p1', adapter: null, model: 'm', upstreamModel: 'm', protocol: 'openai', source: 'proxy', inputTokens: 5, outputTokens: 5, cacheRead: 0, cacheCreate: 0 })
      const stats = store.getStats()
      expect(stats.today.input_tokens, '今日数据应保留').toBe(5)
    })

    it('clearAll 清空全部数据（含今日内存缓存）', () => {
      store.record({ provider: 'p1', adapter: null, model: 'm', upstreamModel: 'm', protocol: 'openai', source: 'proxy', inputTokens: 100, outputTokens: 50, cacheRead: 0, cacheCreate: 0 })
      const result = store.clearAll()
      expect(result.events >= 1).toBeTruthy()
      expect(result.aggregates >= 1).toBeTruthy()
      const s = store.stats()
      expect(s.events).toBe(0)
      expect(s.aggregates).toBe(0)
      const stats = store.getStats()
      expect(stats.today.input_tokens, '今日内存缓存也应清空').toBe(0)
    })
  })

  describe('stats', () => {
    it('返回条目数与文件大小', () => {
      store.record({ provider: 'p1', adapter: null, model: 'm', upstreamModel: 'm', protocol: 'openai', source: 'proxy', inputTokens: 10, outputTokens: 5, cacheRead: 0, cacheCreate: 0 })
      const s = store.stats()
      expect(s.events >= 1).toBeTruthy()
      expect(s.aggregates >= 1).toBeTruthy()
      expect(s.sizeBytes > 0).toBeTruthy()
    })
  })

  describe('并发安全', () => {
    it('连续 record 无数据丢失', () => {
      const N = 1000
      for (let i = 0; i < N; i++) {
        store.record({ provider: 'p1', adapter: null, model: 'm', upstreamModel: 'm', protocol: 'openai', source: 'proxy', inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheCreate: 0 })
      }
      const stats = store.getStats()
      expect(stats.today.request_count).toBe(N)
      expect(stats.today.input_tokens).toBe(N)
      const s = store.stats()
      expect(s.events).toBe(N)
    })
  })
})
