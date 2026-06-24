/**
 * SQLite 适配层：让 UsageStore 同时跑在 Node.js 和 Bun 两种 runtime。
 *
 * - Node.js (>= 20) 使用内置 `node:sqlite`（`DatabaseSync`）
 * - Bun (>= 1.1) 使用内置 `bun:sqlite`（`Database`）
 *
 * 两个 runtime 的 API 在我们用到的范围内一致：
 * - db.prepare(sql).run(...args) -> { changes, lastInsertRowid }
 * - db.prepare(sql).all(...args) -> Row[]
 * - db.prepare(sql).get(...args) -> Row | undefined
 * - db.exec(sql)
 * - db.close()
 *
 * 用 createRequire 动态加载，避免 esbuild / bun --compile 静态分析 import。
 * - createRequire 在 Node ESM 和 Bun 下都可用
 * - Node 下 require 'node:sqlite' 成功；require 'bun:sqlite' 失败
 * - Bun 下 require 'bun:sqlite' 成功；require 'node:sqlite' 失败（Bun --compile 不支持）
 */

import { createRequire } from 'node:module'

export interface SqliteRunResult {
  changes: number
  lastInsertRowid: number | bigint
}

export interface SqliteStatement {
  run(...args: unknown[]): SqliteRunResult
  all(...args: unknown[]): Record<string, unknown>[]
  get(...args: unknown[]): Record<string, unknown> | undefined
}

export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement
  exec(sql: string): void
  close(): void
}

/**
 * 加载当前 runtime 对应的 SQLite driver，返回一个 SQLite database 连接。
 *
 * @internal 仅在 UsageStore 内部使用
 */
export function openSqliteDatabase(path: string): SqliteDatabase {
  const isBun = isBunRuntime()
  // createRequire 在 Node ESM 和 Bun 下都可用，比 eval('require') 更稳
  const localRequire = createRequire(import.meta.url)
  if (isBun) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = localRequire('bun:sqlite') as any
    return new mod.Database(path) as SqliteDatabase
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = localRequire('node:sqlite') as any
  return new mod.DatabaseSync(path) as SqliteDatabase
}

/**
 * 判断当前 runtime 是否为 Bun。供 caller 决定是否需要处理 runtime-specific 行为。
 */
export function isBunRuntime(): boolean {
  return typeof process !== 'undefined' && Boolean((process as unknown as { versions?: { bun?: string } }).versions?.bun)
}