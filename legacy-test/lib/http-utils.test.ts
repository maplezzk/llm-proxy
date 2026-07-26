import { describe, it } from 'node:test'
import assert from 'node:assert'
import { sanitizeApiBase } from '../../src/lib/http-utils.js'

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
