import { describe, it } from 'node:test'
import assert from 'node:assert'
import { buildUpstreamUrl, sanitizeApiBase } from '../../src/lib/http-utils.js'

describe('sanitizeApiBase', () => {
  it('去除末尾的 /v1', () => {
    assert.strictEqual(sanitizeApiBase('https://api.example.com/v1'), 'https://api.example.com')
  })

  it('去除末尾的 /v1/（带斜杠）', () => {
    assert.strictEqual(sanitizeApiBase('https://api.example.com/v1/'), 'https://api.example.com')
  })

  it('大小写不敏感 — /V1', () => {
    assert.strictEqual(sanitizeApiBase('https://api.example.com/V1'), 'https://api.example.com')
  })

  it('不含 /v1 时不变', () => {
    assert.strictEqual(sanitizeApiBase('https://api.example.com'), 'https://api.example.com')
  })

  it('仅去末尾斜杠', () => {
    assert.strictEqual(sanitizeApiBase('https://api.example.com/'), 'https://api.example.com')
  })

  it('v1 不在末尾时不触发 — /v1/models', () => {
    assert.strictEqual(sanitizeApiBase('https://api.example.com/v1/models'), 'https://api.example.com/v1/models')
  })

  it('v1 在中间时不触发 — /v1/extra', () => {
    assert.strictEqual(sanitizeApiBase('https://api.example.com/v1/extra'), 'https://api.example.com/v1/extra')
  })

  it('空字符串', () => {
    assert.strictEqual(sanitizeApiBase(''), '')
  })

  it('仅 /v1', () => {
    assert.strictEqual(sanitizeApiBase('/v1'), '')
  })
})

describe('buildUpstreamUrl', () => {
  const cases = [
    { base: 'https://api.example.com', expected: 'https://api.example.com/v1/chat/completions' },
    { base: 'https://api.example.com///', expected: 'https://api.example.com/v1/chat/completions' },
    { base: 'https://api.example.com/v1', expected: 'https://api.example.com/v1/chat/completions' },
    { base: 'https://api.example.com/v1/', expected: 'https://api.example.com/v1/chat/completions' },
    { base: 'https://api.example.com/v1///', expected: 'https://api.example.com/v1/chat/completions' },
    { base: 'https://api.example.com/V1/', expected: 'https://api.example.com/v1/chat/completions' },
    { base: 'https://api.example.com//v1', expected: 'https://api.example.com/v1/chat/completions' },
    { base: 'https://api.example.com/openai', expected: 'https://api.example.com/openai/v1/chat/completions' },
    { base: 'https://api.example.com/openai/v1/', expected: 'https://api.example.com/openai/v1/chat/completions' },
    { base: 'https://ark.cn-beijing.volces.com/api/v3', expected: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions' },
    { base: 'https://ark.cn-beijing.volces.com/api/v3/', expected: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions' },
    { base: 'https://api.example.com/api/v3///', expected: 'https://api.example.com/api/v3/chat/completions' },
    { base: 'https://api.example.com/v2', expected: 'https://api.example.com/v2/chat/completions' },
    { base: 'https://api.example.com/v10', expected: 'https://api.example.com/v10/chat/completions' },
    { base: 'https://api.example.com/v1.1', expected: 'https://api.example.com/v1.1/chat/completions' },
    { base: 'https://api.example.com/v1beta', expected: 'https://api.example.com/v1beta/chat/completions' },
    { base: 'https://api.example.com/v1beta1/', expected: 'https://api.example.com/v1beta1/chat/completions' },
    { base: 'https://api.example.com/v2alpha2', expected: 'https://api.example.com/v2alpha2/chat/completions' },
    { base: 'https://api.example.com/API/V3', expected: 'https://api.example.com/API/V3/chat/completions' },
    { base: 'https://api.example.com/api/v3/v1', expected: 'https://api.example.com/api/v3/v1/chat/completions' },
    { base: 'https://api.example.com/api/v3/V1///', expected: 'https://api.example.com/api/v3/v1/chat/completions' },
    { base: 'https://api.example.com/service-v3', expected: 'https://api.example.com/service-v3/v1/chat/completions' },
    { base: 'https://api.example.com/v3/service', expected: 'https://api.example.com/v3/service/v1/chat/completions' },
    { base: 'https://api.example.com/v1beta/openai', expected: 'https://api.example.com/v1beta/openai/v1/chat/completions' },
    { base: 'https://api.example.com/v3-custom', expected: 'https://api.example.com/v3-custom/v1/chat/completions' },
    { base: 'https://v3', expected: 'https://v3/v1/chat/completions' },
    { base: 'https://api.example.com?redirect=/v3', expected: 'https://api.example.com/v1/chat/completions?redirect=/v3' },
    { base: 'https://api.example.com/api/v3/?region=cn#debug', expected: 'https://api.example.com/api/v3/chat/completions?region=cn#debug' },
  ]

  for (const { base, expected } of cases) {
    it(base, () => {
      assert.strictEqual(buildUpstreamUrl(base, 'chat/completions'), expected)
    })
  }

  it('endpoint 带前导斜杠也不会覆盖基址路径', () => {
    assert.strictEqual(
      buildUpstreamUrl('https://api.example.com/api/v3/', '/images/generations'),
      'https://api.example.com/api/v3/images/generations'
    )
  })

  it('保留基址参数及 endpoint 的重复和编码查询参数', () => {
    assert.strictEqual(
      buildUpstreamUrl('https://api.example.com/api/v3?region=cn&token=a%2Fb', 'images/generations?trace=1&tag=a&tag=b%2Fc&label=a+b'),
      'https://api.example.com/api/v3/images/generations?region=cn&token=a%2Fb&trace=1&tag=a&tag=b%2Fc&label=a+b'
    )
  })

  it('无效基址继续交由 fetch 的错误处理，不在构造阶段抛出异常', () => {
    assert.strictEqual(buildUpstreamUrl('not-a-url/v1', 'models'), 'not-a-url/v1/models')
  })
})
