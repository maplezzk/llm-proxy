import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type PostgresJsDatabase, drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
/**
 * P1.16 增量2：Config ↔ PG 映射 + ConfigStore 双写过渡 集成测试。
 *
 * 覆盖：
 * - 纯函数 round-trip：configToRows → rowsToConfig 语义等价（无需 Docker）。
 * - configToRows 外键解析失败抛清晰错误。
 * - 持久化 round-trip：importConfigToPg → loadConfigFromPg（testcontainers PG）。
 * - importConfigToPg 幂等（连续导入两次结果一致、无重复行）。
 * - ConfigStore.writeConfig 双写 happy path（YAML + PG 同步）与降级（无 DATABASE_URL 不抛错）。
 * - ConfigStore.syncToPg 降级（无 DATABASE_URL 静默跳过）。
 *
 * 需要 Docker（持久化部分）；纯函数部分无外部依赖。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetEnvCache } from '../src/config/env.js';
import { configToRows, rowsToConfig } from '../src/config/pg-mapper.js';
import { ConfigStore } from '../src/config/store.js';
import type { Config } from '../src/config/types.js';
import { closeDb, getDb } from '../src/db/client.js';
import { importConfigToPg, loadConfigFromPg } from '../src/db/config-repo.js';
import { type Schema, providers as providersTable, tables } from '../src/db/schema/index.js';

const MIGRATIONS_FOLDER = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');

/**
 * 构造一个覆盖全字段的 Config：2 provider（含 thinking budget/type/effort 三态 + 无 thinking、
 * 含多模态 input 与仅文本）、1 adapter（含 thinking 覆盖映射 + 无覆盖映射）、vision、proxy 各字段。
 * 所有可选 proxy 字段取非默认值，保证 round-trip 等值断言不受 schema 默认值归一干扰。
 */
const buildConfig = (): Config => ({
  providers: [
    {
      name: 'prov-a',
      type: 'anthropic',
      apiKey: 'sk-a',
      apiBase: 'https://a.example.com',
      models: [
        { id: 'claude-sonnet', thinking: { budget_tokens: 4096 }, input: ['text', 'image'] },
        { id: 'claude-haiku', thinking: { type: 'adaptive' } },
      ],
    },
    {
      name: 'prov-b',
      type: 'openai',
      apiKey: 'sk-b',
      models: [
        { id: 'gpt-4o', thinking: { reasoning_effort: 'high' }, input: ['text', 'image'] },
        { id: 'gpt-mini' },
      ],
    },
  ],
  adapters: [
    {
      name: 'mytool',
      type: 'anthropic',
      max_tokens: 2048,
      stream: true,
      models: [
        {
          sourceModelId: 'sonnet-alias',
          provider: 'prov-a',
          targetModelId: 'claude-sonnet',
          thinking: { reasoning_effort: 'low' },
        },
        { sourceModelId: 'gpt-alias', provider: 'prov-b', targetModelId: 'gpt-4o' },
      ],
    },
  ],
  vision: { provider: 'prov-a', model: 'claude-sonnet', prompt: 'describe the image' },
  proxyKey: 'sk-rt',
  logLevel: 'debug',
  locale: 'zh',
  port: 9100,
  captureMaxSize: 250,
});

/** 覆盖 U2 新增的模型组、渠道能力、adapter 绑定与现有 PG 保留列。 */
const buildModelCentricConfig = (): Config => ({
  providers: [
    {
      name: 'channel-a',
      type: 'anthropic',
      apiKey: 'sk-channel-a',
      priority: 10,
      enabled: false,
      models: [{ id: 'claude-sonnet-real', contextWindow: 200_000 }],
    },
    {
      name: 'channel-b',
      type: 'openai',
      apiKey: 'sk-channel-b',
      priority: 20,
      models: [{ id: 'gpt-reasoning-real', contextWindow: 128_000 }],
    },
  ],
  modelGroups: [
    {
      id: 'reasoning-128k',
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
      channels: [
        {
          provider: 'channel-a',
          model: 'claude-sonnet-real',
          priority: 1,
          contextWindow: 200_000,
          maxOutputTokens: 16_384,
        },
        {
          provider: 'channel-b',
          model: 'gpt-reasoning-real',
          priority: 2,
          contextWindow: 128_000,
          maxOutputTokens: 8_192,
        },
      ],
    },
  ],
  adapters: [
    {
      name: 'model-tool',
      type: 'anthropic',
      onFailure: 'fallback',
      models: [
        {
          sourceModelId: 'reasoning',
          model: 'reasoning-128k',
          channel: 'channel-a/claude-sonnet-real',
          thinking: { budget_tokens: 4_096 },
          overrides: [
            {
              scope: 'adapter-alias',
              body: [{ op: 'set_if_absent', path: 'temperature', value: 0.2 }],
            },
            {
              scope: 'channel',
              headers: [{ op: 'set', name: 'X-Channel', value: 'channel-a' }],
            },
          ],
        },
        {
          sourceModelId: 'reasoning-auto',
          model: 'reasoning-128k',
        },
      ],
    },
  ],
  proxyKey: 'sk-model-centric',
  logLevel: 'debug',
  locale: 'zh',
  port: 9200,
  captureMaxSize: 300,
});

