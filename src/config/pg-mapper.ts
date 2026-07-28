/**
 * Config ↔ PG 行映射层（P1.16 增量2）。
 *
 * 设计要点：
 * - `configToRows(config)` 是纯函数：把运行时 Config 翻译成一整套「行束」（ConfigRowBundle）。
 *   行束内使用**合成自增 id**（从 1 递增）保证束内外键自洽；真实落库 id 由
 *   `importConfigToPg` 在插入后重新解析（见 src/db/config-repo.ts）。
 * - `rowsToConfig(bundle)` 是反向纯函数：只依赖 id 的**内部一致性**（不依赖具体取值），
 *   因此既能消费 configToRows 的合成 id 束，也能消费 loadConfigFromPg 读回的真实 id 束。
 * - 外键解析失败（mapping/vision 指向不存在的 provider+model）抛清晰错误。
 *
 * 行束使用轻量行接口（*RowLite），只保留映射所需列，剥离 createdAt/updatedAt/metadata 等
 * 落库时由列默认值补齐的字段，使正反向映射的类型边界清晰。
 *
 * 过渡期已知限制（诚实标注，不做假加密）：
 * - Provider.apiKey 明文写入 providers.credential_ref。
 * - Config.proxyKey 明文写入 proxy_settings.proxy_key_hash。
 */
import type { Config, InputModality, ProviderType, ThinkingConfig } from './types.ts';
import type { StreamPolicy } from '../db/schema/index.ts';

/** providers 行（合成 id）。credential_ref 过渡期存明文 api_key。 */
export interface ProviderRowLite {
  id: number;
  name: string;
  type: ProviderType;
  apiBase: string | null;
  credentialRef: string;
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
}

/** adapters 行（合成 id）。 */
export interface AdapterRowLite {
  id: number;
  name: string;
  inboundType: ProviderType;
  maxTokensOverride: number | null;
  streamPolicy: StreamPolicy;
}

