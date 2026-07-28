/**
 * 测试专用接线 helper：把新适配器串成「wire → IR → wire」转换，便于对单个转换做行为断言。
 *
 * 这是测试工具，不是生产接口（生产走 forwardPipeline）。内部全部调用新架构 API：
 * inbound.decode → normalizeRequest → applyRouteDecision → outbound.encode → applyOverrides。
 *
 * KTD8：applyOverrides 在 outbound.encode 之后应用（操作编码后的 wire body）。
 * 当 route.overrides 为空时 applyOverrides 是 no-op，无破坏性影响；现有 golden
 * （translation-equivalence/translation-response/stream-equivalence/ccx-compat/
 * thinking-injection 共 115 个用例）保持绿色。
 *
 * resolveReasoning 已在 applyRouteDecision 内自动跑，无需本 helper 接线。
 */
import { inboundAdapters } from '../../src/proxy/adapters/inbound/index.ts';
import type { RouteDecision, WireBody } from '../../src/proxy/adapters/index.ts';
import { anthropicOutbound } from '../../src/proxy/adapters/outbound/anthropic.ts';
import { openAiChatOutbound } from '../../src/proxy/adapters/outbound/openai-chat.ts';
import { openAiResponsesOutbound } from '../../src/proxy/adapters/outbound/openai-responses.ts';
import { normalizeRequest } from '../../src/proxy/ir/canonicalize.ts';
import type { ClientProtocol } from '../../src/proxy/ir/types.ts';
import { applyOverrides } from '../../src/proxy/override-engine.ts';
import { applyRouteDecision } from '../../src/proxy/pipeline.ts';

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
 * @param route 路由决策（含目标协议、resolvedModel、thinking 配置、可选 overrides）
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
  let body: WireBody = outbound.encode(applied, route);

  // KTD8：覆写在 outbound.encode 之后、fetch 之前应用。helper 不传 logger（no-op 时也无警告噪声）。
  if (route.overrides && route.overrides.length > 0) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const result = applyOverrides(body, headers, route.overrides, {
      model: String(wireBody.model ?? ''),
      logicalModel: String(wireBody.model ?? ''),
      provider: route.providerId,
      providerProtocol: route.providerProtocol,
      resolvedModel: route.resolvedModel,
    });
    body = result.body;
  }

  return { body, crossProtocol: clientProtocol !== route.providerProtocol };
};
