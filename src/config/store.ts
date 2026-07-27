/**
 * 配置存储（P1.11 移植自 legacy-src/config/store.ts）。
 *
 * - 启动时从 YAML 加载 + 校验；读写经串行 mutex 保证一致。
 * - 本阶段单一可信来源为 YAML；PG 双写过渡是 P1.16。
 */
import { writeFileSync } from 'node:fs';
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

  /** 从 YAML 文件创建（加载 + 校验，失败抛错）。 */
  static async create(configPath: string): Promise<ConfigStore> {
    const config = loadConfigFromYaml(configPath);
    const errors = validateConfig(config);
    if (errors.length > 0) {
      throw new Error(`配置校验失败:\n${errors.map((e) => `  - ${e.message}`).join('\n')}`);
    }
    return new ConfigStore(configPath, config);
  }

  /** 以内存配置创建（测试 / 无配置文件回退用）。configPath 仅用于后续写盘。 */
  static fromMemory(config: Config, configPath = ''): ConfigStore {
    return new ConfigStore(configPath, config);
  }

  getConfig(): { config: Config; version: number } {
    return { config: this.current, version: this.version };
  }

  /** 校验并写盘（原子串行）。 */
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
    });
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
