/**
 * Config ↔ PG 行映射层（P1.16，P2 U2 扩展）。
 *
 * 设计要点：
 * - `configToRows(config)` 是纯函数：把运行时 Config 翻译成一整套「行束」（ConfigRowBundle）。
 *   行束内使用合成自增 id 保证外键自洽；真实落库 id 由 config-repo 重映射。
 * - `rowsToConfig(bundle)` 只依赖行束的内部外键一致性，既可消费合成 id，也可消费真实 id。
 * - legacy adapter mapping 会在行束中自动升级为单渠道模型组；反向映射仍还原 legacy 配置形状。
 * - Provider.apiKey / Config.proxyKey 在双写过渡期仍以明文进入 PG 对应列。
 */
import type { StreamPolicy } from '../db/schema/index.ts';
import type {
  AdapterOnFailure,
  ChannelKey,
  Config,
  InputModality,
  OverrideRule,
  ProviderType,
  ThinkingConfig,
} from './types.ts';

/** providers 行（合成 id）。credential_ref 过渡期存明文 api_key。 */
export interface ProviderRowLite {
  id: number;
  name: string;
  type: ProviderType;
  apiBase: string | null;
  credentialRef: string;
  priority: number;
  enabled: boolean;
}

/** provider_models 行（合成 id + 合成 providerId）。 */
export interface ProviderModelRowLite {
  id: number;
  providerId: number;
  modelId: string;
  inputModalities: string[];
  thinkingEnabled: boolean;
  thinkingBudgetTokens: number | null;
  thinkingReasoningEffort: string | null;
  thinkingType: string | null;
  /** 暂存于 provider_models.metadata.contextWindow。 */
  contextWindow: number | null;
}

/** model_groups 行（合成 id）。 */
export interface ModelGroupRowLite {
  id: number;
  name: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  enabled: boolean;
  metadata: Record<string, unknown>;
}

/** model_group_channels 行（合成 id + 合成外键）。 */
export interface ModelGroupChannelRowLite {
  id: number;
  modelGroupId: number;
  providerModelId: number;
  priority: number;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  enabled: boolean;
}

/** adapters 行（合成 id）。 */
export interface AdapterRowLite {
  id: number;
  name: string;
  inboundType: ProviderType;
  maxTokensOverride: number | null;
  streamPolicy: StreamPolicy;
  /** 暂存于 adapters.metadata.onFailure。 */
  onFailure: AdapterOnFailure | null;
}

/** adapter_model_mappings 行（合成外键）。 */
export interface AdapterModelMappingRowLite {
  adapterId: number;
  sourceModelId: string;
  /** Legacy 目标或 model-centric 钉死渠道；auto 模式为 null。 */
  providerModelId: number | null;
  /** Model-centric 绑定；未升级的历史 PG 行可为 null。 */
  modelGroupId: number | null;
  /** thinking 覆盖；null = 继承 provider_model。 */
  thinkingOverride: ThinkingConfig | null;
  /** 复用现有 generation_overrides JSONB 承载声明式覆写规则。 */
  generationOverrides: OverrideRule[] | null;
}

/** vision_settings 单例行（合成 providerModelId）。 */
export interface VisionSettingRowLite {
  providerModelId: number;
  prompt: string | null;
}

/** proxy_settings 单例行。 */
export interface ProxySettingRowLite {
  proxyKeyHash: string | null;
  logLevel: string;
  locale: string;
  port: number;
  captureMaxSize: number;
}

/** 一整套配置行束；所有 id 均在束内自洽。 */
export interface ConfigRowBundle {
  providers: ProviderRowLite[];
  providerModels: ProviderModelRowLite[];
  modelGroups: ModelGroupRowLite[];
  modelGroupChannels: ModelGroupChannelRowLite[];
  adapters: AdapterRowLite[];
  adapterModelMappings: AdapterModelMappingRowLite[];
  visionSettings: VisionSettingRowLite | null;
  proxySettings: ProxySettingRowLite;
}

