/**
 * 模型路由（P1.11）：从 YAML 配置解析出 RouteDecision。
 *
 * 移植 legacy-src/proxy/router.ts（直连路由）+ legacy-src/adapter/router.ts（适配器路由 +
 * thinking 解析），并按设计文档 §5 产出新契约 RouteDecision：
 * - apiKey 不入 IR，以 credentialHandle 表示（YAML 阶段即明文 key 本身，P1.16 后为 vault 引用）；
 * - thinking 归一为 ReasoningSpec（source='route'）；
 * - stream 三态用 StreamPolicy 枚举取代 legacy RouterResult.stream 的 nullable 三态。
 *
 * 设计依据：docs/plans/2026-07-27-003-feat-p1-protocol-core-design.md §4 / §5 / §7.3（不变量 10）。
 */
import type { ConfigStore } from '../config/store.ts';
import type { Provider, ThinkingConfig } from '../config/types.ts';
import { getDefaultApiBase } from '../lib/http-utils.ts';
import type { RouteDecision, StreamPolicy } from './adapters/index.ts';
import type { ClientProtocol, ReasoningSpec, ThinkingType } from './ir/types.ts';

/** 适配器路由错误（带错误码，供 HTTP 层映射状态码）。 */
export class AdapterError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
  }
}

/**
 * YAML ThinkingConfig → ReasoningSpec（source='route'）。
 * 无配置时返回空 spec（仅 source），出站适配器不会注入任何 thinking 字段。
 */
export const toReasoningSpec = (tc: ThinkingConfig | undefined): ReasoningSpec => {
  const spec: ReasoningSpec = { source: 'route' };
  if (!tc) return spec;
  if (tc.budget_tokens) {
    spec.enabled = true;
    spec.budgetTokens = tc.budget_tokens;
  }
  if (tc.reasoning_effort) {
    spec.enabled = true;
    spec.effort = tc.reasoning_effort;
  }
  if (tc.type) {
    spec.type = tc.type as ThinkingType;
    if (tc.type === 'disabled') spec.enabled = false;
    else if (tc.type === 'enabled') spec.enabled = true;
  }
  return spec;
};

/** ReasoningSpec 是否携带显式路由配置（用于与客户端 reasoning 的优先级裁决）。 */
export const hasExplicitThinking = (spec: ReasoningSpec): boolean =>
  spec.budgetTokens !== undefined ||
  spec.effort !== undefined ||
  spec.type !== undefined ||
  spec.enabled !== undefined;

/**
 * 解析流式三态（设计 §7.3 不变量 10）。
 * - passthrough：不注入，跟随客户端（未传 → 非流式）；
 * - default_true：client 未传时注入 true，显式传值尊重客户端；
 * - force_true / force_false：强制覆盖客户端选择。
 *
 * @param clientStream 客户端 wire body 的 stream 原值（undefined = 未传）。
 */
export const resolveStreamPolicy = (
  policy: StreamPolicy,
  clientStream: boolean | undefined,
): boolean => {
  switch (policy) {
    case 'force_true':
      return true;
    case 'force_false':
      return false;
    case 'passthrough':
      return clientStream === true;
    case 'default_true':
      return clientStream ?? true;
  }
};

/**
 * YAML adapter.stream 布尔三态 → StreamPolicy。
 * - undefined → passthrough（legacy：null = 跟随/不注入）；
 * - true → default_true（client 未传时注入 true）；
 * - false → force_false（枚举中唯一表达“关流式”的成员；与 legacy“仅 client 未传时注入 false”
 *   在 client 显式传 true 的边界场景行为不同，见 P1.11 汇报 gotchas）。
 */
export const adapterStreamToPolicy = (stream: boolean | undefined): StreamPolicy => {
  if (stream === undefined) return 'passthrough';
  return stream ? 'default_true' : 'force_false';
};

/** 由 provider + modelId + thinking 组装 RouteDecision。 */
const buildRouteDecision = (params: {
  provider: Provider;
  modelId: string;
  thinking: ThinkingConfig | undefined;
  streamPolicy: StreamPolicy;
  maxTokensOverride?: number;
}): RouteDecision => ({
  providerId: params.provider.name,
  providerProtocol: params.provider.type as ClientProtocol,
  apiBase: params.provider.apiBase ?? getDefaultApiBase(params.provider.type as ClientProtocol),
  // YAML 阶段凭据即明文 key；P1.16 后 credential_ref 取代（vault/secret 引用）。
  credentialHandle: params.provider.apiKey,
  resolvedModel: params.modelId,
  thinking: toReasoningSpec(params.thinking),
  streamPolicy: params.streamPolicy,
  ...(params.maxTokensOverride !== undefined
    ? { maxTokensOverride: params.maxTokensOverride }
    : {}),
});

