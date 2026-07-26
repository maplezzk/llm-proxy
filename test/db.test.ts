/**
 * PG + Drizzle integration test using Testcontainers.
 *
 * Self-contained: spins up a fresh postgres:16-alpine container, runs drizzle
 * migrations against it, inserts a probe row, and verifies the row is readable.
 * No shared test database is touched.
 *
 * Requires Docker on the host. If the daemon is unreachable the container start
 * will fail with a clear error from testcontainers.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tables, type Schema } from '../src/db/schema/index.js';

const TEST_MODEL = 'vitest-model';
const TEST_PROVIDER = 'vitest-provider';
const INSERT_STATUS = 200;
const MIGRATIONS_FOLDER = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');

let container: StartedPostgreSqlContainer | null = null;
let client: ReturnType<typeof postgres> | null = null;
let db: PostgresJsDatabase<Schema> | null = null;

describe('postgres + drizzle integration (testcontainers)', () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('llmproxy_test')
      .withUsername('test')
      .withPassword('test')
      .start();
    const url = container.getConnectionUri();
    client = postgres(url, { prepare: false, max: 3 });
    db = drizzle(client, { schema: tables });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  }, 90_000);

  afterAll(async () => {
    if (client) await client.end({ timeout: 5 });
    if (container) await container.stop();
  });

  it('migrates schema, inserts and reads back a row', async () => {
    if (!db) throw new Error('test db not initialized; beforeAll failed');

    const inserted = await db.execute<{ id: number }>(
      sql`INSERT INTO requests (model, provider, status) VALUES (${TEST_MODEL}, ${TEST_PROVIDER}, ${INSERT_STATUS}) RETURNING id`,
    );
    const insertedRow = inserted[0];
    if (!insertedRow) throw new Error('expected at least one row from INSERT');
    expect(typeof insertedRow.id).toBe('number');

    const counted = await db.execute<{ count: number }>(
      sql`SELECT COUNT(*)::int AS count FROM requests`,
    );
    const firstRow = counted[0];
    if (!firstRow || typeof firstRow.count !== 'number') {
      throw new Error('expected numeric count in first row of SELECT COUNT(*)');
    }
    expect(firstRow.count).toBeGreaterThan(0);
  }, 30_000);
});
