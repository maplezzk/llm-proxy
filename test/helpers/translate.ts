/**
 * 测试专用接线 helper：把新适配器串成「wire → IR → wire」转换，便于对单个转换做行为断言。
 *
 * 这是测试工具，不是生产接口（生产走 forwardPipeline）。内部全部调用新架构 API：
 * inbound.decode → normalizeRequest → applyRouteDecision → outbound.encode。
 */
import { inboundAdapters } from '../../src/proxy/adapters/inbound/index.ts';
import { anthropicOutbound } from '../../src/proxy/adapters/outbound/anthropic.ts';
import { openAiChatOutbound } from '../../src/proxy/adapters/outbound/openai-chat.ts';
import { openAiResponsesOutbound } from '../../src/proxy/adapters/outbound/openai-responses.ts';
import { normalizeRequest } from '../../src/proxy/ir/canonicalize.ts';
import type { ClientProtocol } from '../../src/proxy/ir/types.ts';
import { applyRouteDecision } from '../../src/proxy/pipeline.ts';
import type { RouteDecision, WireBody } from '../../src/proxy/adapters/index.ts';

const outboundByProtocol = {
  anthropic: anthropicOutbound,
  openai: openAiChatOutbound,
  'openai-responses': openAiResponsesOutbound,
} as const;

export interface TranslateResult {
  body: WireBody;
  crossProtocol: boolean;
}

/**
 * 把客户端 wire body 经新架构转换为目标协议 wire body。
 * @param clientProtocol 入站协议
 * @param route 路由决策（含目标协议、resolvedModel、thinking 配置）
 * @param wireBody 客户端原始 wire body
 */
export const translate = (
  clientProtocol: ClientProtocol,
  route: RouteDecision,
  wireBody: Record<string, unknown>,
): TranslateResult => {
  const inbound = inboundAdapters.find((a) => a.name === clientProtocol);
  if (!inbound) throw new Error(`无入站适配器：${clientProtocol}`);
  const canonical = inbound.decode(wireBody, {
    clientProtocol,
    logicalModel: String(wireBody.model ?? ''),
  });
  const normalized = normalizeRequest(canonical);
  const clientStream = typeof wireBody.stream === 'boolean' ? wireBody.stream : undefined;
  const applied = applyRouteDecision(normalized, route, clientStream);
  const outbound = outboundByProtocol[route.providerProtocol];
  const body = outbound.encode(applied, route);
  return { body, crossProtocol: clientProtocol !== route.providerProtocol };
};