// ===== 纯函数映射（无需 Docker）=====

describe('config ↔ PG 映射（纯函数）', () => {
  it('configToRows → rowsToConfig 内存 round-trip 语义等价', () => {
    const config = buildConfig();
    expect(rowsToConfig(configToRows(config))).toEqual(config);
  });

  it('模型组、渠道能力、adapter 绑定和覆写规则完整 round-trip', () => {
    const config = buildModelCentricConfig();
    const bundle = configToRows(config);

    expect(bundle.modelGroups).toHaveLength(1);
    expect(bundle.modelGroupChannels).toHaveLength(2);
    expect(bundle.providers[0]).toMatchObject({ priority: 10, enabled: false });
    expect(bundle.providerModels[0]).toMatchObject({ contextWindow: 200_000 });

    const group = bundle.modelGroups[0];
    const pinnedMapping = bundle.adapterModelMappings[0];
    const automaticMapping = bundle.adapterModelMappings[1];
    expect(pinnedMapping.modelGroupId).toBe(group?.id);
    expect(pinnedMapping.generationOverrides).toEqual(config.adapters?.[0]?.models[0]?.overrides);
    expect(automaticMapping).toMatchObject({
      modelGroupId: group?.id,
      providerModelId: null,
    });
    expect(rowsToConfig(bundle)).toEqual(config);
  });

  it('legacy mapping 保持原配置形状，同时在 PG 行束中自动升级为单渠道组', () => {
    const config = buildConfig();
    const bundle = configToRows(config);

    expect(bundle.modelGroups).toHaveLength(2);
    expect(bundle.modelGroupChannels).toHaveLength(2);
    for (const mapping of bundle.adapterModelMappings) {
      expect(mapping.modelGroupId).not.toBeNull();
      expect(mapping.providerModelId).not.toBeNull();
    }
    expect(rowsToConfig(bundle)).toEqual(config);
  });

  it('configToRows：model_group 渠道引用不存在的 (provider, model) 抛清晰错误', () => {
    const bad: Config = {
      providers: [{ name: 'p', type: 'openai', apiKey: 'k', models: [{ id: 'm1' }] }],
      modelGroups: [{ id: 'g', channels: [{ provider: 'p', model: 'nope' }] }],
    };
    expect(() => configToRows(bad)).toThrow(/model_group "g"/);
  });

  it('configToRows：adapter 引用不存在的 model_group 抛清晰错误', () => {
    const bad: Config = {
      providers: [{ name: 'p', type: 'openai', apiKey: 'k', models: [{ id: 'm1' }] }],
      adapters: [
        {
          name: 'a',
          type: 'openai',
          models: [{ sourceModelId: 's', model: 'missing-group' }],
        },
      ],
    };
    expect(() => configToRows(bad)).toThrow(/不存在的 model_group/);
  });

  it('configToRows：adapter 映射引用不存在的 (provider, model) 抛清晰错误', () => {
    const bad: Config = {
      providers: [{ name: 'p', type: 'openai', apiKey: 'k', models: [{ id: 'm1' }] }],
      adapters: [
        {
          name: 'a',
          type: 'openai',
          models: [{ sourceModelId: 's', provider: 'p', targetModelId: 'nope' }],
        },
      ],
    };
    expect(() => configToRows(bad)).toThrow(/不存在的 provider 模型/);
  });

  it('configToRows：vision 引用不存在的 (provider, model) 抛清晰错误', () => {
    const bad: Config = {
      providers: [{ name: 'p', type: 'openai', apiKey: 'k', models: [{ id: 'm1' }] }],
      vision: { provider: 'p', model: 'nope' },
    };
    expect(() => configToRows(bad)).toThrow(/vision/);
  });
});

// ===== 持久化 + ConfigStore 双写（testcontainers）=====

