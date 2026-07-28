/**
 * 模型路由（P1.11 + U3）。
 *
 * 历史：
 * - P1.11：移植 legacy-src/proxy/router.ts（直连路由）+ legacy-src/adapter/router.ts
 *   （适配器路由 + thinking 解析），产出 RouteDecision。
 * - U3：把一对一路由换成"候选列表+选择"，含档位过滤 + 钉死/自动解析。
 *
 * 设计依据：
 * - docs/plans/2026-07-27-003-feat-p1-protocol-core-design.md §4 / §5 / §7.3（不变量 10）；
 * - docs/plans/2026-07-28-001-feat-axonhub-parity-orchestration-plan.md §U3（KTD2/KTD3/KTD7）。
 *
 * 关键不变量（U3）：
 * - 路由单元是逻辑模型组（ModelGroup），每个渠道对应一个 RouteDecision（按 priority 升序）；
 * - 档位过滤：组 contextWindow > 渠道 effective contextWindow → 丢弃（ROUTE_NO_ELIGIBLE_CHANNEL）；
 * - 钉死/自动：mapping.channel 钉死单渠道；mapping.model 不钉死 → 全候选集（AE4）；
 * - U3 不做 failover 重试（U6 职责），仅在 selected 上挂载 alternatives 供 U6 消费。
 */
import type { ConfigStore } from '../config/store.ts';
import type {
  Model,
  ModelChannelRef,
  ModelGroup,
  OverrideRule,
  Provider,
  ThinkingConfig,
} from '../config/types.ts';
import { getDefaultApiBase } from '../lib/http-utils.ts';
import type {
  RouteDecision,
  RouteSelectContext,
  SelectionResult,
  SelectionStrategy,
  StreamPolicy,
} from './adapters/index.ts';
import type { ClientProtocol, ReasoningSpec, ThinkingType } from './ir/types.ts';

/** 路由错误（带错误码，供 HTTP 层映射状态码）。 */
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
 * - false → force_false（枚举中唯一表达"关流式"的成员；与 legacy"仅 client 未传时注入 false"
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
  priority: number;
  maxTokensOverride?: number;
  contextWindow?: number;
  maxOutputTokens?: number;
  overrides?: OverrideRule[];
}): RouteDecision => ({
  providerId: params.provider.name,
  providerProtocol: params.provider.type as ClientProtocol,
  apiBase: params.provider.apiBase ?? getDefaultApiBase(params.provider.type as ClientProtocol),
  // YAML 阶段凭据即明文 key；P1.16 后 credential_ref 取代（vault/secret 引用）。
  credentialHandle: params.provider.apiKey,
  resolvedModel: params.modelId,
  thinking: toReasoningSpec(params.thinking),
  streamPolicy: params.streamPolicy,
  priority: params.priority,
  ...(params.contextWindow !== undefined ? { contextWindow: params.contextWindow } : {}),
  ...(params.maxOutputTokens !== undefined ? { maxOutputTokens: params.maxOutputTokens } : {}),
  ...(params.maxTokensOverride !== undefined
    ? { maxTokensOverride: params.maxTokensOverride }
    : {}),
  ...(params.overrides ? { overrides: params.overrides } : {}),
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
          priority: 0,
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
    priority: 0,
  });
};

// ===================== U3: 候选列表 + 选择 =====================

/** 渠道的有效上下文窗口：channel 自身 → model 默认 → undefined。 */
const effectiveChannelContextWindow = (
  channel: ModelChannelRef,
  model: Model | undefined,
): number | undefined => channel.contextWindow ?? model?.contextWindow;

/**
 * 渠道有效 priority：channel.priority → provider.priority → 0（KTD7 默认级联）。
 */
const effectiveChannelPriority = (channel: ModelChannelRef, provider: Provider): number => {
  if (channel.priority !== undefined) return channel.priority;
  if (provider.priority !== undefined) return provider.priority;
  return 0;
};

/**
 * routeLogicalModel：按 model_group id 解析出档位过滤后的候选 RouteDecision 列表。
 *
 * 算法（KTD7 / R5）：
 * 1. 找 modelGroups[].id === logicalModel 的组；未命中抛 ROUTE_GROUP_NOT_FOUND；
 * 2. 遍历 channels：
 *    a. provider 命中 + provider.enabled !== false；
 *    b. 渠道引用的 model 命中该 provider；
 *    c. 档位过滤：若 group.contextWindow 存在，channel 的 effective contextWindow
 *       未定义或 < group.contextWindow → 丢弃；
 * 3. 按 effective priority 升序排序；
 * 4. 候选列表为空 → 抛 ROUTE_NO_ELIGIBLE_CHANNEL。
 *
 * 直连（proxyHandler）场景下不调用本函数：直连仍走 routeModel（legacy 一对一）。
 * 适配器 + 直连若需要模型组语义，U7+ 再统一改造。
 */
