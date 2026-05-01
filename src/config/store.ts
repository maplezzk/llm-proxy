import { writeFileSync } from 'node:fs'
import type { Config, ReloadResult } from './types.js'
import { loadConfigFromYaml, serializeConfigToYaml } from './parser.js'
import { validateConfig } from './validator.js'

class SimpleMutex {
  private last: Promise<unknown> = Promise.resolve()

  async run<T>(fn: () => T | Promise<T>): Promise<T> {
    const next: Promise<T> = this.last.then(() => fn(), () => fn())
    this.last = next.catch(() => {})
    return next
  }
}

export class ConfigStore {
  private current: Config
  private version = 0
  private configPath: string
  private mutex = new SimpleMutex()

  constructor(configPath: string, config: Config) {
    this.configPath = configPath
    this.current = config
  }

  static async create(configPath: string): Promise<ConfigStore> {
    const config = loadConfigFromYaml(configPath)
    const errors = validateConfig(config)
    if (errors.length > 0) {
      throw new Error(`配置校验失败:\n${errors.map((e) => `  - ${e.message}`).join('\n')}`)
    }
    return new ConfigStore(configPath, config)
  }

  getConfig(): { config: Config; version: number } {
    return { config: this.current, version: this.version }
  }

  async writeConfig(config: Config): Promise<void> {
    await this.mutex.run(async () => {
      const yaml = serializeConfigToYaml(config)
      writeFileSync(this.configPath, yaml, 'utf-8')
      this.current = config
      this.version++
    })
  }

  async reload(): Promise<ReloadResult> {
    return this.mutex.run(() => {
      try {
        const newConfig = loadConfigFromYaml(this.configPath)
        const errors = validateConfig(newConfig)
        if (errors.length > 0) {
          return { success: false, errors } as const
        }
        this.current = newConfig
        this.version++
        return { success: true, version: this.version } as const
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { success: false, errors: [{ field: 'config', message }] } as const
      }
    })
  }
}