describe('config ↔ PG 持久化 + ConfigStore 双写（testcontainers）', () => {
  let container: StartedPostgreSqlContainer | null = null;
  let client: ReturnType<typeof postgres> | null = null;
  let db: PostgresJsDatabase<Schema> | null = null;
  let tmpDir = '';
  let savedDbUrl: string | undefined;

  const requireDb = (): PostgresJsDatabase<Schema> => {
    if (!db) throw new Error('test db not initialized; beforeAll failed');
    return db;
  };

  const tmpYamlPath = (tag: string): string =>
    join(tmpDir, `config-${tag}-${Date.now()}-${Math.random()}.yaml`);

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('llmproxy_cfgpg_test')
      .withUsername('test')
      .withPassword('test')
      .start();
    const url = container.getConnectionUri();
    client = postgres(url, { prepare: false, max: 3 });
    db = drizzle(client, { schema: tables });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    tmpDir = mkdtempSync(join(tmpdir(), 'llm-proxy-cfgpg-'));
    savedDbUrl = process.env.DATABASE_URL;
  }, 90_000);

  afterAll(async () => {
    await closeDb();
    if (client) await client.end({ timeout: 5 });
    if (container) await container.stop();
    // 恢复环境变量，避免污染其它测试文件
    if (savedDbUrl === undefined) Reflect.deleteProperty(process.env, 'DATABASE_URL');
    else process.env.DATABASE_URL = savedDbUrl;
    resetEnvCache();
  });

  it('round-trip：importConfigToPg → loadConfigFromPg 语义等价', async () => {
    const config = buildConfig();
    await importConfigToPg(requireDb(), config);
    const loaded = await loadConfigFromPg(requireDb());
    expect(loaded).toEqual(config);
  }, 30_000);

  it('round-trip：model-centric 配置经 PG 后保持模型组与 adapter 绑定', async () => {
    const config = buildModelCentricConfig();
    await importConfigToPg(requireDb(), config);
    const loaded = await loadConfigFromPg(requireDb());
    expect(loaded).toEqual(config);
  }, 30_000);

  it('importConfigToPg 幂等：连续导入两次结果一致且无重复行', async () => {
    const config = buildConfig();
    await importConfigToPg(requireDb(), config);
    await importConfigToPg(requireDb(), config); // 第二次整体覆盖
    const loaded = await loadConfigFromPg(requireDb());
    expect(loaded).toEqual(config);
    // providers 未重复（清旧插新）
    const rows = await requireDb().select().from(providersTable);
    expect(rows).toHaveLength(2);
  }, 30_000);

  it('ConfigStore.writeConfig 双写 happy path：YAML 写盘且 PG 同步', async () => {
    const url = container?.getConnectionUri();
    if (!url) throw new Error('container not started');
    process.env.DATABASE_URL = url;
    resetEnvCache();
    await closeDb(); // 让 getDb 按新 env 建连
    try {
      // 用区别于 buildConfig 的 proxyKey，确保读回匹配只能来自本次双写（防空跑假过）
      const config = buildConfig();
      config.proxyKey = 'sk-dualwrite-unique';
      const yamlPath = tmpYamlPath('dualwrite');
      const store = ConfigStore.fromMemory(config, yamlPath);

      await store.writeConfig(config);

      // YAML 已写入
      expect(existsSync(yamlPath)).toBe(true);
      expect(readFileSync(yamlPath, 'utf-8')).toContain('prov-a');
      // PG 已同步（用独立容器客户端读回验证）
      const loaded = await loadConfigFromPg(requireDb());
      expect(loaded.proxyKey).toBe('sk-dualwrite-unique');
      expect(loaded).toEqual(config);
    } finally {
      await closeDb();
      resetEnvCache();
    }
  }, 30_000);

  it('ConfigStore.writeConfig 降级：DATABASE_URL 未配置时不抛错且 YAML 仍写入', async () => {
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
    resetEnvCache();
    await closeDb(); // getDb 将因缺 DATABASE_URL 抛错（被 writeConfig 捕获）
    try {
      const config = buildConfig();
      const yamlPath = tmpYamlPath('degrade');
      const store = ConfigStore.fromMemory(config, yamlPath);

      await expect(store.writeConfig(config)).resolves.toBeUndefined();
      expect(existsSync(yamlPath)).toBe(true);
      expect(readFileSync(yamlPath, 'utf-8')).toContain('prov-b');
    } finally {
      resetEnvCache();
    }
  }, 30_000);

  it('ConfigStore.syncToPg 降级：无 DATABASE_URL 时静默跳过不抛错', async () => {
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
    resetEnvCache();
    await closeDb();
    try {
      const store = ConfigStore.fromMemory(buildConfig(), tmpYamlPath('sync'));
      await expect(store.syncToPg()).resolves.toBeUndefined();
    } finally {
      resetEnvCache();
    }
  }, 30_000);
});
