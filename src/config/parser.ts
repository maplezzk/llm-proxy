/**
 * YAML 配置加载 / 序列化（P1.11 移植自 legacy-src/config/parser.ts）。
 *
 * - 支持 ${ENV_VAR} 环境变量插值（缺失变量抛错，避免静默注入空 key）。
 * - YAML snake_case ↔ 运行时 camelCase 双向转换，保持与历史 config.yaml 兼容。
 */
import { readFileSync } from 'node:fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { Config, ConfigFile, InputModality, ThinkingConfig } from './types.ts';

const ENV_VAR_PATTERN = /\$\{(\w+)\}/g;

/** 字符串内 ${VAR} 环境变量插值。 */
const interpolateEnvVars = (value: string): string =>
  value.replace(ENV_VAR_PATTERN, (_match, varName: string) => {
    const envVal = process.env[varName];
    if (envVal === undefined) {
      throw new Error(`环境变量 ${varName} 未定义`);
    }
    return envVal;
  });

/** 递归插值所有字符串字段。 */
const interpolateAll = (obj: unknown): unknown => {
  if (typeof obj === 'string') return interpolateEnvVars(obj);
  if (Array.isArray(obj)) return obj.map(interpolateAll);
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = interpolateAll(value);
    }
    return result;
  }
  return obj;
};

/**
 * 解析模型 / 映射条目上的 thinking 配置。
 * 兼容两种写法：thinking.budget_tokens / thinking.type 与顶层 reasoning_effort。
 */
const parseThinkingConfig = (m: {
  thinking?: { budget_tokens?: number; type?: string };
  reasoning_effort?: string;
}): ThinkingConfig | undefined => {
  const tc: ThinkingConfig = {};
  if (m.thinking?.budget_tokens && m.thinking.budget_tokens > 0) {
    tc.budget_tokens = m.thinking.budget_tokens;
  }
  if (
    m.reasoning_effort &&
    ['low', 'medium', 'high', 'xhigh', 'max'].includes(m.reasoning_effort)
  ) {
    tc.reasoning_effort = m.reasoning_effort as ThinkingConfig['reasoning_effort'];
  }
  if (m.thinking?.type && ['adaptive', 'auto', 'enabled', 'disabled'].includes(m.thinking.type)) {
    tc.type = m.thinking.type;
  }
  if (
    tc.budget_tokens === undefined &&
    tc.reasoning_effort === undefined &&
    tc.type === undefined
  ) {
    return undefined;
  }
  return tc;
};

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

/** 从 YAML 文件加载运行时配置。 */
export const loadConfigFromYaml = (filePath: string): Config => {
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = parseYaml(raw) as ConfigFile;
  const interpolated = interpolateAll(parsed) as ConfigFile;

  return {
    providers: (interpolated.providers ?? []).map((p) => ({
      name: p.name,
      type: p.type,
      apiKey: p.api_key,
      apiBase: p.api_base,
      priority: p.priority,
      enabled: p.enabled,
      models: (p.models ?? []).map((m) => ({
        id: m.id,
        thinking: parseThinkingConfig(m),
        input: m.input as InputModality[] | undefined,
        contextWindow: m.context_window,
      })),
    })),
    modelGroups: (interpolated.model_groups ?? []).map((g) => ({
      id: g.id,
      contextWindow: g.context_window,
      maxOutputTokens: g.max_output_tokens,
      channels: (g.channels ?? []).map((c) => ({
        provider: c.provider,
        model: c.model,
        priority: c.priority,
        contextWindow: c.context_window,
        maxOutputTokens: c.max_output_tokens,
      })),
    })),
    adapters: (interpolated.adapters ?? []).map((a) => ({
      name: a.name,
      type: a.type,
      max_tokens: a.max_tokens,
      stream: a.stream,
      onFailure: a.on_failure,
      models: (a.models ?? []).map((m) => ({
        sourceModelId: m.source_model_id,
        provider: m.provider,
        targetModelId: m.target_model_id,
        model: m.model,
        channel: m.channel,
        overrides: (m.overrides ?? []).map((r) => ({
          scope: r.scope,
          when: r.when,
          body: (r.body ?? []).map((op) => ({
            op: op.op,
            path: op.path,
            value: op.value,
          })),
          headers: (r.headers ?? []).map((op) => ({
            op: op.op,
            name: op.name,
            value: op.value,
          })),
        })),
        thinking: parseThinkingConfig(m),
      })),
    })),
    proxyKey: interpolated.proxy_key,
    vision: interpolated.vision
      ? {
          provider: interpolated.vision.provider,
          model: interpolated.vision.model,
          prompt: interpolated.vision.prompt,
        }
      : undefined,
    logLevel: LOG_LEVELS.includes(interpolated.log_level as (typeof LOG_LEVELS)[number])
      ? (interpolated.log_level as Config['logLevel'])
      : undefined,
    locale: interpolated.locale,
    port: interpolated.port,
    captureMaxSize: interpolated.capture_max_size,
  };
};

