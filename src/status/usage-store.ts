import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Logger } from '../log/logger.js'
import { openSqliteDatabase, type SqliteDatabase, type SqliteStatement } from '../lib/sqlite-client.js'

/**
 * 协议类型：与 proxy/translation 的 InboundType 保持一致
 */
export type Protocol = 'anthropic' | 'openai' | 'openai-responses'

/**
 * 写入上下文：每次请求一条记录
 */
export interface UsageRecord {
  /** 上游供应商名（如 'deepseek'） */
  provider: string
  /** 适配器名（直接 /v1/* 请求则为 null） */
  adapter: string | null
  /** 客户端请求的模型名（代理端 model 字段） */
  model: string
  /** 上游实际模型 ID（如 'claude-sonnet-4-20250514'） */
  upstreamModel: string
  /** 上游供应商协议 */
  protocol: Protocol
  /** 来源标识：'proxy' 或 adapterName */
  source: string
  /** 总输入 token（已归一化，含缓存） */
  inputTokens: number
  /** 输出 token */
  outputTokens: number
  /** 缓存命中 token */
  cacheRead: number
  /** 缓存创建 token */
  cacheCreate: number
}

/**
 * 每日聚合行
 */
export interface DailyAggregate {
  date: string
  provider: string
  adapter: string
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  request_count: number
}

/**
 * API 响应结构（与原 TokenStats 兼容）
 */
export interface TokenStats {
  today: {
    date: string
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens: number
    cache_creation_input_tokens: number
    request_count: number
  }
  history: Array<{
    date: string
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens: number
    cache_creation_input_tokens: number
    request_count: number
  }>
  byProvider: Record<string, {
    date: string
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens: number
    cache_creation_input_tokens: number
    request_count: number
  }>
}

/**
 * 折线图数据点
 */
export interface TimelinePoint {
  date: string
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  request_count: number
}

/**
 * 按维度分组的桶
 */
