// P1.12 阶段 A：从 legacy-test/status/tracker.test.ts 机械迁移（node:test → vitest）
// 断言语义保持不变，仅替换测试栈与断言 API。
import { describe, it, expect } from 'vitest'
import { StatusTracker } from '../../../legacy-src/status/tracker.js'

describe('status/tracker', () => {
  it('无请求数据时返回默认状态', () => {
    const t = new StatusTracker(1000)
    const s = t.getStatus('provider-x', 'anthropic')
    expect(s.name).toBe('provider-x')
    expect(s.type).toBe('anthropic')
    expect(s.avgLatency).toBe(0)
    expect(s.errorRate).toBe(0)
    expect(s.totalRequests).toBe(0)
    expect(s.available).toBe(true)
  })

  it('记录请求后返回正确统计', () => {
    const t = new StatusTracker(5000)
    t.recordRequest('p1', 100, true)
    t.recordRequest('p1', 200, true)
    t.recordRequest('p1', 300, true)
    const s = t.getStatus('p1', 'openai')
    expect(s.totalRequests).toBe(3)
    // (100 + 200 + 300) / 3 = 200
    expect(s.avgLatency).toBe(200)
    expect(s.errorRate).toBe(0)
    expect(s.available).toBe(true)
  })

  it('失败请求正确影响 errorRate', () => {
    const t = new StatusTracker(5000)
    t.recordRequest('p1', 50, true)
    t.recordRequest('p1', 60, false)
    t.recordRequest('p1', 70, true)
    t.recordRequest('p1', 80, false)
    // 2 fail / 4 total = 50%
    const s = t.getStatus('p1', 'openai')
    expect(s.errorRate).toBe(50)
    expect(s.available).toBe(false) // >= 50% fail → unavailable
  })

  it('滑动窗口过期后数据清除', async () => {
    const t = new StatusTracker(50) // 50ms window
    t.recordRequest('p1', 100, true)
    expect(t.getStatus('p1', 'openai').totalRequests).toBe(1)
    await new Promise((r) => setTimeout(r, 60))
    expect(t.getStatus('p1', 'openai').totalRequests).toBe(0)
  })

  it('getAllStatuses 返回所有 Provider', () => {
    const t = new StatusTracker(5000)
    t.recordRequest('p1', 10, true)
    t.recordRequest('p2', 20, false)
    const statuses = t.getAllStatuses([
      { name: 'p1', type: 'openai' },
      { name: 'p2', type: 'anthropic' },
    ])
    expect(statuses.length).toBe(2)
    expect(statuses[0].name).toBe('p1')
    expect(statuses[1].name).toBe('p2')
    expect(statuses[1].totalRequests).toBe(1)
  })
})
