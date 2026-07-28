/**
 * 配置校验（P1.11 移植自 legacy-src/config/validator.ts）。
 *
 * 纯函数：校验运行时 Config，返回错误列表（空 = 通过）。
 * 覆盖 providers / adapters / vision / port 四类规则。P2.X 增加：
 *  - model_groups 渠道引用指向已声明的 provider/model
 *  - adapter mapping 要么 model 引用要么 legacy 对，二者不可兼得
 *  - override 规则不得 targeting 保护字段（model/messages/stream/system/tools）
 *  - on_failure 是两个允许值之一
 */
import type {
  AdapterModelMapping,
  Config,
  ModelChannelRef,
  ModelGroup,
  OverrideBodyOp,
  OverrideHeaderOp,
  OverrideRule,
  ValidationError,
} from './types.ts';

const VALID_PROVIDER_NAMES = /^[a-zA-Z0-9_-]+$/;
const VALID_MODEL_NAMES = /^[a-zA-Z0-9_.\-/:]+$/;
const VALID_ADAPTER_NAMES = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const VALID_PROVIDER_TYPES: readonly string[] = ['anthropic', 'openai', 'openai-responses'];
const RESERVED_ADAPTER_NAMES = new Set(['admin', 'v1', 'messages', 'chat', 'completions']);
const VALID_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const VALID_THINKING_TYPES = ['adaptive', 'auto', 'enabled', 'disabled'];
const VALID_ON_FAILURE = ['hard_fail', 'fallback'];
const VALID_OVERRIDE_SCOPES = ['adapter-alias', 'channel'];
const VALID_BODY_OPS = ['set', 'set_if_absent', 'delete'];
const VALID_HEADER_OPS = ['set', 'delete'];
/** 覆写引擎保护字段（按 R12，不得被任何 body/header 操作覆盖）。 */
const PROTECTED_OVERRIDE_PATHS = new Set(['model', 'messages', 'stream', 'system', 'tools']);
const VALID_OVERRIDE_VARIABLES = new Set([
  'model',
  'logicalModel',
  'provider',
  'providerProtocol',
  'resolvedModel',
]);

/** 校验完整配置，返回全部错误（不短路）。 */
export const validateConfig = (config: Config): ValidationError[] => {
  const errors = validateProviders(config);
  const providerIndex = buildProviderIndex(config);
  const modelGroupIndex = buildModelGroupIndex(config);
  errors.push(...validateModelGroups(config, providerIndex));
  errors.push(...validateAdapters(config, providerIndex, modelGroupIndex));
  errors.push(...validateVision(config));
  if (config.port != null) {
    if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
      errors.push({ field: 'port', message: 'port 必须为 1-65535 之间的整数' });
    }
  }
  return errors;
};

/** 构建 provider name → Model[] 索引，供 model_groups / adapter 引用校验。 */
const buildProviderIndex = (config: Config): Map<string, { id: string }[]> => {
  const index = new Map<string, { id: string }[]>();
  for (const provider of config.providers ?? []) {
    index.set(provider.name, (provider.models ?? []).map((m) => ({ id: m.id })));
  }
  return index;
};

/** 构建 model_group id → ModelGroup 索引。 */
const buildModelGroupIndex = (config: Config): Map<string, ModelGroup> => {
  const index = new Map<string, ModelGroup>();
  for (const group of config.modelGroups ?? []) {
    index.set(group.id, group);
  }
  return index;
};

