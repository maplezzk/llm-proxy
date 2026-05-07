import { describe, it } from 'node:test'
import assert from 'node:assert'
import { TokenTracker } from '../../src/status/token-tracker.js'

describe('status/token-tracker', () => {
  it('空数据返回默认值', () => {
    const t = new TokenTracker()
    const stats = t.getStats()
    assert.strictEqual(stats.today.input_tokens, 0)
    assert.strictEqual(stats.today.cache_read_input_tokens, 0)
    assert.strictEqual(stats.today.cache_creation_input_tokens, 0)
    assert.strictEqual(stats.today.request_count, 0)
  })

  it('正确累加 token 统计', () => {
    const t = new TokenTracker()
    // 模拟已归一化的数据：input = billable + cache_read + cache_creation = 总输入
    t.record('anthropic', 58646, 1938, 58624, 0)  // 22 + 58624 + 0 = 58646
    const stats = t.getStats()
    assert.strictEqual(stats.today.input_tokens, 58646)              // 总输入
    assert.strictEqual(stats.today.cache_read_input_tokens, 58624)   // 缓存命中
    assert.strictEqual(stats.today.cache_creation_input_tokens, 0)   // 缓存创建
    assert.strictEqual(stats.today.output_tokens, 1938)
    assert.strictEqual(stats.today.request_count, 1)
  })

  it('多次请求累加（已归一化）', () => {
    const t = new TokenTracker()
    // 已归一化：input = billable + cache_read + cache_creation
    t.record('anthropic', 58646, 100, 58624, 0)     // billable=22, read=58624, create=0
    t.record('anthropic', 6050, 200, 1000, 5000)    // billable=50, read=1000, create=5000
    const stats = t.getStats()
    assert.strictEqual(stats.today.input_tokens, 64696)              // 58646 + 6050
    assert.strictEqual(stats.today.cache_read_input_tokens, 59624)   // 58624 + 1000
    assert.strictEqual(stats.today.cache_creation_input_tokens, 5000) // 0 + 5000
    assert.strictEqual(stats.today.request_count, 2)
  })

  it('命中率 = cache_read / 总输入（已归一化）', () => {
    const t = new TokenTracker()
    // Anthropic 源：provider.ts 归一化后 input = billable + cache_read + cache_creation
    t.record('anthropic', 58646, 1938, 58624, 0)  // billable=22, read=58624

    const ts = t.getStats().today
    const cacheRead = ts.cache_read_input_tokens
    const input = ts.input_tokens  // 总输入

    // 命中率 = cache_read / 总输入
    const hitRate = input > 0 ? (cacheRead / input) * 100 : 0

    assert.strictEqual(hitRate, (58624 / 58646) * 100)  // ≈ 99.96%
    assert.strictEqual(hitRate <= 100, true)
  })

  it('命中率 = cache_read / total_input（OpenAI 源）', () => {
    const t = new TokenTracker()
    // OpenAI 源：prompt_tokens 已是总输入，无需累加
    t.record('openai', 2000, 500, 1408, 0)

    const ts = t.getStats().today
    const cacheRead = ts.cache_read_input_tokens
    const input = ts.input_tokens

    const hitRate = (cacheRead / input) * 100
    assert.ok(Math.abs(hitRate - 70.4) < 0.01, `期望 70.4%，实际 ${hitRate}%`)  // 1408 / 2000 = 70.4%
  })

  it('byProvider 按 provider 分组统计', () => {
    const t = new TokenTracker()
    t.record('anthropic', 100, 200, 1000, 0)
    t.record('deepseek', 50, 100, 0, 500)

    const stats = t.getStats()
    assert.ok(stats.byProvider['anthropic'])
    assert.ok(stats.byProvider['deepseek'])
    assert.strictEqual(stats.byProvider['anthropic'].cache_read_input_tokens, 1000)
    assert.strictEqual(stats.byProvider['deepseek'].cache_creation_input_tokens, 500)
  })
})
