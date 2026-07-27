/**
 * PG + Drizzle integration test using Testcontainers.
 *
 * Self-contained: spins up a fresh postgres:16-alpine container, runs drizzle
 * migrations against it, inserts a probe row, and verifies the row is readable.
 * No shared test database is touched.
 *
 * P1.16 增量1：在同容器内追加 schema 落地验证——7 张新表 + 5 个索引（含部分索引）
 * 存在性、provider→model→adapter→mapping 链路 round-trip、唯一/外键/CHECK/级联约束。
 *
 * Requires Docker on the host. If the daemon is unreachable the container start
 * will fail with a clear error from testcontainers.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  adapters,
  adapterModelMappings,
  providerModels,
  providers,
  tables,
  usageRecords,
  type Schema,
} from '../src/db/schema/index.js';

const TEST_MODEL = 'vitest-model';
const TEST_PROVIDER = 'vitest-provider';
const INSERT_STATUS = 200;
const MIGRATIONS_FOLDER = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');

let container: StartedPostgreSqlContainer | null = null;
let client: ReturnType<typeof postgres> | null = null;
let db: PostgresJsDatabase<Schema> | null = null;

// 守卫：beforeAll 失败时 db 为 null；各用例统一经此取得非空客户端（局部遮蔽模块级 db）
const requireDb = (): PostgresJsDatabase<Schema> => {
  if (!db) throw new Error('test db not initialized; beforeAll failed');
  return db;
};

// 断言一个 promise 以指定 PG SQLSTATE 码失败：23505 唯一 / 23503 外键 / 23514 check
const expectSqlState = (p: Promise<unknown>, code: string) => expect(p).rejects.toMatchObject({ code });

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
    const db = requireDb();

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

  // ===== P1.16 增量1：schema 落地验证（7 表 + 5 索引 + 约束 round-trip）=====

  it('creates all 7 P1.16 tables and 5 indexes (incl. partial index)', async () => {
    const db = requireDb();

    // 7 张新表均存在
    const expectedTables = [
      'providers',
      'provider_models',
      'adapters',
      'adapter_model_mappings',
      'vision_settings',
      'proxy_settings',
      'usage_records',
    ];
    const tableRows = await db.execute<{ tablename: string }>(
      sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    );
    const tableNames = new Set(tableRows.map((r) => r.tablename));
    for (const t of expectedTables) {
      expect(tableNames.has(t), `expected table ${t} to exist`).toBe(true);
    }

    // 5 个索引存在；idx_providers_priority 为部分索引（谓词非空，对应 WHERE enabled）
    const expectedIndexes = [
      'idx_providers_priority',
      'idx_provider_models_model_id',
      'idx_adapter_mappings_adapter_id',
      'idx_usage_records_provider_model',
      'idx_usage_records_request_id',
    ];
    const indexRows = await db.execute<{ indexname: string; predicate: string | null }>(
      sql`SELECT i.relname AS indexname, pg_get_expr(pi.indpred, pi.indrelid) AS predicate
          FROM pg_index pi
          JOIN pg_class i ON i.oid = pi.indexrelid
          JOIN pg_class c ON c.oid = pi.indrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'`,
    );
    const indexMap = new Map(indexRows.map((r) => [r.indexname, r.predicate]));
    for (const name of expectedIndexes) {
      expect(indexMap.has(name), `expected index ${name} to exist`).toBe(true);
    }
    expect(indexMap.get('idx_providers_priority'), 'idx_providers_priority should be a partial index').toBeTruthy();
  }, 30_000);

  it('round-trips provider → model → adapter → mapping and enforces unique + FK', async () => {
    const db = requireDb();

    // 插入 provider
    const [provider] = await db
      .insert(providers)
      .values({ name: 'rt-provider', type: 'openai', credentialRef: 'vault://rt', priority: 10 })
      .returning();
    if (!provider) throw new Error('provider insert returned no row');
    expect(typeof provider.id).toBe('number');

    // 插入 provider_model（FK → provider；覆盖 text[] 与思考字段）
    const [model] = await db
      .insert(providerModels)
      .values({
        providerId: provider.id,
        modelId: 'gpt-4o',
        inputModalities: ['text', 'image'],
        thinkingEnabled: true,
        thinkingBudgetTokens: 1024,
        maxOutputTokens: 4096,
      })
      .returning();
    if (!model) throw new Error('provider_model insert returned no row');
    expect(model.providerId).toBe(provider.id);
    expect(model.inputModalities).toEqual(['text', 'image']);

    // 插入 adapter
    const [adapter] = await db
      .insert(adapters)
      .values({ name: 'rt-adapter', inboundType: 'anthropic', streamPolicy: 'force_true' })
      .returning();
    if (!adapter) throw new Error('adapter insert returned no row');

    // 插入 adapter_model_mapping（FK → adapter + provider_model）
    const [mapping] = await db
      .insert(adapterModelMappings)
      .values({ adapterId: adapter.id, sourceModelId: 'claude-sonnet', providerModelId: model.id })
      .returning();
    if (!mapping) throw new Error('mapping insert returned no row');
    expect(mapping.adapterId).toBe(adapter.id);
    expect(mapping.providerModelId).toBe(model.id);

    // 读回校验链路完整
    const readBack = await db
      .select()
      .from(adapterModelMappings)
      .where(eq(adapterModelMappings.id, mapping.id));
    expect(readBack).toHaveLength(1);
    expect(readBack[0]?.providerModelId).toBe(model.id);

    // 唯一约束：providers.name 重复 → 23505
    await expectSqlState(
      db.insert(providers).values({ name: 'rt-provider', type: 'openai', credentialRef: 'vault://dup' }),
      '23505',
    );
    // 唯一约束：(provider_id, model_id) 重复 → 23505
    await expectSqlState(db.insert(providerModels).values({ providerId: provider.id, modelId: 'gpt-4o' }), '23505');
    // 唯一约束：(adapter_id, source_model_id) 重复 → 23505
    await expectSqlState(
      db
        .insert(adapterModelMappings)
        .values({ adapterId: adapter.id, sourceModelId: 'claude-sonnet', providerModelId: model.id }),
      '23505',
    );
    // 外键无 cascade：删被 mapping 引用的 provider_model → 23503
    await expectSqlState(db.delete(providerModels).where(eq(providerModels.id, model.id)), '23503');
  }, 30_000);

  it('cascades provider delete to provider_models (ON DELETE CASCADE)', async () => {
    const db = requireDb();

    // 独立的 provider + model（无 adapter mapping 引用），验证级联删除
    const [p] = await db
      .insert(providers)
      .values({ name: 'cascade-provider', type: 'anthropic', credentialRef: 'vault://c' })
      .returning();
    if (!p) throw new Error('provider insert returned no row');
    const [m] = await db.insert(providerModels).values({ providerId: p.id, modelId: 'claude-cascade' }).returning();
    if (!m) throw new Error('provider_model insert returned no row');

    await db.delete(providers).where(eq(providers.id, p.id));
    const remaining = await db.select().from(providerModels).where(eq(providerModels.id, m.id));
    expect(remaining).toHaveLength(0);
  }, 30_000);

  it('enforces CHECK constraints (positive budget / status whitelist)', async () => {
    const db = requireDb();

    const [p] = await db
      .insert(providers)
      .values({ name: 'chk-provider', type: 'openai', credentialRef: 'vault://chk' })
      .returning();
    if (!p) throw new Error('provider insert returned no row');

    // thinking_budget_tokens 必须 > 0 → 23514 (check_violation)
    await expectSqlState(
      db.insert(providerModels).values({ providerId: p.id, modelId: 'm-neg', thinkingBudgetTokens: -1 }),
      '23514',
    );
    // usage_records.status 取值白名单 → 23514
    await expectSqlState(
      db.insert(usageRecords).values({
        requestId: 'req-chk',
        clientProtocol: 'openai',
        logicalModel: 'lm',
        resolvedModel: 'rm',
        inputTokens: 1,
        outputTokens: 1,
        status: 'bogus',
      }),
      '23514',
    );
  }, 30_000);
});