/**
 * 直连路由：按 providers 声明顺序升序匹配首个命中 model.id 的供应商。
 * （PG 阶段改为 priority 升序；YAML 导入须按数组下标显式写 priority，见设计 §9 风险。）
 * 未命中抛错（HTTP 层映射 404）。
 */
export const routeModel = (store: ConfigStore, modelName: string): RouteDecision => {
  const { config } = store.getConfig();

  for (const provider of config.providers) {
    for (const model of provider.models) {
      if (model.id === modelName) {
        return buildRouteDecision({
          provider,
          modelId: model.id,
          thinking: model.thinking,
          // 直连内置默认：client 未传 stream 时注入 true（legacy RouterResult.stream=undefined 语义）。
          streamPolicy: 'default_true',
        });
      }
    }
  }

  throw new Error(`未找到模型 ID "${modelName}" 对应的 Provider`);
};

/**
 * 按 provider 名称 + 模型 ID 精确路由。
 * 解决不同 provider 下同名模型的歧义问题（如多个 openai 中转站都配了 gpt-4o）。
 */
export const routeModelInProvider = (
  store: ConfigStore,
  providerName: string,
  modelName: string,
): RouteDecision => {
  const { config } = store.getConfig();

  const provider = config.providers.find((p) => p.name === providerName);
  if (!provider) {
    throw new Error(`Provider "${providerName}" 不存在`);
  }

  const model = provider.models.find((m) => m.id === modelName);
  if (!model) {
    throw new Error(`Provider "${providerName}" 下未找到模型 ID "${modelName}"`);
  }

  return buildRouteDecision({
    provider,
    modelId: model.id,
    thinking: model.thinking,
    streamPolicy: 'default_true',
  });
};

/** 适配器路由结果：RouteDecision + 入站协议（由请求路径决定，adapter.type 仅配置校验用）。 */
export interface AdapterRouteResult {
  route: RouteDecision;
  inboundType: ClientProtocol;
}

/**
 * 适配器路由：adapterName + sourceModelId → 映射 → provider → model。
 * thinking 优先取映射上的配置，否则继承目标模型配置（legacy 行为）。
 */
export const resolveAdapterRoute = (
  store: ConfigStore,
  adapterName: string,
  sourceModelId: string,
): AdapterRouteResult => {
  const { config } = store.getConfig();

  const adapter = config.adapters?.find((a) => a.name === adapterName);
  if (!adapter) {
    throw new AdapterError(`适配器 "${adapterName}" 未找到`, 'ADAPTER_NOT_FOUND');
  }

  const mapping = adapter.models.find((m) => m.sourceModelId === sourceModelId);
  if (!mapping) {
    throw new AdapterError(
      `适配器 "${adapterName}" 中未找到模型映射 "${sourceModelId}"`,
      'MODEL_MAPPING_NOT_FOUND',
    );
  }

  const provider = config.providers.find((p) => p.name === mapping.provider);
  if (!provider) {
    throw new AdapterError(
      `适配器 "${adapterName}" 引用的模型供应商 "${mapping.provider}" 不存在`,
      'PROVIDER_NOT_FOUND',
    );
  }

  const model = provider.models.find((m) => m.id === mapping.targetModelId);
  if (!model) {
    throw new AdapterError(
      `模型供应商 "${mapping.provider}" 中未找到模型 "${mapping.targetModelId}"（适配器 "${adapterName}" 引用）`,
      'MODEL_NOT_FOUND',
    );
  }

  return {
    route: buildRouteDecision({
      provider,
      modelId: model.id,
      // 映射级 thinking 优先，否则继承目标模型。
      thinking: mapping.thinking ?? model.thinking,
      streamPolicy: adapterStreamToPolicy(adapter.stream),
      maxTokensOverride: adapter.max_tokens,
    }),
    inboundType: adapter.type as ClientProtocol,
  };
};
