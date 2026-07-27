// P1.12 阶段 A：从 legacy-test/lib/http-utils.test.ts 机械迁移（node:test → vitest）
// 断言语义保持不变，仅替换测试栈与断言 API。
import { describe, it, expect } from 'vitest'
import { sanitizeApiBase } from '../../../legacy-src/lib/http-utils.js'

describe('sanitizeApiBase', () => {
  it('去除末尾的 /v1', () => {
    expect(sanitizeApiBase('https://api.example.com/v1')).toBe('https://api.example.com')
  })

  it('去除末尾的 /v1/（带斜杠）', () => {
    expect(sanitizeApiBase('https://api.example.com/v1/')).toBe('https://api.example.com')
  })

  it('大小写不敏感 — /V1', () => {
    expect(sanitizeApiBase('https://api.example.com/V1')).toBe('https://api.example.com')
  })

  it('不含 /v1 时不变', () => {
    expect(sanitizeApiBase('https://api.example.com')).toBe('https://api.example.com')
  })

  it('仅去末尾斜杠', () => {
    expect(sanitizeApiBase('https://api.example.com/')).toBe('https://api.example.com')
  })

  it('v1 不在末尾时不触发 — /v1/models', () => {
    expect(sanitizeApiBase('https://api.example.com/v1/models')).toBe('https://api.example.com/v1/models')
  })

  it('v1 在中间时不触发 — /v1/extra', () => {
    expect(sanitizeApiBase('https://api.example.com/v1/extra')).toBe('https://api.example.com/v1/extra')
  })

  it('空字符串', () => {
    expect(sanitizeApiBase('')).toBe('')
  })

  it('仅 /v1', () => {
    expect(sanitizeApiBase('/v1')).toBe('')
  })
})