export const routeLogicalModel = (store: ConfigStore, logicalModel: string): RouteDecision[] => {
  const { config } = store.getConfig();

  const group = config.modelGroups?.find((g) => g.id === logicalModel);
  if (!group) {
    throw new AdapterError(
      `逻辑模型 "${logicalModel}" 对应的 model_group 未找到`,
      'ROUTE_GROUP_NOT_FOUND',
    );
  }

  const candidates: RouteDecision[] = [];
  for (const channel of group.channels) {
    const provider = config.providers.find((p) => p.name === channel.provider);
    if (!provider) {
      // provider 不存在：直接跳过（不在 tier 过滤责任范围；validator 已保证引用合法）
      continue;
    }
    if (provider.enabled === false) {
      // provider 被禁用：跳过（保留其他候选）
      continue;
    }
    const model = provider.models.find((m) => m.id === channel.model);
    if (!model) {
      continue;
    }

    // 档位过滤（R5）
    if (group.contextWindow !== undefined) {
      const cw = effectiveChannelContextWindow(channel, model);
      if (cw === undefined || cw < group.contextWindow) {
        continue;
      }
    }

    candidates.push(
      buildRouteDecision({
        provider,
        modelId: model.id,
        thinking: model.thinking,
        streamPolicy: 'default_true',
        priority: effectiveChannelPriority(channel, provider),
        contextWindow: effectiveChannelContextWindow(channel, model),
        maxOutputTokens: channel.maxOutputTokens ?? group.maxOutputTokens,
      }),
    );
  }

  if (candidates.length === 0) {
    throw new AdapterError(
      `逻辑模型 "${logicalModel}" 的所有渠道都被档位过滤或不可用`,
      'ROUTE_NO_ELIGIBLE_CHANNEL',
    );
  }

  // 候选按 priority 升序稳定排序（priority 相同时保留原序）。
  candidates.sort((a, b) => a.priority - b.priority);
  return candidates;
};

/**
 * selectRoute：按策略从候选 RouteDecision[] 中选一个，返回 { selected, alternatives }。
 *
 * KTD2 策略缝：v1 仅实现 'priority'，其他策略（weight/round-robin/latency）后续插件化。
 * - strategy='priority'：按 priority 升序选第一个（不重新排序输入避免负担，
 *   但为了调用方便依然选择基于 priority 稳定选取；本函数依赖 routeLogicalModel
 *   已按 priority 升序输出——但为了对调用方鲁棒，priority 相同时保留原序、第一个
 *   获胜（不是全局最小 priority）。该合约与 U3 路由顺序一致。）
 * 空候选列表抛 ROUTE_ALL_FAILED（U6 在所有渠道失败时使用）。
 *
 * selected.alternatives 字段同步挂上 alternatives（U6 主用入口）。
 */
export const selectRoute = (
  decisions: RouteDecision[],
  _ctx: RouteSelectContext = {},
  strategy: SelectionStrategy = 'priority',
): SelectionResult => {
  if (strategy !== 'priority') {
    throw new Error(`不支持的渠道选择策略: ${strategy}（v1 仅支持 'priority'）`);
  }
  if (decisions.length === 0) {
    throw new AdapterError('渠道候选为空，无法选择路由', 'ROUTE_ALL_FAILED');
  }
  // 为保证调用方的鲁棒性，selectRoute 内部仍以 priority 升序选首选。
  // priority 相同时保留原输入顺序（Array.prototype.sort 是稳定排序）。
  const sorted = [...decisions].sort((a, b) => a.priority - b.priority);
  const [first, ...rest] = sorted;
  if (!first) {
    // 防御性：length>0 但解构为 undefined 不应发生
    throw new AdapterError('渠道候选为空，无法选择路由', 'ROUTE_ALL_FAILED');
  }
  const selected: RouteDecision = rest.length > 0 ? { ...first, alternatives: rest } : first;
  return { selected, alternatives: rest };
};

// ===================== 适配器路由（U3 改造） =====================

/** 适配器路由结果：候选列表 + 入站协议 + 钉死/失败策略元信息。 */
export interface AdapterRouteResult {
  /** 候选 RouteDecision 列表（已档位过滤、按 priority 升序）。U3 由 selectRoute 消费。 */
  routes: RouteDecision[];
  /** 入站协议（由请求路径决定；adapter.type 仅用于配置校验）。 */
  inboundType: ClientProtocol;
  /** 钉死失败行为（KTD3；U3 仅透传，U6 failover 实际消费）。 */
  onFailure: 'hard_fail' | 'fallback';
  /** 是否钉死单渠道（true）/ 走全候选集（false）。U6 据此选择 failover 行为。 */
  isPinnedChannel: boolean;
}