/** adapter_model_mappings 行（合成 adapterId + 合成 providerModelId）。 */
export interface AdapterModelMappingRowLite {
  adapterId: number;
  sourceModelId: string;
  providerModelId: number;
  /** thinking 覆盖；null = 继承 provider_model。 */
  thinkingOverride: ThinkingConfig | null;
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

/**
 * 一整套配置行束。各表 id 为合成值，束内外键自洽；
 * 落库时由 config-repo 重映射为真实自增 id。
 */
export interface ConfigRowBundle {
  providers: ProviderRowLite[];
  providerModels: ProviderModelRowLite[];
  adapters: AdapterRowLite[];
  adapterModelMappings: AdapterModelMappingRowLite[];
  /** 单例表：无 vision 配置时为 null。 */
  visionSettings: VisionSettingRowLite | null;
  proxySettings: ProxySettingRowLite;
}

// PG 各 NOT NULL 列的默认值（与 drizzle schema 保持一致）。
const DEFAULT_LOG_LEVEL = 'info';
const DEFAULT_LOCALE = 'en';
const DEFAULT_PORT = 9000;
const DEFAULT_CAPTURE_MAX_SIZE = 1000;

/** (provider 名, model id) 复合键分隔符（model id 合法字符不含 NUL，避免歧义）。 */
const KEY_SEP = '\u0000';
const modelKey = (providerName: string, modelId: string): string =>
  `${providerName}${KEY_SEP}${modelId}`;

/** Config.adapters[].stream（布尔/缺省）→ stream_policy 枚举。 */
const streamToPolicy = (stream: boolean | undefined): StreamPolicy => {
  if (stream === true) return 'default_true';
  if (stream === false) return 'force_false';
  return 'passthrough';
};

/** stream_policy 枚举 → Config.adapters[].stream（force_true 无布尔对应，归并为 true）。 */
const policyToStream = (policy: StreamPolicy): boolean | undefined => {
  if (policy === 'default_true' || policy === 'force_true') return true;
  if (policy === 'force_false') return false;
  return undefined; // passthrough
};

/** thinking 配置 → provider_models 的思考列（enabled 由是否存在配置推断）。 */
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

/** provider_models 思考列 → ThinkingConfig（thinkingEnabled=false 时返回 undefined）。 */
const columnsToThinking = (row: ProviderModelRowLite): ThinkingConfig | undefined => {
  if (!row.thinkingEnabled) return undefined;
  const tc: ThinkingConfig = {};
  if (row.thinkingBudgetTokens != null) tc.budget_tokens = row.thinkingBudgetTokens;
  if (row.thinkingReasoningEffort != null) {
    tc.reasoning_effort = row.thinkingReasoningEffort as ThinkingConfig['reasoning_effort'];
  }
  if (row.thinkingType != null) tc.type = row.thinkingType;
  return tc;
};

/** 判断输入模态是否等价于默认「仅文本」（用于反向归一为 undefined）。 */
const isTextOnly = (modalities: string[]): boolean =>
  modalities.length === 1 && modalities[0] === 'text';

/**
 * Config → 行束（纯函数）。
 *
 * 合成 id 分配顺序：providers → provider_models → adapters → mappings。
 * mapping/vision 的 provider_model_id 通过 (provider 名, model id) 解析到合成 model id，
 * 解析不到抛清晰错误。
 */
export const configToRows = (config: Config): ConfigRowBundle => {
  const providers: ProviderRowLite[] = [];
  const providerModels: ProviderModelRowLite[] = [];

  // provider 名 → 合成 provider id
  const providerIdByName = new Map<string, number>();
  // (provider 名, model id) → 合成 provider_model id
  const modelIdByKey = new Map<string, number>();

  let nextProviderId = 1;
  let nextModelId = 1;

  // 1) providers + provider_models（先建模型行，供后续解析外键）
  for (const provider of config.providers) {
    const providerSyntheticId = nextProviderId++;
    providerIdByName.set(provider.name, providerSyntheticId);
    providers.push({
      id: providerSyntheticId,
      name: provider.name,
      type: provider.type,
      // TODO(security): P1.16 过渡期明文存储，P2 引入加密/vault 后替换
      credentialRef: provider.apiKey,
      apiBase: provider.apiBase ?? null,
    });

    for (const model of provider.models) {
      const modelSyntheticId = nextModelId++;
      modelIdByKey.set(modelKey(provider.name, model.id), modelSyntheticId);
      providerModels.push({
        id: modelSyntheticId,
        providerId: providerSyntheticId,
        modelId: model.id,
        inputModalities: model.input ?? ['text'],
        ...thinkingToColumns(model.thinking),
      });
    }
  }

  // 解析 (provider 名, model id) → 合成 provider_model id，失败抛清晰错误。
  const resolveModelId = (providerName: string, targetModelId: string, ctx: string): number => {
    const resolved = modelIdByKey.get(modelKey(providerName, targetModelId));
    if (resolved === undefined) {
      throw new Error(
        `configToRows: ${ctx} 引用了不存在的 provider 模型 (provider="${providerName}", model="${targetModelId}")`,
      );
    }
    return resolved;
  };

  // 2) adapters + adapter_model_mappings
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
    });

    for (const mapping of adapter.models) {
      // Model-centric mode（P2.X）：映射指向 model_group，U2 才落库 adapter_model_mappings.model_group_id。
      // U1 阶段 mapper 暂不写 model_group 绑定，仅写 legacy provider/targetModelId 映射。
      if (mapping.model !== undefined) {
        continue;
      }
      const providerModelId = resolveModelId(
        mapping.provider as string,
        mapping.targetModelId as string,
        `adapter "${adapter.name}" 的模型映射 "${mapping.sourceModelId}"`,
      );
      adapterModelMappings.push({
        adapterId: adapterSyntheticId,
        sourceModelId: mapping.sourceModelId,
        providerModelId,
        // thinking 覆盖以 JSONB 存储；null = 继承 provider_model
        thinkingOverride: mapping.thinking ?? null,
      });
    }
  }

  // 3) vision_settings（单例）
  let visionSettings: VisionSettingRowLite | null = null;
  if (config.vision) {
    const providerModelId = resolveModelId(
      config.vision.provider,
      config.vision.model,
      'vision 识图配置',
    );
    visionSettings = {
      providerModelId,
      prompt: config.vision.prompt ?? null,
    };
  }

  // 4) proxy_settings（单例）
  const proxySettings: ProxySettingRowLite = {
    // TODO(security): P1.16 过渡期明文存储 proxy_key，P2 改为 bcrypt/argon2 哈希
    proxyKeyHash: config.proxyKey ?? null,
    logLevel: config.logLevel ?? DEFAULT_LOG_LEVEL,
    locale: config.locale ?? DEFAULT_LOCALE,
    port: config.port ?? DEFAULT_PORT,
    captureMaxSize: config.captureMaxSize ?? DEFAULT_CAPTURE_MAX_SIZE,
  };

  return { providers, providerModels, adapters, adapterModelMappings, visionSettings, proxySettings };
};