const DEFAULT_LOG_LEVEL = 'info';
const DEFAULT_LOCALE = 'en';
const DEFAULT_PORT = 9000;
const DEFAULT_CAPTURE_MAX_SIZE = 1000;
const KEY_SEPARATOR = '\u0000';
const LEGACY_MAPPING_METADATA_KEY = 'legacyAdapterMapping';

const modelKey = (providerName: string, modelId: string): string =>
  `${providerName}${KEY_SEPARATOR}${modelId}`;

const streamToPolicy = (stream: boolean | undefined): StreamPolicy => {
  if (stream === true) return 'default_true';
  if (stream === false) return 'force_false';
  return 'passthrough';
};

const policyToStream = (policy: StreamPolicy): boolean | undefined => {
  if (policy === 'default_true' || policy === 'force_true') return true;
  if (policy === 'force_false') return false;
  return undefined;
};

const thinkingToColumns = (
  thinking: ThinkingConfig | undefined,
): Pick<
  ProviderModelRowLite,
  'thinkingEnabled' | 'thinkingBudgetTokens' | 'thinkingReasoningEffort' | 'thinkingType'
> => {
  if (!thinking) {
    return {
      thinkingEnabled: false,
      thinkingBudgetTokens: null,
      thinkingReasoningEffort: null,
      thinkingType: null,
    };
  }
  return {
    thinkingEnabled: true,
    thinkingBudgetTokens: thinking.budget_tokens ?? null,
    thinkingReasoningEffort: thinking.reasoning_effort ?? null,
    thinkingType: thinking.type ?? null,
  };
};

const columnsToThinking = (row: ProviderModelRowLite): ThinkingConfig | undefined => {
  if (!row.thinkingEnabled) return undefined;
  const thinking: ThinkingConfig = {};
  if (row.thinkingBudgetTokens != null) thinking.budget_tokens = row.thinkingBudgetTokens;
  if (row.thinkingReasoningEffort != null) {
    thinking.reasoning_effort = row.thinkingReasoningEffort as ThinkingConfig['reasoning_effort'];
  }
  if (row.thinkingType != null) thinking.type = row.thinkingType;
  return thinking;
};

const isTextOnly = (modalities: string[]): boolean =>
  modalities.length === 1 && modalities[0] === 'text';

const parseChannelKey = (channel: string, context: string): [string, string] => {
  const separatorIndex = channel.indexOf('/');
  if (separatorIndex <= 0 || separatorIndex === channel.length - 1) {
    throw new Error(`configToRows: ${context} 的 channel "${channel}" 必须是 "provider/model"`);
  }
  return [channel.slice(0, separatorIndex), channel.slice(separatorIndex + 1)];
};

const allocateLegacyGroupName = (
  adapterName: string,
  sourceModelId: string,
  usedNames: Set<string>,
): string => {
  const baseName = `__legacy__:${adapterName}:${sourceModelId}`;
  let candidate = baseName;
  let suffix = 2;
  while (usedNames.has(candidate)) {
    candidate = `${baseName}:${suffix++}`;
  }
  usedNames.add(candidate);
  return candidate;
};

const isLegacyModelGroup = (group: ModelGroupRowLite): boolean =>
  group.metadata[LEGACY_MAPPING_METADATA_KEY] === true;