const validateProviders = (config: Config): ValidationError[] => {
  const errors: ValidationError[] = [];

  if (!config.providers || !Array.isArray(config.providers)) {
    errors.push({ field: 'providers', message: 'providers 必须是一个数组' });
    return errors;
  }

  const providerNames = new Set<string>();

  for (const provider of config.providers) {
    if (!provider.name || typeof provider.name !== 'string') {
      errors.push({ field: 'providers[].name', message: '模型供应商名称不能为空' });
      continue;
    }

    if (!VALID_PROVIDER_NAMES.test(provider.name)) {
      errors.push({
        field: `providers.${provider.name}.name`,
        message: `模型供应商名称 "${provider.name}" 包含非法字符，仅支持字母、数字、下划线、中划线`,
      });
    }

    if (providerNames.has(provider.name)) {
      errors.push({
        field: `providers.${provider.name}.name`,
        message: `模型供应商名称 "${provider.name}" 重复`,
      });
    }
    providerNames.add(provider.name);

    if (!VALID_PROVIDER_TYPES.includes(provider.type)) {
      errors.push({
        field: `providers.${provider.name}.type`,
        message: `模型供应商类型 "${provider.type}" 无效，仅支持 anthropic、openai、openai-responses`,
      });
    }

    if (!provider.apiKey || typeof provider.apiKey !== 'string' || provider.apiKey.trim() === '') {
      errors.push({ field: `providers.${provider.name}.api_key`, message: 'API Key 不能为空' });
    }

    if (!provider.models || !Array.isArray(provider.models) || provider.models.length === 0) {
      errors.push({
        field: `providers.${provider.name}.models`,
        message: '每个模型供应商至少需要一个模型 ID',
      });
      continue;
    }

    const modelIds = new Set<string>();
    for (const model of provider.models) {
      if (!model.id || typeof model.id !== 'string') {
        errors.push({
          field: `providers.${provider.name}.models[].id`,
          message: '模型 ID 不能为空',
        });
        continue;
      }

      if (modelIds.has(model.id)) {
        errors.push({
          field: `providers.${provider.name}.models.${model.id}.id`,
          message: `模型 ID "${model.id}" 在模型供应商 "${provider.name}" 中重复`,
        });
      }
      modelIds.add(model.id);

      if (!VALID_MODEL_NAMES.test(model.id)) {
        errors.push({
          field: `providers.${provider.name}.models.${model.id}.id`,
          message: `模型 ID "${model.id}" 包含非法字符，仅支持字母、数字、下划线、点、中划线、斜杠、冒号`,
        });
      }

      // 校验 thinking 配置
      if (model.thinking) {
        if (provider.type === 'anthropic') {
          if (
            !model.thinking.budget_tokens &&
            !model.thinking.type &&
            !model.thinking.reasoning_effort
          ) {
            errors.push({
              field: `providers.${provider.name}.models.${model.id}.thinking`,
              message:
                'Anthropic thinking 模式需要 budget_tokens、reasoning_effort 或 type（如 MiniMax adaptive）',
            });
          }
          if (model.thinking.budget_tokens && model.thinking.budget_tokens < 0) {
            errors.push({
              field: `providers.${provider.name}.models.${model.id}.thinking.budget_tokens`,
              message: 'Anthropic thinking budget_tokens 必须为正整数',
            });
          }
          if (model.thinking.type && !VALID_THINKING_TYPES.includes(model.thinking.type)) {
            errors.push({
              field: `providers.${provider.name}.models.${model.id}.thinking.type`,
              message: 'thinking.type 必须是 adaptive、auto、enabled 或 disabled',
            });
          }
          // reasoning_effort 对 Anthropic 也允许：运行时自动查表映射成 budget_tokens
          if (
            model.thinking.reasoning_effort &&
            !VALID_EFFORTS.includes(model.thinking.reasoning_effort)
          ) {
            errors.push({
              field: `providers.${provider.name}.models.${model.id}.thinking.reasoning_effort`,
              message: 'reasoning_effort 必须是 low、medium、high、xhigh 或 max',
            });
          }
        } else if (provider.type === 'openai' || provider.type === 'openai-responses') {
          if (
            model.thinking.reasoning_effort &&
            !VALID_EFFORTS.includes(model.thinking.reasoning_effort)
          ) {
            errors.push({
              field: `providers.${provider.name}.models.${model.id}.thinking.reasoning_effort`,
              message: 'OpenAI reasoning_effort 必须是 low、medium、high、xhigh 或 max',
            });
          }
          if (model.thinking.budget_tokens) {
            errors.push({
              field: `providers.${provider.name}.models.${model.id}.thinking.budget_tokens`,
              message: 'OpenAI 模型不支持 budget_tokens，请使用 reasoning_effort',
            });
          }
        }
      }

      // 校验 input 模态配置
      if (model.input !== undefined) {
        if (!Array.isArray(model.input) || model.input.length === 0) {
          errors.push({
            field: `providers.${provider.name}.models.${model.id}.input`,
            message: 'input 必须是非空数组，如 ["text", "image"]',
          });
        } else {
          const validModalities = ['text', 'image'];
          for (const mod of model.input) {
            if (!validModalities.includes(mod)) {
              errors.push({
                field: `providers.${provider.name}.models.${model.id}.input`,
                message: `input 模态 "${mod}" 无效，支持: ${validModalities.join(', ')}`,
              });
            }
          }
        }
      }
    }
  }

  return errors;
};

