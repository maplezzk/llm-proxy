import type { OverrideRule } from '../../src/config/types.ts';
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
  /** 渠道级覆写规则（U5：经 helper 接线后会在 outbound.encode 之后应用）。 */
  overrides?: OverrideRule[];
  /** 渠道优先级（数值越小越优先）。未指定时取 0。 */
  priority?: number;
  /** 渠道上下文窗口上限（token）。 */
  contextWindow?: number;
  /** 渠道最大输出 token 上限（U6 钳制消费）。 */
  maxOutputTokens?: number;
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
  priority: route.priority ?? 0,
  ...(route.max_tokens !== undefined ? { maxTokensOverride: route.max_tokens } : {}),
  ...(route.contextWindow !== undefined ? { contextWindow: route.contextWindow } : {}),
  ...(route.maxOutputTokens !== undefined ? { maxOutputTokens: route.maxOutputTokens } : {}),
  ...(route.overrides && route.overrides.length > 0 ? { overrides: route.overrides } : {}),
});

/**
 * legacy 单渠道描述（makeRouteGroup 的每个元素）。
 *
 * 设计为单渠道扁平描述；多条组合 → RouteDecision[]（已按 priority 升序排好）。
 */
export type LegacyRouteChannelLike = LegacyRouteLike;

/**
 * 测试专用：把多条 legacy 单渠道描述组装为 RouteDecision[]（U3+ 多渠道模型组路由）。
 *
 * 返回的数组按 priority 升序排好，便于断言「候选顺序」。第一个元素作为「主」路由，
 * 其余元素作为 `alternatives`（U6 failover 消费）。如果所有渠道均未指定 priority，
 * 按声明顺序保持原位（priority=0）。
 *
 * 不与生产 router.selectRoute 耦合：测试 helper 只负责构造形如 U3 selectRoute 输出
 * 的 RouteDecision[] 形状（含 alternatives），断言阶段据此校验。
 */
export const makeRouteGroup = (channels: LegacyRouteChannelLike[]): RouteDecision[] => {
  const routes = channels.map(makeRoute);
  routes.sort((a, b) => a.priority - b.priority);
  return routes;
};

/**
 * 测试专用：把 RouteDecision[] 拆成「主路由」+「alternatives」，对齐 U6 forwardPipeline
 * 候选队列的 [route, ...alternatives] 形态。
 */
export const splitPrimaryAndAlternatives = (
  routes: RouteDecision[],
): { primary: RouteDecision; alternatives: RouteDecision[] } => {
  const [primary, ...alternatives] = routes;
  if (!primary) {
    throw new Error('makeRouteGroup: 至少需要一个渠道');
  }
  return { primary, alternatives };
};
