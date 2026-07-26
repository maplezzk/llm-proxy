/**
 * postgres-js + Drizzle 客户端（懒加载单例）。
 *
 * spike 阶段已验证的约定：
 * - `prepare: false`：兼容 Pgbouncer 事务模式连接池，直连场景同样安全。
 * - `max: 5 / idle_timeout: 5 / connect_timeout: 5`：受限的连接池上限，避免打满宿主机 PG。
 * - 懒加载单例：客户端缓存在模块层；closeDb() 重置缓存（幂等），供测试清理使用。
 * - 通过 loadEnv() 读取 DATABASE_URL，测试只需 stub 一次环境变量即可。
 */
import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { loadEnv } from '../config/env.js';
import { tables, type Schema } from './schema/index.ts';
import { log } from '../lib/logger.js';

export type Db = PostgresJsDatabase<Schema>;

const resolveDbUrl = (): string => {
  const url = loadEnv().DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL not configured; cannot build drizzle client');
  }
  return url;
};

const createSqlClient = (url: string): ReturnType<typeof postgres> =>
  postgres(url, {
    prepare: false,
    max: 5,
    idle_timeout: 5,
    connect_timeout: 5,
  });

let cachedSql: ReturnType<typeof postgres> | null = null;
let cachedDb: Db | null = null;

export const getDb = (): Db => {
  if (cachedDb) return cachedDb;
  const url = resolveDbUrl();
  cachedSql = createSqlClient(url);
  cachedDb = drizzle(cachedSql, { schema: tables });
  return cachedDb;
};

// 幂等：可重复调用；没有打开的连接时为 no-op。
// end() 错误仅记录不抛出，保证测试清理即使底层连接已断开也能继续。
export const closeDb = async (): Promise<void> => {
  if (!cachedSql) return;
  try {
    await cachedSql.end({ timeout: 5 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err: msg }, 'closeDb: end() rejected; clearing cache anyway');
  } finally {
    cachedSql = null;
    cachedDb = null;
  }
};