/** Config → 行束（纯函数）。 */
export const configToRows = (config: Config): ConfigRowBundle => {
  const providers: ProviderRowLite[] = [];
  const providerModels: ProviderModelRowLite[] = [];
  const modelIdByKey = new Map<string, number>();
  let nextProviderId = 1;
  let nextProviderModelId = 1;

  for (const provider of config.providers) {
    const providerSyntheticId = nextProviderId++;
    providers.push({
      id: providerSyntheticId,
      name: provider.name,
      type: provider.type,
      credentialRef: provider.apiKey,
      apiBase: provider.apiBase ?? null,
      priority: provider.priority ?? 0,
      enabled: provider.enabled ?? true,
    });

    for (const model of provider.models) {
      const modelSyntheticId = nextProviderModelId++;
      modelIdByKey.set(modelKey(provider.name, model.id), modelSyntheticId);
      providerModels.push({
        id: modelSyntheticId,
        providerId: providerSyntheticId,
        modelId: model.id,
        inputModalities: model.input ?? ['text'],
        ...thinkingToColumns(model.thinking),
        contextWindow: model.contextWindow ?? null,
      });
    }
  }

  const resolveProviderModelId = (
    providerName: string,
    targetModelId: string,
    context: string,
  ): number => {
    const resolved = modelIdByKey.get(modelKey(providerName, targetModelId));
    if (resolved === undefined) {
      throw new Error(
        `configToRows: ${context} 引用了不存在的 provider 模型 (provider="${providerName}", model="${targetModelId}")`,
      );
    }
    return resolved;
  };

  const modelGroups: ModelGroupRowLite[] = [];
  const modelGroupChannels: ModelGroupChannelRowLite[] = [];
  const modelGroupIdByName = new Map<string, number>();
  const channelModelIdsByGroupId = new Map<number, Set<number>>();
  const usedGroupNames = new Set<string>();
  let nextModelGroupId = 1;
  let nextModelGroupChannelId = 1;

  for (const group of config.modelGroups ?? []) {
    if (usedGroupNames.has(group.id)) {
      throw new Error(`configToRows: model_group "${group.id}" 重复`);
    }
    usedGroupNames.add(group.id);
    const groupSyntheticId = nextModelGroupId++;
    modelGroupIdByName.set(group.id, groupSyntheticId);
    modelGroups.push({
      id: groupSyntheticId,
      name: group.id,
      contextWindow: group.contextWindow ?? null,
      maxOutputTokens: group.maxOutputTokens ?? null,
      enabled: true,
      metadata: {},
    });

    const channelModelIds = new Set<number>();
    for (const channel of group.channels) {
      const providerModelId = resolveProviderModelId(
        channel.provider,
        channel.model,
        `model_group "${group.id}" 的渠道`,
      );
      if (channelModelIds.has(providerModelId)) {
        throw new Error(
          `configToRows: model_group "${group.id}" 重复绑定 provider 模型 (provider="${channel.provider}", model="${channel.model}")`,
        );
      }
      channelModelIds.add(providerModelId);
      modelGroupChannels.push({
        id: nextModelGroupChannelId++,
        modelGroupId: groupSyntheticId,
        providerModelId,
        priority: channel.priority ?? 0,
        contextWindow: channel.contextWindow ?? null,
        maxOutputTokens: channel.maxOutputTokens ?? null,
        enabled: true,
      });
    }
    channelModelIdsByGroupId.set(groupSyntheticId, channelModelIds);
  }

  const adapters: AdapterRowLite[] = [];
  const adapterModelMappings: AdapterModelMappingRowLite[] = [];
  let nextAdapterId = 1;

  for (const adapter of config.adapters ?? []) {
    const adapterSyntheticId = nextAdapterId++;
    adapters.push({
      id: adapterSyntheticId,
      name: adapter.name,
      inboundType: adapter.type,
      maxTokensOverride: adapter.max_tokens ?? null,
      streamPolicy: streamToPolicy(adapter.stream),
      onFailure: adapter.onFailure ?? null,
    });

    for (const mapping of adapter.models) {
      const context = `adapter "${adapter.name}" 的模型映射 "${mapping.sourceModelId}"`;
      if (
        mapping.model !== undefined &&
        (mapping.provider !== undefined || mapping.targetModelId !== undefined)
      ) {
        throw new Error(`configToRows: ${context} 不能同时指定 model 与 legacy provider/model`);
      }

      if (mapping.model !== undefined) {
        const modelGroupId = modelGroupIdByName.get(mapping.model);
        if (modelGroupId === undefined) {
          throw new Error(`configToRows: ${context} 引用了不存在的 model_group "${mapping.model}"`);
        }

        let providerModelId: number | null = null;
        if (mapping.channel !== undefined) {
          const [providerName, modelId] = parseChannelKey(mapping.channel, context);
          providerModelId = resolveProviderModelId(providerName, modelId, context);
          if (!channelModelIdsByGroupId.get(modelGroupId)?.has(providerModelId)) {
            throw new Error(
              `configToRows: ${context} 的钉死渠道 "${mapping.channel}" 不属于 model_group "${mapping.model}"`,
            );
          }
        }

        adapterModelMappings.push({
          adapterId: adapterSyntheticId,
          sourceModelId: mapping.sourceModelId,
          providerModelId,
          modelGroupId,
          thinkingOverride: mapping.thinking ?? null,
          generationOverrides: mapping.overrides ?? null,
        });
        continue;
      }

      if (mapping.provider === undefined || mapping.targetModelId === undefined) {
        throw new Error(`configToRows: ${context} 缺少 legacy provider/targetModelId`);
      }
      const providerModelId = resolveProviderModelId(
        mapping.provider,
        mapping.targetModelId,
        context,
      );
      const modelGroupId = nextModelGroupId++;
      const groupName = allocateLegacyGroupName(
        adapter.name,
        mapping.sourceModelId,
        usedGroupNames,
      );
      modelGroups.push({
        id: modelGroupId,
        name: groupName,
        contextWindow: null,
        maxOutputTokens: null,
        enabled: true,
        metadata: { [LEGACY_MAPPING_METADATA_KEY]: true },
      });
      modelGroupChannels.push({
        id: nextModelGroupChannelId++,
        modelGroupId,
        providerModelId,
        priority: 0,
        contextWindow: null,
        maxOutputTokens: null,
        enabled: true,
      });
      channelModelIdsByGroupId.set(modelGroupId, new Set([providerModelId]));

      adapterModelMappings.push({
        adapterId: adapterSyntheticId,
        sourceModelId: mapping.sourceModelId,
        providerModelId,
        modelGroupId,
        thinkingOverride: mapping.thinking ?? null,
        generationOverrides: mapping.overrides ?? null,
      });
    }
  }

  let visionSettings: VisionSettingRowLite | null = null;
  if (config.vision) {
    visionSettings = {
      providerModelId: resolveProviderModelId(
        config.vision.provider,
        config.vision.model,
        'vision 识图配置',
      ),
      prompt: config.vision.prompt ?? null,
    };
  }

  const proxySettings: ProxySettingRowLite = {
    proxyKeyHash: config.proxyKey ?? null,
    logLevel: config.logLevel ?? DEFAULT_LOG_LEVEL,
    locale: config.locale ?? DEFAULT_LOCALE,
    port: config.port ?? DEFAULT_PORT,
    captureMaxSize: config.captureMaxSize ?? DEFAULT_CAPTURE_MAX_SIZE,
  };

  return {
    providers,
    providerModels,
    modelGroups,
    modelGroupChannels,
    adapters,
    adapterModelMappings,
    visionSettings,
    proxySettings,
  };
};