/**
 * 适配器路由：adapterName + sourceModelId → 映射 → 候选 RouteDecision[]。
 *
 * U3 改造要点：
 * - mapping.model（model-centric 模式）：走 routeLogicalModel 拿到档位过滤后的候选；
 *   - 若 mapping.channel 存在（钉死）：从候选中精确挑出该渠道（不参与档位过滤，
 *     因为"用户已显式声明"应优先于 tier 推断，参考 AE4 钉死用例）；
 *   - 若 mapping.channel 缺失（自动）：返回全候选集；
 * - mapping.provider + mapping.targetModelId（legacy 模式）：保持原一对一行为，
 *   包装为单元素 routes 数组（priority=0），adapterHandler 走 selectRoute 统一处理。
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

  const onFailure = adapter.onFailure ?? 'hard_fail';
  const streamPolicy = adapterStreamToPolicy(adapter.stream);
  // U5: 适用覆写规则随路由决策携带，供 pipeline 在 outbound.encode 后、doFetch 前调用 applyOverrides。
  const carryOverrides = mapping.overrides && mapping.overrides.length > 0 ? mapping.overrides : undefined;

  // --- Model-centric 模式：mapping.model ---
  if (mapping.model) {
    const candidates = routeLogicalModel(store, mapping.model);

    if (mapping.channel) {
      // 钉死：精确挑出该渠道（不参与 tier 过滤）。
      const [provName, modelName] = mapping.channel.split('/', 2);
      const matched = candidates.find(
        (c) => c.providerId === provName && c.resolvedModel === modelName,
      );
      if (!matched) {
        // fallback：在所有 group 渠道里再查一次（钉死可能低于组档位但用户显式要求）
        const group = config.modelGroups?.find((g) => g.id === mapping.model);
        const ch = group?.channels.find((c) => `${c.provider}/${c.model}` === mapping.channel);
        if (!ch) {
          throw new AdapterError(
            `钉死渠道 "${mapping.channel}" 不在 model_group "${mapping.model}" 的 channels 列表中`,
            'CHANNEL_NOT_FOUND',
          );
        }
        const provider = config.providers.find((p) => p.name === ch.provider);
        const model = provider?.models.find((m) => m.id === ch.model);
        if (!provider || !model) {
          throw new AdapterError(
            `钉死渠道 "${mapping.channel}" 解析失败：provider 或 model 不存在`,
            'CHANNEL_NOT_FOUND',
          );
        }
        // 构造钉死决策（不应用 tier filter，尊重用户显式声明）
        return {
          routes: [
            buildRouteDecision({
              provider,
              modelId: model.id,
              // 映射级 thinking 优先，否则继承目标模型。
              thinking: mapping.thinking ?? model.thinking,
              streamPolicy,
              priority: effectiveChannelPriority(ch, provider),
              contextWindow: effectiveChannelContextWindow(ch, model),
              maxOutputTokens: ch.maxOutputTokens,
              maxTokensOverride: adapter.max_tokens,
              ...(carryOverrides ? { overrides: carryOverrides } : {}),
            }),
          ],
          inboundType: adapter.type as ClientProtocol,
          onFailure,
          isPinnedChannel: true,
        };
      }
      return {
        routes: [
          {
            ...matched,
            thinking: mapping.thinking ? toReasoningSpec(mapping.thinking) : matched.thinking,
            ...(adapter.max_tokens !== undefined ? { maxTokensOverride: adapter.max_tokens } : {}),
            streamPolicy,
            ...(carryOverrides ? { overrides: carryOverrides } : {}),
          },
        ],
        inboundType: adapter.type as ClientProtocol,
        onFailure,
        isPinnedChannel: true,
      };
    }

    // 自动别名：候选全部注入 mapping 维度的 thinking / streamPolicy / maxTokens。
    return {
      routes: candidates.map((c) => ({
        ...c,
        thinking: mapping.thinking ? toReasoningSpec(mapping.thinking) : c.thinking,
        streamPolicy,
        ...(adapter.max_tokens !== undefined ? { maxTokensOverride: adapter.max_tokens } : {}),
        ...(carryOverrides ? { overrides: carryOverrides } : {}),
      })),
      inboundType: adapter.type as ClientProtocol,
      onFailure,
      isPinnedChannel: false,
    };
  }

  // --- Legacy 模式：mapping.provider + mapping.targetModelId ---
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
    routes: [
      buildRouteDecision({
        provider,
        modelId: model.id,
        // 映射级 thinking 优先，否则继承目标模型。
        thinking: mapping.thinking ?? model.thinking,
        streamPolicy,
        priority: 0,
        maxTokensOverride: adapter.max_tokens,
        ...(carryOverrides ? { overrides: carryOverrides } : {}),
      }),
    ],
    inboundType: adapter.type as ClientProtocol,
    onFailure,
    isPinnedChannel: false,
  };
};