/** 校验 vision（外挂识图）配置：provider + model 必须存在且支持图片。 */
const validateVision = (config: Config): ValidationError[] => {
  const errors: ValidationError[] = [];
  if (!config.vision) return errors;

  if (!config.vision.provider || typeof config.vision.provider !== 'string') {
    errors.push({ field: 'vision.provider', message: '识图模型的 provider 名称不能为空' });
    return errors;
  }
  if (!config.vision.model || typeof config.vision.model !== 'string') {
    errors.push({ field: 'vision.model', message: '识图模型 ID 不能为空' });
    return errors;
  }

  const provider = config.providers.find((p) => p.name === config.vision?.provider);
  if (!provider) {
    errors.push({
      field: 'vision.provider',
      message: `Provider "${config.vision.provider}" 不存在`,
    });
    return errors;
  }

  const model = provider.models.find((m) => m.id === config.vision?.model);
  if (!model) {
    errors.push({
      field: 'vision.model',
      message: `模型 "${config.vision.model}" 不在 provider "${config.vision.provider}" 下`,
    });
    return errors;
  }

  // 校验识图模型本身支持图片输入
  if (!model.input?.includes('image')) {
    errors.push({
      field: 'vision.model',
      message: `识图模型 "${config.vision.model}" 未声明 input: ["image"]，识图模型必须支持图片输入`,
    });
  }

  if (
    config.vision.prompt !== undefined &&
    (typeof config.vision.prompt !== 'string' || config.vision.prompt.trim() === '')
  ) {
    errors.push({ field: 'vision.prompt', message: 'vision.prompt 必须是非空字符串' });
  }

  return errors;
};

