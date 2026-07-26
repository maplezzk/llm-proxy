/**
 * 外挂识图缓存（图片内容 → 文字描述）
 *
 * 存储位置：~/.llm-proxy/vision-cache.json
 *   - base64 图片：键 = "md5:" + md5(mediaType + data)
 *   - URL 图片：   键 = "url:" + 原 URL
 *   - 值 = { desc, lastUsedAt }（lastUsedAt 用于 LRU 淘汰）
 *
 * 容量策略：默认上限 1000 条，超过按 lastUsedAt 升序淘汰
 * 写盘策略：内存变更后 5s 防抖 flush；进程退出前同步 flush
 * 统计：hits / misses（每次 miss 累加，命中时同时更新 lastUsedAt）
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const SCHEMA_VERSION = 1
const DEFAULT_MAX_ENTRIES = 1000
const FLUSH_DEBOUNCE_MS = 5000

export interface CacheEntry {
  desc: string
  /** LRU 时间戳（ms）——命中或写入时更新 */
  lastUsedAt: number
}

interface CacheFileShape {
  version: number
  maxEntries: number
  entries: Record<string, CacheEntry>
}

export interface CacheStats {
  hits: number
  misses: number
  size: number
  maxEntries: number
  hitRate: number
}

export interface VisionCacheOptions {
  filePath: string
  maxEntries?: number
}

/**
 * 计算图片键。
 * - data URI（"data:<mediaType>;base64,<data>"）：md5(mediaType + data)
 * - http(s) URL：原 URL 自身
 * - 其他原样返回（理论上不应出现）
 */
export function computeImageKey(url: string): string {
  if (url.startsWith('data:')) {
    const commaIdx = url.indexOf(',')
    if (commaIdx < 0) return `md5:${createHash('md5').update(url).digest('hex')}`
    // mediaType 在 data: 和 ;base64, 之间
    const meta = url.slice(5, commaIdx) // 形如 "image/png;base64"
    const data = url.slice(commaIdx + 1)
    return `md5:${createHash('md5').update(meta).update(data).digest('hex')}`
  }
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return `url:${url}`
  }
  // 兜底：仍走 md5 避免空键
  return `md5:${createHash('md5').update(url).digest('hex')}`
}

export class VisionCache {
  private readonly filePath: string
  private readonly maxEntries: number
  private map: Map<string, CacheEntry> = new Map()
  private dirty = false
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private hits = 0
  private misses = 0

  constructor(opts: VisionCacheOptions) {
    this.filePath = opts.filePath
    this.maxEntries = Math.max(1, opts.maxEntries ?? DEFAULT_MAX_ENTRIES)
  }

  /** 启动时从磁盘加载（不存在或损坏时静默以空缓存开始） */
  load(): void {
    try {
      if (!existsSync(this.filePath)) return
      const raw = readFileSync(this.filePath, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<CacheFileShape>
      if (parsed && parsed.version === SCHEMA_VERSION && parsed.entries && typeof parsed.entries === 'object') {
        for (const [k, v] of Object.entries(parsed.entries)) {
          if (v && typeof v.desc === 'string') {
            this.map.set(k, { desc: v.desc, lastUsedAt: typeof v.lastUsedAt === 'number' ? v.lastUsedAt : 0 })
          }
        }
      }
    } catch (err) {
      // 加载失败时静默，避免阻塞启动；用空缓存
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[vision-cache] load failed (${this.filePath}): ${msg}`)
      this.map = new Map()
    }
  }

  /**
   * 查询缓存。命中时同步更新 lastUsedAt 与 hits 计数，并标记 dirty。
   * 返回描述文本；未命中返回 null。
   */
  get(key: string): string | null {
    const entry = this.map.get(key)
    if (!entry) {
      this.misses++
      return null
    }
    entry.lastUsedAt = Date.now()
    this.hits++
    this.markDirty()
    return entry.desc
  }

  /**
   * 写入缓存。超容量时按 LRU 淘汰。
   * 注意：写入不增加 hits 计数（hits 仅用于查询命中统计）。
   */
  set(key: string, desc: string): void {
    const now = Date.now()
    if (this.map.has(key)) {
      // 已有同名 key：只更新 desc + 时间戳，不重复淘汰
      this.map.set(key, { desc, lastUsedAt: now })
    } else {
      this.map.set(key, { desc, lastUsedAt: now })
      // 新增时才可能超容量
      if (this.map.size > this.maxEntries) {
        this.evictOldest(this.map.size - this.maxEntries)
      }
    }
    this.markDirty()
  }

  /** 清空缓存：内存 + 磁盘 + 计数 */
  async clear(): Promise<void> {
    this.map.clear()
    this.hits = 0
    this.misses = 0
    this.dirty = false
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    await this.writeJson()
  }

  getStats(): CacheStats {
    const size = this.map.size
    const total = this.hits + this.misses
    return {
      hits: this.hits,
      misses: this.misses,
      size,
      maxEntries: this.maxEntries,
      hitRate: total === 0 ? 0 : this.hits / total,
    }
  }

  /** 防抖 flush：set/get 之后调用 */
  private markDirty(): void {
    this.dirty = true
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      if (this.dirty) this.writeJson()
    }, FLUSH_DEBOUNCE_MS)
  }

  /** 同步写盘（用于 SIGTERM 等退出路径） */
  flushSync(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (!this.dirty) return
    try {
      const dir = dirname(this.filePath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const payload = this.serialize()
      writeFileSync(this.filePath, JSON.stringify(payload, null, 2), 'utf-8')
      this.dirty = false
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[vision-cache] flushSync failed: ${msg}`)
    }
  }

  /** 异步写盘（防抖定时器触发） */
  private async writeJson(): Promise<void> {
    try {
      const dir = dirname(this.filePath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const payload = this.serialize()
      writeFileSync(this.filePath, JSON.stringify(payload, null, 2), 'utf-8')
      this.dirty = false
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[vision-cache] write failed: ${msg}`)
    }
  }

  private serialize(): CacheFileShape {
    return {
      version: SCHEMA_VERSION,
      maxEntries: this.maxEntries,
      entries: Object.fromEntries(this.map),
    }
  }

  /** 按 lastUsedAt 升序淘汰 n 条 */
  private evictOldest(n: number): void {
    if (n <= 0) return
    const sorted = [...this.map.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)
    for (let i = 0; i < n && i < sorted.length; i++) {
      this.map.delete(sorted[i][0])
    }
  }
}