/**
 * 行束 → Config（反向纯函数）。
 *
 * 语义归一（与原 Config 语义等价，非逐字节相等）：
 * - input_modalities=['text'] 归一为 input=undefined（仅文本是默认态）。
 * - proxy 各字段忠实读回；若取值为 schema 默认值，可能与「未配置」的原始 Config 不同，
 *   但运行行为一致（如 port=9000 ≡ 未配置）。
 * - credential_ref 明文还原为 apiKey（过渡期）。
 */
export const rowsToConfig = (bundle: ConfigRowBundle): Config => {
  const providerById = new Map(bundle.providers.map((p) => [p.id, p]));
  const modelById = new Map(bundle.providerModels.map((m) => [m.id, m]));

  // providers + 其 models（按行束顺序，保留直连路由优先级语义）
  const providers = bundle.providers.map((p) => ({
    name: p.name,
    type: p.type,
    apiKey: p.credentialRef,
    apiBase: p.apiBase ?? undefined,
    models: bundle.providerModels
      .filter((m) => m.providerId === p.id)
      .map((m) => ({
        id: m.modelId,
        thinking: columnsToThinking(m),
        input: isTextOnly(m.inputModalities) ? undefined : (m.inputModalities as InputModality[]),
      })),
  }));

  // adapters + 其 mappings（解析 provider 名与目标 model id）
  const adapters = bundle.adapters.map((a) => ({
    name: a.name,
    type: a.inboundType,
    max_tokens: a.maxTokensOverride ?? undefined,
    stream: policyToStream(a.streamPolicy),
    models: bundle.adapterModelMappings
      .filter((mm) => mm.adapterId === a.id)
      .map((mm) => {
        const targetModel = modelById.get(mm.providerModelId);
        const targetProvider = targetModel ? providerById.get(targetModel.providerId) : undefined;
        if (!targetModel || !targetProvider) {
          throw new Error(
            `rowsToConfig: adapter "${a.name}" 的映射 "${mm.sourceModelId}" 指向不存在的 provider_model(id=${mm.providerModelId})`,
          );
        }
        return {
          sourceModelId: mm.sourceModelId,
          provider: targetProvider.name,
          targetModelId: targetModel.modelId,
          thinking: mm.thinkingOverride ?? undefined,
        };
      }),
  }));

  // vision（解析 provider 名 + model id）
  let vision: Config['vision'];
  if (bundle.visionSettings) {
    const vm = modelById.get(bundle.visionSettings.providerModelId);
    const vp = vm ? providerById.get(vm.providerId) : undefined;
    if (!vm || !vp) {
      throw new Error(
        `rowsToConfig: vision 指向不存在的 provider_model(id=${bundle.visionSettings.providerModelId})`,
      );
    }
    vision = {
      provider: vp.name,
      model: vm.modelId,
      prompt: bundle.visionSettings.prompt ?? undefined,
    };
  }

  const ps = bundle.proxySettings;
  return {
    providers,
    adapters: adapters.length > 0 ? adapters : undefined,
    vision,
    proxyKey: ps.proxyKeyHash ?? undefined,
    logLevel: ps.logLevel as Config['logLevel'],
    locale: ps.locale,
    port: ps.port,
    captureMaxSize: ps.captureMaxSize,
  };
};