const validateAdapters = (
  config: Config,
  providerIndex: Map<string, { id: string }[]>,
  modelGroupIndex: Map<string, ModelGroup>,
): ValidationError[] => {
  const errors: ValidationError[] = [];

  if (!config.adapters || config.adapters.length === 0) {
    return errors;
  }

  const adapterNames = new Set<string>();
  const providerNames = new Set(config.providers.map((p) => p.name));

  for (const adapter of config.adapters) {
    if (!adapter.name || typeof adapter.name !== 'string') {
      errors.push({ field: 'adapters[].name', message: '适配器名称不能为空' });
      continue;
    }

    if (!VALID_ADAPTER_NAMES.test(adapter.name)) {
      errors.push({
        field: `adapters.${adapter.name}.name`,
        message: `适配器名称 "${adapter.name}" 包含非法字符，必须以字母开头，仅支持字母、数字、下划线、中划线`,
      });
    }

    if (RESERVED_ADAPTER_NAMES.has(adapter.name)) {
      errors.push({
        field: `adapters.${adapter.name}.name`,
        message: `适配器名称 "${adapter.name}" 是保留字`,
      });
    }

    if (adapterNames.has(adapter.name)) {
      errors.push({
        field: `adapters.${adapter.name}.name`,
        message: `适配器名称 "${adapter.name}" 重复`,
      });
    }
    adapterNames.add(adapter.name);

    if (providerNames.has(adapter.name)) {
      errors.push({
        field: `adapters.${adapter.name}.name`,
        message: `适配器名称 "${adapter.name}" 与模型供应商名称冲突`,
      });
    }

    if (!VALID_PROVIDER_TYPES.includes(adapter.type)) {
      errors.push({
        field: `adapters.${adapter.name}.type`,
        message: `适配器类型 "${adapter.type}" 无效，仅支持 anthropic、openai、openai-responses`,
      });
    }

    if (!adapter.models || !Array.isArray(adapter.models) || adapter.models.length === 0) {
      errors.push({
        field: `adapters.${adapter.name}.models`,
        message: '每个适配器至少需要一个模型映射',
      });
      continue;
    }

    errors.push(...validateOnFailure(adapter, `adapters.${adapter.name}`));

    const mappingSourceIds = new Set<string>();
    for (const mapping of adapter.models) {
      if (!mapping.sourceModelId || typeof mapping.sourceModelId !== 'string') {
        errors.push({
          field: `adapters.${adapter.name}.models[].sourceModelId`,
          message: '适配前模型 ID 不能为空',
        });
        continue;
      }

      if (mappingSourceIds.has(mapping.sourceModelId)) {
        errors.push({
          field: `adapters.${adapter.name}.models.${mapping.sourceModelId}.sourceModelId`,
          message: `适配前模型 ID "${mapping.sourceModelId}" 在适配器 "${adapter.name}" 中重复`,
        });
      }
      mappingSourceIds.add(mapping.sourceModelId);

      const hasModel = typeof mapping.model === 'string' && mapping.model.length > 0;
      const hasLegacyPair =
        typeof mapping.provider === 'string' &&
        mapping.provider.length > 0 &&
        typeof mapping.targetModelId === 'string' &&
        mapping.targetModelId.length > 0;

      if (hasModel && hasLegacyPair) {
        errors.push({
          field: `adapters.${adapter.name}.models.${mapping.sourceModelId}`,
          message: '不能同时指定 model 引用和 legacy provider+targetModelId',
        });
      } else if (!hasModel && !hasLegacyPair) {
        errors.push({
          field: `adapters.${adapter.name}.models.${mapping.sourceModelId}`,
          message: '必须指定 model 引用或 legacy provider+targetModelId',
        });
      }

      if (hasModel) {
        const group = modelGroupIndex.get(mapping.model as string);
        if (!group) {
          errors.push({
            field: `adapters.${adapter.name}.models.${mapping.sourceModelId}.model`,
            message: `引用的 model_group "${mapping.model}" 不存在`,
          });
        } else if (mapping.channel) {
          // 钉死渠道必须在 model_group 的 channels 中存在
          const [provName, modelName] = (mapping.channel as string).split('/', 2);
          if (!provName || !modelName) {
            errors.push({
              field: `adapters.${adapter.name}.models.${mapping.sourceModelId}.channel`,
              message: `channel "${mapping.channel}" 格式必须是 "provider/model"`,
            });
          } else {
            const matched = group.channels.find(
              (c) => c.provider === provName && c.model === modelName,
            );
            if (!matched) {
              errors.push({
                field: `adapters.${adapter.name}.models.${mapping.sourceModelId}.channel`,
                message: `釘死的渠道 "${mapping.channel}" 不在 model_group "${mapping.model}" 的 channels 列表中`,
              });
            }
          }
        }
      } else if (hasLegacyPair) {
        // Legacy 模式保留原有行为：检查 provider 和 targetModelId 非空
        if (!mapping.provider || typeof mapping.provider !== 'string') {
          errors.push({
            field: `adapters.${adapter.name}.models.${mapping.sourceModelId}.provider`,
            message: '供应商不能为空',
          });
        }

        if (!mapping.targetModelId || typeof mapping.targetModelId !== 'string') {
          errors.push({
            field: `adapters.${adapter.name}.models.${mapping.sourceModelId}.targetModelId`,
            message: '适配后模型 ID 不能为空',
          });
        }
      }

      // 校验 override 规则
      if (mapping.overrides && mapping.overrides.length > 0) {
        errors.push(
          ...validateOverrideRules(
            mapping.overrides,
            `adapters.${adapter.name}.models.${mapping.sourceModelId}.overrides`,
          ),
        );
      }
    }
  }

  return errors;
};

/** 校验 adapter.onFailure 合法值（KTD3）。 */
const validateOnFailure = (
  adapter: { name: string; onFailure?: 'hard_fail' | 'fallback' },
  baseField: string,
): ValidationError[] => {
  if (adapter.onFailure === undefined) return [];
  if (!VALID_ON_FAILURE.includes(adapter.onFailure)) {
    return [
      {
        field: `${baseField}.onFailure`,
        message: `onFailure "${adapter.onFailure}" 必须是 ${VALID_ON_FAILURE.join(' / ')} 之一`,
      },
    ];
  }
  return [];
};

/** 校验 model_groups section：id 唯一、provider/model 引用存在。 */
const validateModelGroups = (
  config: Config,
  providerIndex: Map<string, { id: string }[]>,
): ValidationError[] => {
  const errors: ValidationError[] = [];
  if (!config.modelGroups || config.modelGroups.length === 0) return errors;

  const groupIds = new Set<string>();
  for (const group of config.modelGroups) {
    const baseField = `model_groups.${group.id}`;
    if (!group.id || typeof group.id !== 'string') {
      errors.push({ field: 'model_groups[].id', message: 'model_group id 不能为空' });
      continue;
    }
    if (groupIds.has(group.id)) {
      errors.push({
        field: `model_groups.${group.id}.id`,
        message: `model_group id "${group.id}" 重复`,
      });
    }
    groupIds.add(group.id);

    if (!group.channels || group.channels.length === 0) {
      errors.push({
        field: `${baseField}.channels`,
        message: 'model_group 至少需要一个渠道',
      });
      continue;
    }

    errors.push(...validateModelChannels(group, providerIndex, `${baseField}.channels`));
  }

  return errors;
};

