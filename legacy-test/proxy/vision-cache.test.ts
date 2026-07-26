import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VisionCache, computeImageKey } from '../../src/proxy/vision-cache.js'

function tmpPath(): string {
  return join(tmpdir(), `vision-cache-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}

describe('proxy/vision-cache', () => {
  describe('computeImageKey', () => {
    it('data URI 使用 md5 前缀（包含 mediaType + data）', () => {
      const k1 = computeImageKey('data:image/png;base64,abc')
      const k2 = computeImageKey('data:image/png;base64,abc')
      const k3 = computeImageKey('data:image/png;base64,def')
      const k4 = computeImageKey('data:image/jpeg;base64,abc')
      assert.ok(k1.startsWith('md5:'))
      assert.strictEqual(k1, k2, '相同 data URI 应得到相同键')
      assert.notStrictEqual(k1, k3, 'data 不同键不同')
      assert.notStrictEqual(k1, k4, 'mediaType 不同键不同')
    })

    it('http(s) URL 使用 url: 前缀且不做哈希', () => {
      const k = computeImageKey('https://example.com/a.png')
      assert.strictEqual(k, 'url:https://example.com/a.png')
    })

    it('http URL 同样处理', () => {
      const k = computeImageKey('http://example.com/a.png')
      assert.strictEqual(k, 'url:http://example.com/a.png')
    })

    it('data URI 缺少逗号时仍能生成键', () => {
      const k = computeImageKey('data:malformed')
      assert.ok(k.startsWith('md5:'))
      assert.strictEqual(k, computeImageKey('data:malformed'))
    })
  })

  describe('基本读写', () => {
    let cache: VisionCache
    let path: string

    beforeEach(() => {
      path = tmpPath()
      cache = new VisionCache({ filePath: path, maxEntries: 100 })
    })

    afterEach(() => {
      try { rmSync(path, { force: true }) } catch { /* ignore */ }
    })

    it('未命中返回 null 并累加 misses', () => {
      assert.strictEqual(cache.get('md5:nope'), null)
      const s = cache.getStats()
      assert.strictEqual(s.misses, 1)
      assert.strictEqual(s.hits, 0)
    })

    it('写入后读取命中', () => {
      cache.set('md5:a', '猫')
      const got = cache.get('md5:a')
      assert.strictEqual(got, '猫')
      const s = cache.getStats()
      assert.strictEqual(s.hits, 1)
      assert.strictEqual(s.misses, 0)
      assert.strictEqual(s.size, 1)
    })

    it('同 key 多次 set 取最后一次', () => {
      cache.set('md5:a', 'v1')
      cache.set('md5:a', 'v2')
      assert.strictEqual(cache.get('md5:a'), 'v2')
      assert.strictEqual(cache.getStats().size, 1)
    })
  })

  describe('LRU 淘汰', () => {
    it('超过 maxEntries 时淘汰 lastUsedAt 最早的', async () => {
      // maxEntries=3：填 4 个，第 1 个应被淘汰
      const cache = new VisionCache({ filePath: tmpPath(), maxEntries: 3 })
      cache.set('k1', 'A')
      // 让 k1 的 lastUsedAt 较早
      await new Promise((r) => setTimeout(r, 5))
      cache.set('k2', 'B')
      await new Promise((r) => setTimeout(r, 5))
      cache.set('k3', 'C')
      await new Promise((r) => setTimeout(r, 5))
      // 此时 lastUsedAt: k3 > k2 > k1
      cache.set('k4', 'D') // 超容量，淘汰 k1
      assert.strictEqual(cache.get('k1'), null, 'k1 应被淘汰')
      assert.strictEqual(cache.get('k2'), 'B')
      assert.strictEqual(cache.get('k3'), 'C')
      assert.strictEqual(cache.get('k4'), 'D')
      assert.strictEqual(cache.getStats().size, 3)
    })

    it('命中会更新 lastUsedAt，避免被淘汰', async () => {
      const cache = new VisionCache({ filePath: tmpPath(), maxEntries: 3 })
      cache.set('k1', 'A')
      await new Promise((r) => setTimeout(r, 5))
      cache.set('k2', 'B')
      await new Promise((r) => setTimeout(r, 5))
      cache.set('k3', 'C')
      await new Promise((r) => setTimeout(r, 5))
      // 命中 k1，把它的 lastUsedAt 拉到最新
      cache.get('k1')
      await new Promise((r) => setTimeout(r, 5))
      cache.set('k4', 'D') // 应淘汰 k2（最早的）
      assert.strictEqual(cache.get('k1'), 'A', 'k1 刚命中过，不应被淘汰')
      assert.strictEqual(cache.get('k2'), null, 'k2 应被淘汰')
    })

    it('已有 key 的更新不触发淘汰', () => {
      const cache = new VisionCache({ filePath: tmpPath(), maxEntries: 2 })
      cache.set('k1', 'A')
      cache.set('k2', 'B')
      cache.set('k2', 'B2') // 已有 key，不超容量
      assert.strictEqual(cache.getStats().size, 2)
    })
  })

  describe('磁盘持久化', () => {
    let path: string

    beforeEach(() => {
      path = tmpPath()
    })

    afterEach(() => {
      try { rmSync(path, { force: true }) } catch { /* ignore */ }
    })

    it('load 从 JSON 读回已有 entries', () => {
      // 直接写一个合法的 JSON
      writeFileSync(path, JSON.stringify({
        version: 1,
        maxEntries: 100,
        entries: { 'md5:x': { desc: 'preloaded', lastUsedAt: 1000 } },
      }), 'utf-8')
      const cache = new VisionCache({ filePath: path, maxEntries: 100 })
      cache.load()
      assert.strictEqual(cache.get('md5:x'), 'preloaded')
    })

    it('文件不存在时 load 静默成功（空缓存）', () => {
      const cache = new VisionCache({ filePath: path, maxEntries: 100 })
      cache.load()
      assert.strictEqual(cache.getStats().size, 0)
    })

    it('JSON 损坏时 load 静默成功（空缓存）', () => {
      writeFileSync(path, '{not valid json', 'utf-8')
      const cache = new VisionCache({ filePath: path, maxEntries: 100 })
      cache.load()
      assert.strictEqual(cache.getStats().size, 0)
    })

    it('version 不匹配时视为空缓存', () => {
      writeFileSync(path, JSON.stringify({
        version: 999,
        maxEntries: 100,
        entries: { 'md5:x': { desc: 'wrong-version', lastUsedAt: 0 } },
      }), 'utf-8')
      const cache = new VisionCache({ filePath: path, maxEntries: 100 })
      cache.load()
      assert.strictEqual(cache.getStats().size, 0)
    })

    it('flushSync 写入磁盘', () => {
      const cache = new VisionCache({ filePath: path, maxEntries: 100 })
      cache.set('md5:a', 'hello')
      cache.flushSync()
      assert.ok(existsSync(path), '文件应已生成')
      const parsed = JSON.parse(readFileSync(path, 'utf-8'))
      assert.strictEqual(parsed.version, 1)
      assert.deepStrictEqual(parsed.entries, { 'md5:a': { desc: 'hello', lastUsedAt: parsed.entries['md5:a'].lastUsedAt } })
    })

    it('flushSync 在没有 dirty 时不写盘（不抛错）', () => {
      const cache = new VisionCache({ filePath: path, maxEntries: 100 })
      cache.flushSync()
      assert.strictEqual(existsSync(path), false)
    })

    it('自动创建父目录', () => {
      const nested = join(tmpdir(), `vc-nested-${Date.now()}-${Math.random().toString(36).slice(2)}`, 'sub', 'cache.json')
      const cache = new VisionCache({ filePath: nested, maxEntries: 100 })
      cache.set('md5:a', 'hi')
      cache.flushSync()
      assert.ok(existsSync(nested))
      try { rmSync(join(nested, '..', '..'), { recursive: true, force: true }) } catch { /* ignore */ }
    })
  })

  describe('clear', () => {
    it('清空内存 + 计数 + 磁盘文件', async () => {
      const path = tmpPath()
      const cache = new VisionCache({ filePath: path, maxEntries: 100 })
      cache.set('md5:a', 'A')
      cache.set('md5:b', 'B')
      cache.get('md5:a') // 制造一次 hit
      cache.flushSync()
      assert.ok(existsSync(path))

      await cache.clear()
      const stats = cache.getStats()
      assert.strictEqual(stats.size, 0)
      assert.strictEqual(stats.hits, 0)
      assert.strictEqual(stats.misses, 0)
      // 文件应被写为 entries={}
      const parsed = JSON.parse(readFileSync(path, 'utf-8'))
      assert.deepStrictEqual(parsed.entries, {})
      try { rmSync(path, { force: true }) } catch { /* ignore */ }
    })
  })

  describe('getStats 字段', () => {
    it('初始 hits=0, misses=0, size=0, hitRate=0', () => {
      const cache = new VisionCache({ filePath: tmpPath(), maxEntries: 50 })
      const s = cache.getStats()
      assert.strictEqual(s.hits, 0)
      assert.strictEqual(s.misses, 0)
      assert.strictEqual(s.size, 0)
      assert.strictEqual(s.maxEntries, 50)
      assert.strictEqual(s.hitRate, 0)
    })

    it('hitRate 正确计算', () => {
      const cache = new VisionCache({ filePath: tmpPath(), maxEntries: 50 })
      cache.set('a', 'A')
      cache.get('a') // hit
      cache.get('a') // hit
      cache.get('b') // miss
      const s = cache.getStats()
      assert.strictEqual(s.hits, 2)
      assert.strictEqual(s.misses, 1)
      assert.ok(Math.abs(s.hitRate - 2 / 3) < 1e-9)
    })
  })
})
