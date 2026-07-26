/**
 * 启动时跑 drizzle 迁移（编程式 migrator，非 push）。
 *
 * - `migrate()` 来自 drizzle-orm/postgres-js/migrator，会读取 `drizzle/` 下生成的 SQL
 *   并应用到当前 DATABASE_URL；重复运行幂等。
 * - 仅在 DATABASE_URL 已配置时执行；未配置时跳过（让 db-less 路由仍可启动）。
 * - P0：此函数在 start 命令前同步阻塞调用，确保 schema ready 后再开 HTTP。
 *
 * 注意：迁移文件由 `npm run db:generate`（drizzle-kit generate）产出并提交。
 * `drizzle/` 目录是合约产物，CI 不应忽略。
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { getDb } from './client.js';
import { log } from '../lib/logger.js';

export interface MigrationResult {
  applied: number;
  folder: string;
}

// Drizzle 迁移文件目录：src/db/migrate.ts → <repo>/drizzle
const MIGRATIONS_FOLDER = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');

export const runMigrations = async (): Promise<MigrationResult> => {
  const db = getDb();
  log.info({ folder: MIGRATIONS_FOLDER }, 'running drizzle migrations');
  try {
    // drizzle 的 migrate() 内部会跳过已应用的迁移；返回值通常不暴露条目数。
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    log.info({ folder: MIGRATIONS_FOLDER }, 'drizzle migrations done');
    return { applied: 1, folder: MIGRATIONS_FOLDER };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg, folder: MIGRATIONS_FOLDER }, 'drizzle migrate failed');
    throw new Error(`drizzle migrate failed (folder=${MIGRATIONS_FOLDER}): ${msg}`, { cause: err });
  }
};