/** 行束 → Config（反向纯函数）。 */
export const rowsToConfig = (bundle: ConfigRowBundle): Config => {
  const providerById = new Map(bundle.providers.map((provider) => [provider.id, provider]));
  const modelById = new Map(bundle.providerModels.map((model) => [model.id, model]));
  const modelGroupRows = bundle.modelGroups ?? [];
  const modelGroupChannelRows = bundle.modelGroupChannels ?? [];
  const modelGroupById = new Map(modelGroupRows.map((group) => [group.id, group]));

  const resolveProviderModel = (
    providerModelId: number,
    context: string,
  ): { provider: ProviderRowLite; model: ProviderModelRowLite } => {
    const model = modelById.get(providerModelId);
    const provider = model ? providerById.get(model.providerId) : undefined;
    if (!model || !provider) {
      throw new Error(
        `rowsToConfig: ${context} 指向不存在的 provider_model(id=${providerModelId})`,
      );
    }
    return { provider, model };
  };

  const providers = bundle.providers.map((provider) => ({
    name: provider.name,
    type: provider.type,
    apiKey: provider.credentialRef,
    apiBase: provider.apiBase ?? undefined,
    priority: provider.priority == null || provider.priority === 0 ? undefined : provider.priority,
    enabled: provider.enabled === false ? false : undefined,
    models: bundle.providerModels
      .filter((model) => model.providerId === provider.id)
      .map((model) => ({
        id: model.modelId,
        thinking: columnsToThinking(model),
        input: isTextOnly(model.inputModalities)
          ? undefined
          : (model.inputModalities as InputModality[]),
        contextWindow: model.contextWindow ?? undefined,
      })),
  }));

  const explicitModelGroups = modelGroupRows
    .filter((group) => !isLegacyModelGroup(group))
    .map((group) => ({
      id: group.name,
      contextWindow: group.contextWindow ?? undefined,
      maxOutputTokens: group.maxOutputTokens ?? undefined,
      channels: modelGroupChannelRows
        .filter((channel) => channel.modelGroupId === group.id)
        .map((channel) => {
          const target = resolveProviderModel(
            channel.providerModelId,
            `model_group "${group.name}" 的渠道`,
          );
          return {
            provider: target.provider.name,
            model: target.model.modelId,
            priority: channel.priority === 0 ? undefined : channel.priority,
            contextWindow: channel.contextWindow ?? undefined,
            maxOutputTokens: channel.maxOutputTokens ?? undefined,
          };
        }),
    }));

  const adapters = bundle.adapters.map((adapter) => ({
    name: adapter.name,
    type: adapter.inboundType,
    max_tokens: adapter.maxTokensOverride ?? undefined,
    stream: policyToStream(adapter.streamPolicy),
    onFailure: adapter.onFailure ?? undefined,
    models: bundle.adapterModelMappings
      .filter((mapping) => mapping.adapterId === adapter.id)
      .map((mapping) => {
        const shared = {
          sourceModelId: mapping.sourceModelId,
          thinking: mapping.thinkingOverride ?? undefined,
          overrides: mapping.generationOverrides ?? undefined,
        };

        if (mapping.modelGroupId !== null) {
          const group = modelGroupById.get(mapping.modelGroupId);
          if (!group) {
            throw new Error(
              `rowsToConfig: adapter "${adapter.name}" 的映射 "${mapping.sourceModelId}" 指向不存在的 model_group(id=${mapping.modelGroupId})`,
            );
          }

          if (!isLegacyModelGroup(group)) {
            let channel: ChannelKey | undefined;
            if (mapping.providerModelId !== null) {
              const target = resolveProviderModel(
                mapping.providerModelId,
                `adapter "${adapter.name}" 的映射 "${mapping.sourceModelId}"`,
              );
              channel = `${target.provider.name}/${target.model.modelId}` as ChannelKey;
            }
            return { ...shared, model: group.name, channel };
          }
        }

        if (mapping.providerModelId === null) {
          throw new Error(
            `rowsToConfig: adapter "${adapter.name}" 的 legacy 映射 "${mapping.sourceModelId}" 缺少 provider_model_id`,
          );
        }
        const target = resolveProviderModel(
          mapping.providerModelId,
          `adapter "${adapter.name}" 的映射 "${mapping.sourceModelId}"`,
        );
        return {
          ...shared,
          provider: target.provider.name,
          targetModelId: target.model.modelId,
        };
      }),
  }));

  let vision: Config['vision'];
  if (bundle.visionSettings) {
    const target = resolveProviderModel(bundle.visionSettings.providerModelId, 'vision');
    vision = {
      provider: target.provider.name,
      model: target.model.modelId,
      prompt: bundle.visionSettings.prompt ?? undefined,
    };
  }

  const proxySettings = bundle.proxySettings;
  return {
    providers,
    modelGroups: explicitModelGroups.length > 0 ? explicitModelGroups : undefined,
    adapters: adapters.length > 0 ? adapters : undefined,
    vision,
    proxyKey: proxySettings.proxyKeyHash ?? undefined,
    logLevel: proxySettings.logLevel as Config['logLevel'],
    locale: proxySettings.locale,
    port: proxySettings.port,
    captureMaxSize: proxySettings.captureMaxSize,
  };
};
