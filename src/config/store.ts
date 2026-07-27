/**
 * 配置存储（P1.11 移植自 legacy-src/config/store.ts）。
 *
 * - 启动时从 YAML 加载 + 校验；读写经串行 mutex 保证一致。
 * - YAML 仍为唯一读源；PG 为过渡期 best-effort 镜像（P1.16 增量2）：
 *   - writeConfig 写盘后 best-effort 同步到 PG（失败仅 warn，不影响 YAML 写入成功）。
 *   - create 时若 PG 为空则从 YAML 导入（syncToPg）。
 *   - DATABASE_URL 未配置 / PG 不可用时静默降级，保留 db-less 启动能力。
 */
import { writeFileSync } from 'node:fs';
import { getDb } from '../db/client.ts';
import { importConfigToPg } from '../db/config-repo.ts';
import { providers } from '../db/schema/index.ts';
import { log } from '../lib/logger.ts';
import { loadConfigFromYaml, serializeConfigToYaml } from './parser.ts';
import type { Config, ReloadResult } from './types.ts';
import { validateConfig } from './validator.ts';

/** 极简串行锁：写配置 / 热重载互斥。 */
class SimpleMutex {
  private last: Promise<unknown> = Promise.resolve();

  async run<T>(fn: () => T | Promise<T>): Promise<T> {
    const next: Promise<T> = this.last.then(
      () => fn(),
      () => fn(),
    );
    this.last = next.catch(() => {});
    return next;
  }
}

/** 内存配置存储（YAML 持久化）。 */
export class ConfigStore {
  private current: Config;
  private version = 0;
  private readonly configPath: string;
  private readonly mutex = new SimpleMutex();

  constructor(configPath: string, config: Config) {
    this.configPath = configPath;
    this.current = config;
  }

  /** 从 YAML 文件创建（加载 + 校验，失败抛错）。随后 best-effort 同步到 PG。 */
  static async create(configPath: string): Promise<ConfigStore> {
    const config = loadConfigFromYaml(configPath);
    const errors = validateConfig(config);
    if (errors.length > 0) {
      throw new Error(`配置校验失败:\n${errors.map((e) => `  - ${e.message}`).join('\n')}`);
    }
    const store = new ConfigStore(configPath, config);
    // 启动导入：PG 为空时从 YAML 导入。best-effort，db-less / 无 DATABASE_URL 不报错不阻塞。
    await store.syncToPg();
    return store;
  }

  /** 以内存配置创建（测试 / 无配置文件回退用）。configPath 仅用于后续写盘。 */
  static fromMemory(config: Config, configPath = ''): ConfigStore {
    return new ConfigStore(configPath, config);
  }

  getConfig(): { config: Config; version: number } {
    return { config: this.current, version: this.version };
  }

  /** 校验并写盘（原子串行）；YAML 写盘成功后 best-effort 双写 PG。 */
  async writeConfig(config: Config): Promise<void> {
    await this.mutex.run(async () => {
      const errors = validateConfig(config);
      if (errors.length > 0) {
        throw new Error(`配置校验失败:\n${errors.map((e) => `  - ${e.message}`).join('\n')}`);
      }
      const yaml = serializeConfigToYaml(config);
      if (this.configPath) {
        writeFileSync(this.configPath, yaml, 'utf-8');
      }
      this.current = config;
      this.version++;
      // PG 双写：best-effort。DATABASE_URL 未配置 / PG 不可用 / 导入失败均仅 warn，
      // 不影响 YAML 写入成功（YAML 仍为读源）。
      try {
        await importConfigToPg(getDb(), config);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn({ err: msg }, 'writeConfig: PG 双写失败，YAML 仍为可信源');
      }
    });
  }

  /**
   * 启动导入：PG 为空（无 providers）时把当前 YAML 配置导入 PG。
   * best-effort：DATABASE_URL 未配置 / PG 不可用 / 导入失败均仅 warn，绝不抛错。
   */
  async syncToPg(): Promise<void> {
    try {
      const db = getDb();
      const existing = await db.select({ id: providers.id }).from(providers).limit(1);
      if (existing.length > 0) return; // PG 已有配置，不覆盖
      await importConfigToPg(db, this.current);
      log.info('syncToPg: PG 为空，已从 YAML 导入配置');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err: msg }, 'syncToPg: 跳过启动导入，YAML 仍为可信源');
    }
  }

  /** 从磁盘热重载；校验失败不替换当前配置。 */
  async reload(): Promise<ReloadResult> {
    return this.mutex.run(() => {
      try {
        const newConfig = loadConfigFromYaml(this.configPath);
        const errors = validateConfig(newConfig);
        if (errors.length > 0) {
          return { success: false, errors } as const;
        }
        this.current = newConfig;
        this.version++;
        return { success: true, version: this.version } as const;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, errors: [{ field: 'config', message }] } as const;
      }
    });
  }
}
