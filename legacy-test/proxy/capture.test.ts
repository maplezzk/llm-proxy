import { describe, it, mock } from 'node:test'
import assert from 'node:assert'
import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import { CaptureBuffer } from '../../src/proxy/capture.js'

function fakeRes(overrides: Partial<{ destroyed: boolean; writableEnded: boolean; writable: boolean }> = {}): ServerResponse {
  const ee = new EventEmitter() as any
  ee.writeHead = () => ee
  ee.write = () => true
  ee.end = () => ee
  ee.destroyed = overrides.destroyed ?? false
  ee.writableEnded = overrides.writableEnded ?? false
  ee.writable = overrides.writable ?? true
  // 代理到 EventEmitter 原型方法，避免递归
  const origOn = EventEmitter.prototype.on.bind(ee)
  ee.on = (event: string, cb: (...args: any[]) => void) => { origOn(event, cb); return ee }
  return ee as ServerResponse
}

describe('proxy/capture', () => {
  it('startRequest 创建一条记录，返回 pairId', () => {
    const cap = new CaptureBuffer(100)
    const pairId = cap.startRequest('proxy', 'anthropic', 'claude-3')
    assert.strictEqual(typeof pairId, 'number')
    assert.strictEqual(pairId, 1)

    const all = cap.getAll()
    assert.strictEqual(all.length, 1)
    assert.strictEqual(all[0].source, 'proxy')
    assert.strictEqual(all[0].protocol, 'anthropic')
    assert.strictEqual(all[0].model, 'claude-3')
    assert.strictEqual(all[0].pairId, 1)
    assert.strictEqual(all[0].requestIn, null)
  })

  it('updateRequest 更新指定阶段的数据', () => {
    const cap = new CaptureBuffer(100)
    const pairId = cap.startRequest('proxy', 'openai', 'gpt-4')
    cap.updateRequest(pairId, 'requestIn', '{"model":"gpt-4"}')
    cap.updateRequest(pairId, 'responseOut', '{"choices":[]}')

    const entry = cap.getAll()[0]
    assert.strictEqual(entry.requestIn, '{"model":"gpt-4"}')
    assert.strictEqual(entry.responseOut, '{"choices":[]}')
    // 未更新的字段仍为 null
    assert.strictEqual(entry.requestOut, null)
    assert.strictEqual(entry.responseIn, null)
  })

  it('updateRequest 不存在的 pairId 静默忽略', () => {
    const cap = new CaptureBuffer(100)
    // 不应抛异常
    cap.updateRequest(999, 'requestIn', 'data')
  })

  it('startRequest 携带 meta 信息', () => {
    const cap = new CaptureBuffer(100)
    cap.startRequest('adapter', 'anthropic', 'claude-3', {
      adapterName: 'my-tool',
      upstreamProvider: 'anthropic',
      upstreamProtocol: 'anthropic',
      upstreamModel: 'claude-sonnet-4-20250514',
    })

    const entry = cap.getAll()[0]
    assert.strictEqual(entry.adapterName, 'my-tool')
    assert.strictEqual(entry.upstreamProvider, 'anthropic')
    assert.strictEqual(entry.upstreamModel, 'claude-sonnet-4-20250514')
  })

  it('getAll 返回副本，不受后续修改影响', () => {
    const cap = new CaptureBuffer(100)
    cap.startRequest('proxy', 'anthropic', 'claude-3')
    const snapshot = cap.getAll()
    assert.strictEqual(snapshot.length, 1)

    cap.startRequest('proxy', 'openai', 'gpt-4')
    // 旧 snapshot 不受影响
    assert.strictEqual(snapshot.length, 1)
    assert.strictEqual(cap.getAll().length, 2)
  })

  describe('enabled 开关', () => {
    it('默认 enabled = false', () => {
      const cap = new CaptureBuffer(100)
      assert.strictEqual(cap.isEnabled(), false)
    })

    it('disable 后 isEnabled 返回 false', () => {
      const cap = new CaptureBuffer(100)
      cap.disable()
      assert.strictEqual(cap.isEnabled(), false)
    })

    it('enable 后恢复 true', () => {
      const cap = new CaptureBuffer(100)
      cap.disable()
      cap.enable()
      assert.strictEqual(cap.isEnabled(), true)
    })

    it('enable/disable 不影响正常记录功能', () => {
      const cap = new CaptureBuffer(100)
      cap.disable()
      // 开关不影响 buffer 操作——调用方负责判断 isEnabled()
      const pairId = cap.startRequest('proxy', 'anthropic', 'claude-3')
      cap.updateRequest(pairId, 'requestIn', '{}')
      assert.strictEqual(cap.getAll().length, 1)

      cap.enable()
      cap.startRequest('proxy', 'openai', 'gpt-4')
      assert.strictEqual(cap.getAll().length, 2)
    })
  })

  describe('clear', () => {
    it('清空所有记录', () => {
      const cap = new CaptureBuffer(100)
      cap.startRequest('proxy', 'anthropic', 'claude-3')
      cap.startRequest('proxy', 'openai', 'gpt-4')
      assert.strictEqual(cap.getAll().length, 2)

      cap.clear()
      assert.strictEqual(cap.getAll().length, 0)
    })

    it('clear 后 updateRequest 无效（pairId 已不存在）', () => {
      const cap = new CaptureBuffer(100)
      const pairId = cap.startRequest('proxy', 'anthropic', 'claude-3')
      cap.clear()
      // 静默忽略
      cap.updateRequest(pairId, 'requestIn', 'data')
      assert.strictEqual(cap.getAll().length, 0)
    })
  })

  describe('maxSize', () => {
    it('超过 maxSize 时淘汰旧记录', () => {
      const cap = new CaptureBuffer(3)
      cap.startRequest('proxy', 'a', 'm1')
      cap.startRequest('proxy', 'b', 'm2')
      cap.startRequest('proxy', 'c', 'm3')
      assert.strictEqual(cap.getAll().length, 3)

      // 第4条挤掉第1条
      cap.startRequest('proxy', 'd', 'm4')
      assert.strictEqual(cap.getAll().length, 3)
      assert.strictEqual(cap.getAll()[0].model, 'm2')
      assert.strictEqual(cap.getAll()[2].model, 'm4')
    })

    it('淘汰后旧 pairId 无法再 updateRequest', () => {
      const cap = new CaptureBuffer(2)
      const p1 = cap.startRequest('proxy', 'a', 'm1')
      cap.startRequest('proxy', 'b', 'm2')
      cap.startRequest('proxy', 'c', 'm3') // 挤掉 m1

      // p1 已不在 entryMap 中
      cap.updateRequest(p1, 'requestIn', 'data')
      const entry = cap.getAll().find(e => e.pairId === p1)
      assert.strictEqual(entry, undefined)
    })
  })

  describe('subscribe / 通知', () => {
    it('subscribe 后新记录会推送给订阅者', () => {
      const cap = new CaptureBuffer(100)
      const res = fakeRes()
      let written = ''
      res.write = (chunk: any) => { written += chunk.toString(); return true }

      cap.subscribe(res)

      const pairId = cap.startRequest('proxy', 'anthropic', 'claude-3')
      assert.ok(written.includes('"source":"proxy"'))
      assert.ok(written.includes(`"pairId":${pairId}`))

      // 更新也会推送
      cap.updateRequest(pairId, 'requestIn', '{}')
      assert.ok(written.includes('"requestIn":"{}"'))
    })

    it('订阅者 close 后自动移除', () => {
      const cap = new CaptureBuffer(100)
      const res = fakeRes()
      let writeCount = 0
      res.write = () => { writeCount++; return true }

      cap.subscribe(res)
      // 触发 close
      res.emit('close')

      cap.startRequest('proxy', 'anthropic', 'claude-3')
      // close 后应不再有写入
      assert.strictEqual(writeCount, 0)
    })

    it('多个订阅者同时接收通知', () => {
      const cap = new CaptureBuffer(100)
      const res1 = fakeRes()
      const res2 = fakeRes()
      let w1 = ''
      let w2 = ''
      res1.write = (chunk: any) => { w1 += chunk.toString(); return true }
      res2.write = (chunk: any) => { w2 += chunk.toString(); return true }

      cap.subscribe(res1)
      cap.subscribe(res2)
      cap.startRequest('proxy', 'anthropic', 'claude-3')

      assert.ok(w1.includes('"pairId":1'))
      assert.ok(w2.includes('"pairId":1'))
    })
  })

  describe('内存泄漏防护（死 subscriber 清理）', () => {
    it('destroyed=true 的 subscriber 在下次 notify 时被清理', () => {
      const cap = new CaptureBuffer(100)
      const dead = fakeRes({ destroyed: true })
      let writeCount = 0
      dead.write = () => { writeCount++; return true }

      cap.subscribe(dead)
      assert.strictEqual((cap as any).subscribers.size, 1)

      cap.startRequest('proxy', 'anthropic', 'claude-3')

      // 已死的 subscriber 必须被清理，且不接收任何写入
      assert.strictEqual((cap as any).subscribers.size, 0)
      assert.strictEqual(writeCount, 0)
    })

    it('writableEnded=true 的 subscriber 在下次 notify 时被清理', () => {
      const cap = new CaptureBuffer(100)
      const ended = fakeRes({ writableEnded: true })
      let writeCount = 0
      ended.write = () => { writeCount++; return true }

      cap.subscribe(ended)
      cap.startRequest('proxy', 'openai', 'gpt-4')

      assert.strictEqual((cap as any).subscribers.size, 0)
      assert.strictEqual(writeCount, 0)
    })

    it('writable=false 的 subscriber 在下次 notify 时被清理', () => {
      const cap = new CaptureBuffer(100)
      const notWritable = fakeRes({ writable: false })
      let writeCount = 0
      notWritable.write = () => { writeCount++; return true }

      cap.subscribe(notWritable)
      cap.startRequest('proxy', 'openai', 'gpt-4')

      assert.strictEqual((cap as any).subscribers.size, 0)
      assert.strictEqual(writeCount, 0)
    })

    it('混合健康/死亡 subscriber：只推送给健康的', () => {
      const cap = new CaptureBuffer(100)
      const alive = fakeRes()
      const dead1 = fakeRes({ destroyed: true })
      const dead2 = fakeRes({ writableEnded: true })

      let aliveWrites = 0
      alive.write = () => { aliveWrites++; return true }
      dead1.write = () => { throw new Error('dead1 should not be written') }
      dead2.write = () => { throw new Error('dead2 should not be written') }

      cap.subscribe(alive)
      cap.subscribe(dead1)
      cap.subscribe(dead2)
      assert.strictEqual((cap as any).subscribers.size, 3)

      cap.startRequest('proxy', 'openai', 'gpt-4')

      // 两个 dead 被清理，healthy 保留
      assert.strictEqual((cap as any).subscribers.size, 1)
      assert.strictEqual(aliveWrites, 1)
    })

    it('write 抛错的 subscriber 在下次 notify 时被清理', () => {
      const cap = new CaptureBuffer(100)
      const throwing = fakeRes()
      throwing.write = () => { throw new Error('socket closed') }

      cap.subscribe(throwing)
      cap.startRequest('proxy', 'openai', 'gpt-4')

      // 抛错后被清理
      assert.strictEqual((cap as any).subscribers.size, 0)
    })

    it('反压时（write 返回 false）跳过本次写入但不清理 subscriber', () => {
      const cap = new CaptureBuffer(100)
      const slow = fakeRes()
      let writes = 0
      slow.write = () => { writes++; return false }  // 一直反压

      cap.subscribe(slow)
      cap.startRequest('proxy', 'openai', 'gpt-4')

      // 反压不应当作死亡，仅跳过本次写入
      assert.strictEqual((cap as any).subscribers.size, 1)
      assert.strictEqual(writes, 1)
    })
  })

  describe('长时间空闲 subscriber 防护', () => {
    it('超过空闲阈值的 subscriber 在 pruneStaleSubscribers 时被清理', () => {
      const cap = new CaptureBuffer(100)
      const idle = fakeRes()
      cap.subscribe(idle)
      assert.strictEqual((cap as any).subscribers.size, 1)

      // 模拟订阅者长时间未活动
      const meta = (cap as any).subscribers.get(idle)
      meta.lastSeen = Date.now() - (60 * 1000 + 1000) // 超过 60s

      // 主动调用私有 prune 方法
      ;(cap as any).pruneStaleSubscribers()

      assert.strictEqual((cap as any).subscribers.size, 0)
    })

    it('活跃的 subscriber（lastSeen 在阈值内）不被清理', () => {
      const cap = new CaptureBuffer(100)
      const active = fakeRes()
      cap.subscribe(active)
      const initialSize = (cap as any).subscribers.size
      assert.strictEqual(initialSize, 1)

      // lastSeen 是刚设置的（Date.now()），不超时
      ;(cap as any).pruneStaleSubscribers()

      assert.strictEqual((cap as any).subscribers.size, 1)
    })

    it('同时清除死亡 + 空闲 subscriber', () => {
      const cap = new CaptureBuffer(100)
      const dead = fakeRes({ destroyed: true })
      const stale = fakeRes()
      const healthy = fakeRes()

      cap.subscribe(dead)
      cap.subscribe(stale)
      cap.subscribe(healthy)
      assert.strictEqual((cap as any).subscribers.size, 3)

      // stale 模拟空闲超时
      const meta = (cap as any).subscribers.get(stale)
      meta.lastSeen = Date.now() - 120_000

      ;(cap as any).pruneStaleSubscribers()

      assert.strictEqual((cap as any).subscribers.size, 1)
    })

    it('notifySubscribers 后更新 lastSeen 防止误清理', () => {
      const cap = new CaptureBuffer(100)
      const sub = fakeRes()
      cap.subscribe(sub)

      // 把 lastSeen 拉远到超时区间
      const meta = (cap as any).subscribers.get(sub)
      meta.lastSeen = Date.now() - 120_000

      // 触发一次 notify（lastSeen 会被刷新到 now）
      cap.startRequest('proxy', 'openai', 'gpt-4')

      // 此时 prune 不应清理该 subscriber
      ;(cap as any).pruneStaleSubscribers()
      assert.strictEqual((cap as any).subscribers.size, 1)
    })

    it('构造函数启动 pruneTimer（unref 不阻止进程退出）', () => {
      const cap = new CaptureBuffer(100)
      assert.ok((cap as any).pruneTimer, 'pruneTimer 应已创建')
      cap.destroy()
      assert.strictEqual((cap as any).pruneTimer, null, 'destroy 后应清空')
    })
  })
})