const validateModelChannels = (
  group: ModelGroup,
  providerIndex: Map<string, { id: string }[]>,
  baseField: string,
): ValidationError[] => {
  const errors: ValidationError[] = [];
  for (const channel of group.channels) {
    if (!channel.provider || typeof channel.provider !== 'string') {
      errors.push({
        field: `${baseField}[].provider`,
        message: '渠道引用的 provider 不能为空',
      });
    } else if (!providerIndex.has(channel.provider)) {
      errors.push({
        field: `${baseField}[].provider`,
        message: `model_group "${group.id}" 引用了不存在的 Provider "${channel.provider}"`,
      });
    }

    if (!channel.model || typeof channel.model !== 'string') {
      errors.push({
        field: `${baseField}[].model`,
        message: '渠道引用的 model 不能为空',
      });
    } else {
      const providerModels = providerIndex.get(channel.provider);
      if (providerModels && !providerModels.some((m) => m.id === channel.model)) {
        errors.push({
          field: `${baseField}[].model`,
          message: `model_group "${group.id}" 引用了不存在的模型 "${channel.model}"（provider: ${channel.provider}）`,
        });
      }
    }
  }
  return errors;
};

/** 校验 override 规则：scope/op 合法值 + body/header 不 targeting 保护字段（按 R12）。 */
const validateOverrideRules = (rules: OverrideRule[], baseField: string): ValidationError[] => {
  const errors: ValidationError[] = [];
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    const ruleField = `${baseField}[${i}]`;
    if (!VALID_OVERRIDE_SCOPES.includes(rule.scope)) {
      errors.push({
        field: `${ruleField}.scope`,
        message: `scope "${rule.scope}" 必须是 ${VALID_OVERRIDE_SCOPES.join(' / ')} 之一`,
      });
    }

    if (rule.when !== undefined && typeof rule.when !== 'string') {
      errors.push({
        field: `${ruleField}.when`,
        message: 'when 必须是字符串',
      });
    }

    if (rule.body && rule.body.length > 0) {
      errors.push(...validateBodyOps(rule.body, `${ruleField}.body`));
    }

    if (rule.headers && rule.headers.length > 0) {
      errors.push(...validateHeaderOps(rule.headers, `${ruleField}.headers`));
    }
  }
  return errors;
};

const validateBodyOps = (ops: OverrideBodyOp[], baseField: string): ValidationError[] => {
  const errors: ValidationError[] = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const opField = `${baseField}[${i}]`;
    if (!VALID_BODY_OPS.includes(op.op)) {
      errors.push({
        field: `${opField}.op`,
        message: `body op "${op.op}" 必须是 ${VALID_BODY_OPS.join(' / ')} 之一`,
      });
    }
    if (!op.path || typeof op.path !== 'string') {
      errors.push({
        field: `${opField}.path`,
        message: 'body op path 不能为空',
      });
      continue;
    }
    if (PROTECTED_OVERRIDE_PATHS.has(op.path)) {
      errors.push({
        field: `${opField}.path`,
        message: `路径 "${op.path}" 是覆写引擎受保护字段（model / messages / stream / system / tools），不得覆写`,
      });
    }
    if (op.op !== 'delete' && op.value === undefined) {
      errors.push({
        field: `${opField}.value`,
        message: `body op "${op.op}" 必须提供 value`,
      });
    }
  }
  return errors;
};

const validateHeaderOps = (ops: OverrideHeaderOp[], baseField: string): ValidationError[] => {
  const errors: ValidationError[] = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const opField = `${baseField}[${i}]`;
    if (!VALID_HEADER_OPS.includes(op.op)) {
      errors.push({
        field: `${opField}.op`,
        message: `header op "${op.op}" 必须是 ${VALID_HEADER_OPS.join(' / ')} 之一`,
      });
    }
    if (!op.name || typeof op.name !== 'string') {
      errors.push({
        field: `${opField}.name`,
        message: 'header op name 不能为空',
      });
    }
    if (op.op === 'set' && (op.value === undefined || typeof op.value !== 'string')) {
      errors.push({
        field: `${opField}.value`,
        message: 'header op set 必须提供字符串 value',
      });
    }
  }
  return errors;
};
