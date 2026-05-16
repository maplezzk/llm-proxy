import { describe, it, mock } from 'node:test'
import assert from 'node:assert'
import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import { CaptureBuffer } from '../../src/proxy/capture.js'

function fakeRes(): ServerResponse {
  const ee = new EventEmitter() as any
  ee.writeHead = () => ee
  ee.write = () => true
  ee.end = () => ee
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
})