/** 序列化运行时配置为 YAML 文本（写盘 / 热重载用）。 */
export const serializeConfigToYaml = (config: Config): string => {
  const file: ConfigFile = {
    providers: config.providers.map((p) => ({
      name: p.name,
      type: p.type,
      api_key: p.apiKey,
      api_base: p.apiBase,
      ...(p.priority !== undefined ? { priority: p.priority } : {}),
      ...(p.enabled !== undefined ? { enabled: p.enabled } : {}),
      models: p.models.map((m) => ({
        id: m.id,
        ...(m.thinking?.budget_tokens
          ? { thinking: { budget_tokens: m.thinking.budget_tokens } }
          : {}),
        ...(m.thinking?.type && !m.thinking.budget_tokens
          ? { thinking: { type: m.thinking.type } }
          : {}),
        ...(m.thinking?.type && m.thinking.budget_tokens
          ? { thinking: { budget_tokens: m.thinking.budget_tokens, type: m.thinking.type } }
          : {}),
        ...(m.thinking?.reasoning_effort ? { reasoning_effort: m.thinking.reasoning_effort } : {}),
        ...(m.input?.length ? { input: m.input } : {}),
        ...(m.contextWindow !== undefined ? { context_window: m.contextWindow } : {}),
      })),
    })),
    model_groups: (config.modelGroups ?? []).map((g) => ({
      id: g.id,
      ...(g.contextWindow !== undefined ? { context_window: g.contextWindow } : {}),
      ...(g.maxOutputTokens !== undefined ? { max_output_tokens: g.maxOutputTokens } : {}),
      channels: g.channels.map((c) => ({
        provider: c.provider,
        model: c.model,
        ...(c.priority !== undefined ? { priority: c.priority } : {}),
        ...(c.contextWindow !== undefined ? { context_window: c.contextWindow } : {}),
        ...(c.maxOutputTokens !== undefined ? { max_output_tokens: c.maxOutputTokens } : {}),
      })),
    })),
    adapters: (config.adapters ?? []).map((a) => ({
      name: a.name,
      type: a.type,
      ...(a.max_tokens !== undefined ? { max_tokens: a.max_tokens } : {}),
      ...(a.stream !== undefined ? { stream: a.stream } : {}),
      ...(a.onFailure !== undefined ? { on_failure: a.onFailure } : {}),
      models: a.models.map((m) => ({
        source_model_id: m.sourceModelId,
        ...(m.provider !== undefined ? { provider: m.provider } : {}),
        ...(m.targetModelId !== undefined ? { target_model_id: m.targetModelId } : {}),
        ...(m.model !== undefined ? { model: m.model } : {}),
        ...(m.channel !== undefined ? { channel: m.channel } : {}),
        ...(m.overrides && m.overrides.length > 0
          ? {
              overrides: m.overrides.map((r) => ({
                scope: r.scope,
                ...(r.when !== undefined ? { when: r.when } : {}),
                ...(r.body && r.body.length > 0
                  ? {
                      body: r.body.map((op) => ({
                        op: op.op,
                        path: op.path,
                        ...(op.value !== undefined ? { value: op.value } : {}),
                      })),
                    }
                  : {}),
                ...(r.headers && r.headers.length > 0
                  ? {
                      headers: r.headers.map((op) => ({
                        op: op.op,
                        name: op.name,
                        ...(op.value !== undefined ? { value: op.value } : {}),
                      })),
                    }
                  : {}),
              })),
            }
          : {}),
        ...(m.thinking?.budget_tokens
          ? { thinking: { budget_tokens: m.thinking.budget_tokens } }
          : {}),
        ...(m.thinking?.type && !m.thinking.budget_tokens
          ? { thinking: { type: m.thinking.type } }
          : {}),
        ...(m.thinking?.type && m.thinking.budget_tokens
          ? { thinking: { budget_tokens: m.thinking.budget_tokens, type: m.thinking.type } }
          : {}),
        ...(m.thinking?.reasoning_effort ? { reasoning_effort: m.thinking.reasoning_effort } : {}),
      })),
    })),
    proxy_key: config.proxyKey,
    vision: config.vision
      ? {
          provider: config.vision.provider,
          model: config.vision.model,
          ...(config.vision.prompt ? { prompt: config.vision.prompt } : {}),
        }
      : undefined,
    log_level: config.logLevel,
    locale: config.locale,
    port: config.port,
    capture_max_size: config.captureMaxSize,
  };
  return stringifyYaml(file);
};
