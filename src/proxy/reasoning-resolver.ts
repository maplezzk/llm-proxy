import type { ReasoningEffort, ReasoningSpec } from './ir/types.ts';

/** 五级 effort 到 Anthropic budget_tokens 的唯一映射。 */
export const EFFORT_BUDGET: Readonly<Record<ReasoningEffort, number>> = {
  low: 1024,
  medium: 4096,
  high: 16384,
  xhigh: 32768,
  max: 65536,
};

const isExplicitOff = (reasoning: ReasoningSpec | undefined): boolean =>
  reasoning?.enabled === false || reasoning?.type === 'disabled';

const hasDecision = (reasoning: ReasoningSpec | undefined): reasoning is ReasoningSpec =>
  reasoning !== undefined &&
  (reasoning.enabled !== undefined ||
    reasoning.effort !== undefined ||
    reasoning.budgetTokens !== undefined ||
    reasoning.type !== undefined ||
    reasoning.summary !== undefined);

/**
 * 统一仲裁 client、route 与 override reasoning。
 * client 显式关闭拥有最高优先级；其余字段按 override > route > client 选择。
 */
export const resolveReasoning = (
  client: ReasoningSpec | undefined,
  route: ReasoningSpec | undefined,
  overrides?: ReasoningSpec,
  maxTokens?: number,
): ReasoningSpec => {
  if (isExplicitOff(client)) {
    return { enabled: false, type: 'disabled', source: 'client' };
  }

  const layers = [overrides, route, client];
  const source = layers.find(hasDecision)?.source ?? 'client';
  const effort = layers.find((item) => item?.effort !== undefined)?.effort;
  const type = layers.find((item) => item?.type !== undefined)?.type;
  const summary = layers.find((item) => item?.summary !== undefined)?.summary;
  const enabled = layers.find((item) => item?.enabled !== undefined)?.enabled;
  const budgetLayer = layers.find(
    (item) => item?.budgetTokens !== undefined || item?.effort !== undefined,
  );
  let budgetTokens =
    budgetLayer?.budgetTokens ??
    (budgetLayer?.effort !== undefined ? EFFORT_BUDGET[budgetLayer.effort] : undefined);

  if (budgetTokens !== undefined && maxTokens !== undefined) {
    budgetTokens = Math.min(budgetTokens, Math.max(0, maxTokens - 1));
  }

  const active =
    enabled === true ||
    type === 'enabled' ||
    type === 'adaptive' ||
    type === 'auto' ||
    effort !== undefined ||
    budgetTokens !== undefined ||
    summary !== undefined;

  return {
    ...(active ? { enabled: true } : enabled !== undefined ? { enabled } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(budgetTokens !== undefined ? { budgetTokens } : {}),
    ...(type !== undefined ? { type } : {}),
    ...(summary !== undefined ? { summary } : {}),
    source,
    ...(client?.clientEffort !== undefined
      ? { clientEffort: client.clientEffort }
      : client?.effort !== undefined
        ? { clientEffort: client.effort }
        : {}),
  };
};
