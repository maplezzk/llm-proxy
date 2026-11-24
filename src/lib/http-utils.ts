import type { IncomingMessage } from 'node:http'

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

export function getDefaultApiBase(type: 'anthropic' | 'openai' | 'openai-responses'): string {
  return type === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com'
}

/**
 * 脱敏 URL 中的认证信息。
 */
export function maskUrl(url: string): string {
  return url.replace(/\/\/[^@]+@/, '//***@')
}

/**
 * 脱敏请求头中的敏感字段（Authorization / x-api-key）。
 */
export function maskHeaders(headers: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    h[k] = k.toLowerCase() === 'authorization'
      ? v.replace(/Bearer\s+\S+/i, 'Bearer sk-***')
      : k.toLowerCase() === 'x-api-key'
        ? 'sk-***'
        : v
  }
  return h
}

/** 去除末尾 /v1 和斜杠的旧归一化规则；构造上游 URL 请使用 buildUpstreamUrl。 */
export function sanitizeApiBase(base: string): string {
  // 先去掉末尾的 /v1、/V1（大小写不敏感），同时去掉 v1 后面的斜杠
  // 再统一去掉末尾斜杠
  return base.replace(/\/+v1\/?$/i, '').replace(/\/+$/, '')
}

/**
 * 保留 api_base 末尾的显式版本段（/v1、/api/v3、/v1beta1 等），否则默认补 /v1。
 * 非版本网关前缀（如 /openai、/anthropic）沿用原有行为。
 * endpoint 是相对端点路径，可携带查询参数；基址的查询参数也会保留。
 */
export function buildUpstreamUrl(base: string, endpoint: string): string {
  const relativeEndpoint = endpoint.replace(/^\/+/, '')
  let url: URL
  try {
    url = new URL(base)
  } catch {
    // 保留无效基址的旧处理方式，由调用方 fetch 的错误处理返回错误。
    return `${sanitizeApiBase(base)}/v1/${relativeEndpoint}`
  }

  const pathname = url.pathname.replace(/\/+$/, '')
  const apiPath = /\/v\d+(?:\.\d+)*(?:(?:alpha|beta)\d*)?$/i.test(pathname)
    ? pathname.replace(/\/+v1$/i, '/v1')
    : `${pathname}/v1`
  const queryIndex = relativeEndpoint.indexOf('?')
  const endpointPath = queryIndex === -1 ? relativeEndpoint : relativeEndpoint.slice(0, queryIndex)
  url.pathname = `${apiPath}/${endpointPath}`
  if (queryIndex !== -1) {
    url.search = [url.search.slice(1), relativeEndpoint.slice(queryIndex + 1)].filter(Boolean).join('&')
  }
  return url.toString()
}
