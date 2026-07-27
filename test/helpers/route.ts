/**
 * 测试专用：从 legacy 风格的 route 描述构造 RouteDecision。
 * 仅用于测试接线，非生产接口（生产用 router.ts 的 routeModel）。
 */
import type { RouteDecision, StreamPolicy } from '../../src/proxy/adapters/index.ts';
import type { ReasoningEffort, ReasoningSpec, ThinkingType } from '../../src/proxy/ir/types.ts';

/** legacy 测试里 route 的形状（含可选 thinking 配置）。 */
export interface LegacyRouteLike {
  providerName?: string;
  providerType: 'anthropic' | 'openai' | 'openai-responses';
  apiKey?: string;
  apiBase?: string;
  modelId: string;
  thinking?: { budget_tokens?: number; reasoning_effort?: ReasoningEffort; type?: ThinkingType };
  max_tokens?: number;
  streamPolicy?: StreamPolicy;
}

/** legacy route.thinking → ReasoningSpec（source 标记为 route）。 */
const toReasoningSpec = (thinking?: LegacyRouteLike['thinking']): ReasoningSpec => ({
  source: 'route',
  ...(thinking?.budget_tokens !== undefined ? { budgetTokens: thinking.budget_tokens } : {}),
  ...(thinking?.reasoning_effort ? { effort: thinking.reasoning_effort } : {}),
  ...(thinking?.type ? { type: thinking.type } : {}),
});

export const makeRoute = (route: LegacyRouteLike): RouteDecision => ({
  providerId: route.providerName ?? 'test-provider',
  providerProtocol: route.providerType,
  apiBase: route.apiBase ?? 'https://api.test.com',
  credentialHandle: route.apiKey ?? 'test-key',
  resolvedModel: route.modelId,
  thinking: toReasoningSpec(route.thinking),
  streamPolicy: route.streamPolicy ?? 'passthrough',
  ...(route.max_tokens !== undefined ? { maxTokensOverride: route.max_tokens } : {}),
});