export interface UsageBucket {
  key: string
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  request_count: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  date TEXT NOT NULL,
  provider TEXT NOT NULL,
  adapter TEXT,
  model TEXT NOT NULL,
  upstream_model TEXT NOT NULL,
  protocol TEXT NOT NULL,
  source TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_usage_date ON usage_events(date);
CREATE INDEX IF NOT EXISTS idx_usage_provider ON usage_events(provider);
CREATE INDEX IF NOT EXISTS idx_usage_adapter ON usage_events(adapter);
CREATE INDEX IF NOT EXISTS idx_usage_date_provider ON usage_events(date, provider);
CREATE INDEX IF NOT EXISTS idx_usage_date_adapter ON usage_events(date, adapter);

CREATE TABLE IF NOT EXISTS daily_aggregates (
  date TEXT NOT NULL,
  provider TEXT NOT NULL,
  adapter TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, provider, adapter, model)
);
CREATE INDEX IF NOT EXISTS idx_agg_date ON daily_aggregates(date);
CREATE INDEX IF NOT EXISTS idx_agg_provider ON daily_aggregates(provider);
`

/**
 * SQLite 持久化的 token 用量存储。
 * 双写：每次请求写一条事件 + 更新预聚合表。
 * "今日"数据缓存在内存以加速 dashboard 查询。
 *
 * 同时支持 Node.js (`node:sqlite`) 和 Bun (`bun:sqlite`) 两种 runtime。
 * Bun 用于 `bun build --compile` 打 macOS App 内嵌后端二进制。
 */
export class UsageStore {
  private db: SqliteDatabase
  private logger?: Logger
  /** 内存缓存：date -> provider -> aggregate（仅"今日"） */
  private todayAgg: Map<string, Map<string, { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; request_count: number }>> = new Map()
  private today: string
  /** 预编译语句以加速写入 */
  private insertEventStmt!: SqliteStatement
  private upsertAggStmt!: SqliteStatement
  private dbPath: string

  constructor(dbPath: string, logger?: Logger) {
    this.dbPath = dbPath
    this.logger = logger
    // 确保父目录存在
    mkdirSync(dirname(dbPath), { recursive: true })

    this.db = openSqliteDatabase(dbPath)
    // WAL 模式：写入不阻塞读，并发更友好
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec('PRAGMA synchronous = NORMAL;')
    // 创建表结构
    this.db.exec(SCHEMA)

    // 预编译语句
    this.insertEventStmt = this.db.prepare(`
      INSERT INTO usage_events
        (ts, date, provider, adapter, model, upstream_model, protocol, source,
         input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.upsertAggStmt = this.db.prepare(`
      INSERT INTO daily_aggregates
        (date, provider, adapter, model, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, request_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT (date, provider, adapter, model) DO UPDATE SET
        input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens,
        cache_read_input_tokens = cache_read_input_tokens + excluded.cache_read_input_tokens,
        cache_creation_input_tokens = cache_creation_input_tokens + excluded.cache_creation_input_tokens,
        request_count = request_count + 1
    `)

    this.today = this.getToday()
    // 启动时加载今日已存在的聚合数据到内存
    this.loadTodayIntoMemory()
  }

  private getToday(): string {
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }

  private loadTodayIntoMemory(): void {
    const rows = this.db.prepare(`
      SELECT provider, adapter, model, input_tokens, output_tokens,
             cache_read_input_tokens, cache_creation_input_tokens, request_count
      FROM daily_aggregates WHERE date = ?
    `).all(this.today) as Array<{
      provider: string; adapter: string; model: string
      input_tokens: number; output_tokens: number
      cache_read_input_tokens: number; cache_creation_input_tokens: number
      request_count: number
    }>
    for (const r of rows) {
      let pm = this.todayAgg.get(r.provider)
      if (!pm) { pm = new Map(); this.todayAgg.set(r.provider, pm) }
      pm.set(this.adapterModelKey(r.adapter, r.model), {
        input_tokens: r.input_tokens,
        output_tokens: r.output_tokens,
        cache_read_input_tokens: r.cache_read_input_tokens,
        cache_creation_input_tokens: r.cache_creation_input_tokens,
        request_count: r.request_count,
      })
    }
    this.logger?.log('system', `UsageStore: loaded ${rows.length} today aggregates`, { date: this.today, rows: rows.length }, 'debug')
  }

  private adapterModelKey(adapter: string, model: string): string {
    return `${adapter}::${model}`
  }

  /**
   * 记录一次请求的 token 用量。
   * 同步写 SQLite + 更新今日内存缓存。
   */
  record(rec: UsageRecord): void {
    const now = Date.now()
    const date = this.getToday()
    // 跨日：清空内存缓存，重新加载新的一天
    if (date !== this.today) {
      this.today = date
      this.todayAgg.clear()
    }
    const adapter = rec.adapter ?? ''
    const ts = now

    // 1. 写事件表
    this.insertEventStmt.run(
      ts, date, rec.provider, rec.adapter, rec.model, rec.upstreamModel, rec.protocol, rec.source,
      rec.inputTokens, rec.outputTokens, rec.cacheRead, rec.cacheCreate
    )

    // 2. 更新预聚合表
    this.upsertAggStmt.run(
      date, rec.provider, adapter, rec.model,
      rec.inputTokens, rec.outputTokens, rec.cacheRead, rec.cacheCreate
    )

    // 3. 更新今日内存缓存
    let pm = this.todayAgg.get(rec.provider)
    if (!pm) { pm = new Map(); this.todayAgg.set(rec.provider, pm) }
    const key = this.adapterModelKey(adapter, rec.model)
    let bucket = pm.get(key)
    if (!bucket) {
      bucket = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, request_count: 0 }
      pm.set(key, bucket)
    }
    bucket.input_tokens += rec.inputTokens
    bucket.output_tokens += rec.outputTokens
    bucket.cache_read_input_tokens += rec.cacheRead
    bucket.cache_creation_input_tokens += rec.cacheCreate
    bucket.request_count += 1
  }

  /**
   * 兼容旧 TokenTracker.record() 签名。
   * 旧接口不知道 adapter/model，直接归入 provider 级。
   */
  recordLegacy(providerName: string, inputTokens: number, outputTokens: number, cacheRead?: number, cacheCreate?: number): void {
    this.record({
      provider: providerName,
      adapter: null,
      model: providerName, // 旧接口无 model，用 providerName 占位
      upstreamModel: providerName,
      protocol: 'openai', // 默认值，调用方应改为 record() 传完整上下文
      source: 'proxy',
      inputTokens,
      outputTokens,
      cacheRead: cacheRead ?? 0,
      cacheCreate: cacheCreate ?? 0,
    })
  }

  /**
   * 获取 dashboard 兼容结构：today / history / byProvider
   */
  getStats(): TokenStats {
    const today = this.today
    const todayRow = this.db.prepare(`
      SELECT
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_input_tokens,
        COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
        COALESCE(SUM(request_count), 0) AS request_count
      FROM daily_aggregates WHERE date = ?
    `).get(today) as { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; request_count: number }

    const historyRows = this.db.prepare(`
      SELECT
        date,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_input_tokens,
        COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
        COALESCE(SUM(request_count), 0) AS request_count
      FROM daily_aggregates WHERE date < ? GROUP BY date ORDER BY date DESC LIMIT 30
    `).all(today) as Array<{ date: string; input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; request_count: number }>

    // byProvider：今日按 provider 聚合
    const byProviderRows = this.db.prepare(`
      SELECT
        provider,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_input_tokens,
        COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
        COALESCE(SUM(request_count), 0) AS request_count
      FROM daily_aggregates WHERE date = ? GROUP BY provider
    `).all(today) as Array<{ provider: string; input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; request_count: number }>
    const byProvider: TokenStats['byProvider'] = {}
    for (const r of byProviderRows) {
      if (r.request_count === 0) continue
      byProvider[r.provider] = {
        date: today,
        input_tokens: r.input_tokens,
        output_tokens: r.output_tokens,
        cache_read_input_tokens: r.cache_read_input_tokens,
        cache_creation_input_tokens: r.cache_creation_input_tokens,
        request_count: r.request_count,
      }
    }

    return {
      today: {
        date: today,
        input_tokens: todayRow.input_tokens,
        output_tokens: todayRow.output_tokens,
        cache_read_input_tokens: todayRow.cache_read_input_tokens,
        cache_creation_input_tokens: todayRow.cache_creation_input_tokens,
        request_count: todayRow.request_count,
      },
      history: historyRows,
      byProvider,
    }
  }

  /**
   * 获取 N 天的折线图数据。
   * 返回从最早到最近的每日数据点（按 date ASC），缺失日期补 0。
   */
  getTimeline(days: number): TimelinePoint[] {
    const today = this.today
    const rows = this.db.prepare(`
      SELECT
        date,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_input_tokens,
        COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
        COALESCE(SUM(request_count), 0) AS request_count
      FROM daily_aggregates
      WHERE date >= date(?, '-' || ? || ' days')
      GROUP BY date
      ORDER BY date ASC
    `).all(today, days - 1) as unknown as TimelinePoint[]

    // 补齐缺失日期
    const map = new Map(rows.map(r => [r.date, r]))
    const result: TimelinePoint[] = []
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today + 'T00:00:00')
      d.setDate(d.getDate() - i)
      const dateStr = this.formatDate(d)
      const r = map.get(dateStr)
      result.push(r ?? { date: dateStr, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, request_count: 0 })
    }
    return result
  }

  /**
   * 按维度分桶查询：'provider' | 'adapter' | 'model'
   * @param range 'today' | '7d' | '30d' | 'all'
   */
  getBreakdown(dimension: 'provider' | 'adapter' | 'model', range: 'today' | '7d' | '30d' | 'all' = 'today'): UsageBucket[] {
    const col = dimension === 'provider' ? 'provider' : dimension === 'adapter' ? 'adapter' : 'model'
    let where = ''
    const params: unknown[] = []
    if (range === 'today') {
      where = 'WHERE date = ?'
      params.push(this.today)
    } else if (range === '7d' || range === '30d') {
      const days = range === '7d' ? 7 : 30
      where = `WHERE date >= date(?, '-' || ? || ' days')`
      params.push(this.today, days - 1)
    }
    const rows = this.db.prepare(`
      SELECT ${col} AS key,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_input_tokens,
        COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
        COALESCE(SUM(request_count), 0) AS request_count
      FROM daily_aggregates
      ${where}
      GROUP BY ${col}
      ORDER BY input_tokens DESC
    `).all(...(params as (string | number)[])) as unknown as UsageBucket[]

    // adapter 为 '' 时替换为 '(direct proxy)'，方便前端展示
    if (dimension === 'adapter') {
      for (const r of rows) {
        if (!r.key) r.key = '(direct proxy)'
      }
    }
    return rows
  }

  /**
   * 清理指定天数前的数据。返回清理的 (events, aggregates) 条数。
   */
  cleanup(beforeDays: number): { events: number; aggregates: number } {
    const cutoff = this.offsetDate(this.today, -beforeDays)
    const evtRes = this.db.prepare('DELETE FROM usage_events WHERE date < ?').run(cutoff)
    const aggRes = this.db.prepare('DELETE FROM daily_aggregates WHERE date < ?').run(cutoff)
    return { events: Number(evtRes.changes ?? 0), aggregates: Number(aggRes.changes ?? 0) }
  }

  /**
   * 获取数据库总条目数（用于管理面板展示）
   */
  stats(): { events: number; aggregates: number; sizeBytes: number } {
    const events = (this.db.prepare('SELECT COUNT(*) AS c FROM usage_events').get() as { c: number }).c
    const aggregates = (this.db.prepare('SELECT COUNT(*) AS c FROM daily_aggregates').get() as { c: number }).c
    // 通过 page_count * page_size 计算实际占用（WAL 模式下比 statSync 文件大小更准）
    let sizeBytes = 0
    try {
      const pageCount = (this.db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count
      const pageSize = (this.db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size
      sizeBytes = pageCount * pageSize
      // WAL 模式下未 checkpoint 的数据还在 -wal 里，加上
      try {
        const fs = require('node:fs') as typeof import('node:fs')
        const walSize = fs.statSync(this.dbPath + '-wal').size
        sizeBytes += walSize
      } catch { /* WAL 不存在也没关系 */ }
    } catch { /* 读不到不阻塞 */ }
    return { events, aggregates, sizeBytes }
  }

  /**
   * 关闭数据库。SIGTERM 时调用，确保 WAL flush 到主文件。
   */
  close(): void {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
      this.db.close()
    } catch (err) {
      this.logger?.log('system', 'UsageStore close failed', { error: String(err) }, 'warn')
    }
  }

  private formatDate(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }

  private offsetDate(dateStr: string, offsetDays: number): string {
    const d = new Date(dateStr + 'T00:00:00')
    d.setDate(d.getDate() + offsetDays)
    return this.formatDate(d)
  }
}