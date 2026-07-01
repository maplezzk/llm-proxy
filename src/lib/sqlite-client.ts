/**
 * SQLite 适配层：让 UsageStore 同时跑在多种 runtime / Node 版本。
 *
 * 优先级：
 * - Bun runtime → `bun:sqlite`（Bun 内置）
 * - Node.js >= 22.5 + `--experimental-sqlite` flag → `node:sqlite`
 * - Node.js < 22.5 或无 flag → `better-sqlite3`（跨版本、prebuilt binaries）
 *
 * 三个驱动的 API 在我们用到的范围内一致：
 * - db.prepare(sql).run(...args) -> { changes, lastInsertRowid }
 * - db.prepare(sql).all(...args) -> Row[]
 * - db.prepare(sql).get(...args) -> Row | undefined
 * - db.exec(sql)
 * - db.close()
 *
 * Bun 下用 createRequire 动态加载 bun:sqlite；Node 下逐个尝试。
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
  if (isBunRuntime()) {
    // Bun 下强制用 bun:sqlite（--compile 也支持）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = createRequire(import.meta.url)('bun:sqlite') as any
    return new mod.Database(path) as SqliteDatabase
  }

  // Node.js 路径：优先 node:sqlite（零依赖），不可用则降级 better-sqlite3
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const localRequire = createRequire(import.meta.url) as NodeRequire & ((id: string) => any)
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = localRequire('node:sqlite') as any
    return new mod.DatabaseSync(path) as SqliteDatabase
  } catch {
    // Node 20 或未启用 --experimental-sqlite，回退 better-sqlite3
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = localRequire('better-sqlite3') as any
    return new mod(path) as SqliteDatabase
  }
}

/**
 * 判断当前 runtime 是否为 Bun。供 caller 决定是否需要处理 runtime-specific 行为。
 */
export function isBunRuntime(): boolean {
  return typeof process !== 'undefined' && Boolean((process as unknown as { versions?: { bun?: string } }).versions?.bun)
}