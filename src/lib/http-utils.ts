/**
 * HTTP 工具函数（P1.11 移植自 legacy-src/lib/http-utils.ts）。
 *
 * 仅保留管线所需：默认 api_base 推导、api_base 规整、URL / 请求头脱敏。
 * readBody 未移植（Hono 负责请求体读取）。
 */
import type { ClientProtocol } from '../proxy/ir/types.ts';

/** 按协议推导默认上游 api_base。 */
export const getDefaultApiBase = (type: ClientProtocol): string =>
  type === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com';

/**
 * 去除 api_base 末尾多余的 /v1 路径段，避免拼接 URL 时出现重复 /v1。
 * 例如：
 *   'https://api.example.com/v1'   → 'https://api.example.com'
 *   'https://api.example.com/v1/'  → 'https://api.example.com'
 *   'https://api.example.com'      → 'https://api.example.com'（不变）
 *   'https://api.example.com/'     → 'https://api.example.com'（仅去末尾斜杠）
 */
export const sanitizeApiBase = (base: string): string =>
  // 先去掉末尾的 /v1、/V1（大小写不敏感），同时去掉 v1 后面的斜杠；再统一去掉末尾斜杠
  base
    .replace(/\/+v1\/?$/i, '')
    .replace(/\/+$/, '');

/** 脱敏 URL 中的认证信息。 */
export const maskUrl = (url: string): string => url.replace(/\/\/[^@]+@/, '//***@');

/** 脱敏请求头中的敏感字段（Authorization / x-api-key）。 */
export const maskHeaders = (headers: Record<string, string>): Record<string, string> => {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    h[k] =
      k.toLowerCase() === 'authorization'
        ? v.replace(/Bearer\s+\S+/i, 'Bearer sk-***')
        : k.toLowerCase() === 'x-api-key'
          ? 'sk-***'
          : v;
  }
  return h;
};
