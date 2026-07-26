/**
 * postgres-js + Drizzle client (lazy singleton).
 *
 * Verified conventions from spike:
 * - `prepare: false`: required for compatibility with Pgbouncer transaction-mode
 *   pooling; safe for direct connections too.
 * - `max: 5 / idle_timeout: 5 / connect_timeout: 5`: bounded pool size to avoid
 *   exhausting the host PG.
 * - Lazy singleton: cache the client at module level; closeDb() resets the cache
 *   (idempotent) for test cleanup.
 * - Reads DATABASE_URL via loadEnv() so tests can stub env once.
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

// Idempotent: safe to call multiple times; a no-op when nothing is open.
// end() errors are logged but not rethrown, so test cleanup can proceed even
// when the underlying connection is already torn down.
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
