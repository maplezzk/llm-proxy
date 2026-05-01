import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import { StatusTracker } from '../../src/status/tracker.js'

describe('status/tracker', () => {
  it('无请求数据时返回默认状态', () => {
    const t = new StatusTracker(1000)
    const s = t.getStatus('provider-x', 'anthropic')
    assert.strictEqual(s.name, 'provider-x')
    assert.strictEqual(s.type, 'anthropic')
    assert.strictEqual(s.avgLatency, 0)
    assert.strictEqual(s.errorRate, 0)
    assert.strictEqual(s.totalRequests, 0)
    assert.strictEqual(s.available, true)
  })

  it('记录请求后返回正确统计', () => {
    const t = new StatusTracker(5000)
    t.recordRequest('p1', 100, true)
    t.recordRequest('p1', 200, true)
    t.recordRequest('p1', 300, true)
    const s = t.getStatus('p1', 'openai')
    assert.strictEqual(s.totalRequests, 3)
    // (100 + 200 + 300) / 3 = 200
    assert.strictEqual(s.avgLatency, 200)
    assert.strictEqual(s.errorRate, 0)
    assert.strictEqual(s.available, true)
  })

  it('失败请求正确影响 errorRate', () => {
    const t = new StatusTracker(5000)
    t.recordRequest('p1', 50, true)
    t.recordRequest('p1', 60, false)
    t.recordRequest('p1', 70, true)
    t.recordRequest('p1', 80, false)
    // 2 fail / 4 total = 50%
    const s = t.getStatus('p1', 'openai')
    assert.strictEqual(s.errorRate, 50)
    assert.strictEqual(s.available, false) // >= 50% fail → unavailable
  })

  it('滑动窗口过期后数据清除', async () => {
    const t = new StatusTracker(50) // 50ms window
    t.recordRequest('p1', 100, true)
    assert.strictEqual(t.getStatus('p1', 'openai').totalRequests, 1)
    await new Promise((r) => setTimeout(r, 60))
    assert.strictEqual(t.getStatus('p1', 'openai').totalRequests, 0)
  })

  it('getAllStatuses 返回所有 Provider', () => {
    const t = new StatusTracker(5000)
    t.recordRequest('p1', 10, true)
    t.recordRequest('p2', 20, false)
    const statuses = t.getAllStatuses([
      { name: 'p1', type: 'openai' },
      { name: 'p2', type: 'anthropic' },
    ])
    assert.strictEqual(statuses.length, 2)
    assert.strictEqual(statuses[0].name, 'p1')
    assert.strictEqual(statuses[1].name, 'p2')
    assert.strictEqual(statuses[1].totalRequests, 1)
  })
})
