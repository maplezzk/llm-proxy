/**
 * Anthropic 入站适配器：Anthropic Messages API wire body → CanonicalRequest。
 *
 * 设计依据：docs/plans/2026-07-27-003-feat-p1-protocol-core-design.md §4 / §7.3。
 *
 * 覆盖形态：
 * - system: string | SystemBlock[]（多 block，cache_control 透传）
 * - messages: user/assistant 两种 role；content 可为 string 或 content blocks 数组
 * - content blocks: text / thinking（含 signature）/ redacted_thinking / tool_use / tool_result / image（source 两种：url/base64）
 * - tools: function（{name, description, input_schema}）/ built-in（computer_20251124 等）
 * - tool_choice: {type:'auto'|'any'|'tool'|'none'} 或 {type:'tool', name}
 * - thinking: {type, budget_tokens} → ReasoningSpec
 *
 * 不变量：
 * - thinking 签名保留到 IR thinking.signature，由 canonicalize.ts 显式化 signatureSource。
 * - assistant 的 tool_use.input 直接透传（Anthropic 本就是 JSON 对象）。
 * - tool_result.content 为 string 或 content blocks 数组，归一到 CanonicalBlock[] | string。
 *
 * 实现说明：zod 校验 wire body 结构，不信任 wire 数据。校验失败抛 Error，
 * 由 pipeline 统一转 400 响应。
 *
 * 导出约定：`AnthropicWireBody` 类型对外暴露，便于其他适配器引用并保持 schema 推断一致；
 * `anthropicInboundAdapter` 是本模块唯一公开的 InboundAdapter 实例。
 */

import { z } from 'zod';

import type {
  CanonicalBlock,
  CanonicalMessage,
  CanonicalRequest,
  CanonicalTool,
  GenerationSpec,
  ReasoningSpec,
  SystemBlock,
} from '../../ir/types.ts';
import type { InboundAdapter, InboundContext, WireBody } from '../index.ts';
import {
  ensureToolInput,
  normalizeTool,
  normalizeToolChoice,
  parseImageSource,
  parseToolResultContent,
} from './_shared.ts';

// --- zod schemas（wire 形态校验） ---

/** Anthropic image block（Anthropic source 三形态中的两种：url/base64）。 */
const imageSourceSchema = z
  .object({
    type: z.enum(['url', 'base64']),
    url: z.string().optional(),
    media_type: z.string().optional(),
    data: z.string().optional(),
  })
  .passthrough();

const textBlockSchema = z
  .object({ type: z.literal('text'), text: z.string(), cache_control: z.unknown().optional() })
  .passthrough();

const thinkingBlockSchema = z
  .object({
    type: z.literal('thinking'),
    thinking: z.string(),
    signature: z.string().optional(),
  })
  .passthrough();

const redactedThinkingBlockSchema = z
  .object({ type: z.literal('redacted_thinking'), data: z.string().optional() })
  .passthrough();

const toolUseBlockSchema = z
  .object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.record(z.unknown()),
  })
  .passthrough();

const toolResultBlockSchema = z
  .object({
    type: z.literal('tool_result'),
    tool_use_id: z.string(),
    content: z.union([z.string(), z.array(z.record(z.unknown()))]),
    is_error: z.boolean().optional(),
    cache_control: z.unknown().optional(),
  })
  .passthrough();

const imageBlockSchema = z
  .object({ type: z.literal('image'), source: imageSourceSchema })
  .passthrough();

const anthropicContentBlockSchema = z.union([
  textBlockSchema,
  thinkingBlockSchema,
  redactedThinkingBlockSchema,
  toolUseBlockSchema,
  toolResultBlockSchema,
  imageBlockSchema,
]);

/** System 可为字符串或多 block 数组（含 text/image）。 */
const systemBlockSchema = z.union([
  z
    .object({
      type: z.literal('text'),
      text: z.string(),
      cache_control: z.unknown().optional(),
    })
    .passthrough(),
  z.object({ type: z.literal('image'), source: imageSourceSchema }).passthrough(),
]);

const anthropicToolSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    input_schema: z.record(z.unknown()).optional(),
    type: z.string().optional(),
    display_width_px: z.number().optional(),
    display_height_px: z.number().optional(),
    display_number: z.number().optional(),
  })
  .passthrough();

const anthropicToolChoiceSchema = z.union([
  z.object({ type: z.enum(['auto', 'any', 'none']) }).passthrough(),
  z.object({ type: z.literal('tool'), name: z.string() }).passthrough(),
]);

const anthropicThinkingSchema = z
  .object({
    type: z.enum(['enabled', 'disabled', 'adaptive']).optional(),
    budget_tokens: z.number().int().positive().optional(),
  })
  .passthrough();

const anthropicMessageSchema = z
  .object({
    role: z.enum(['user', 'assistant']),
    content: z.union([z.string(), z.array(anthropicContentBlockSchema)]),
  })
  .passthrough();

const anthropicBodySchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(anthropicMessageSchema).min(1),
    system: z.union([z.string(), z.array(systemBlockSchema)]).optional(),
    tools: z.array(anthropicToolSchema).optional(),
    tool_choice: anthropicToolChoiceSchema.optional(),
    temperature: z.number().optional(),
    max_tokens: z.number().int().positive().optional(),
    stream: z.boolean().optional(),
    top_p: z.number().optional(),
    stop_sequences: z.array(z.string()).optional(),
    thinking: anthropicThinkingSchema.optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .passthrough();

export type AnthropicWireBody = z.infer<typeof anthropicBodySchema>;

/** cacheControl 类型守卫：仅含 type 为字符串的对象才被接受为 CacheControl。 */
const isCacheControl = (value: unknown): value is { type: string; [k: string]: unknown } =>
  value !== null &&
  typeof value === 'object' &&
  typeof (value as Record<string, unknown>).type === 'string';

// --- wire → IR 转换辅助 ---

/** 解析单个 Anthropic content block 到 CanonicalBlock。未知 block 形态返回 null。 */
const parseContentBlock = (block: Record<string, unknown>): CanonicalBlock | null => {
  const type = typeof block.type === 'string' ? block.type : '';
  if (type === 'text') {
    return { kind: 'text', text: typeof block.text === 'string' ? block.text : '' };
  }
  if (type === 'thinking') {
    const signature = typeof block.signature === 'string' ? block.signature : undefined;
    return {
      kind: 'thinking',
      text: typeof block.thinking === 'string' ? block.thinking : '',
      signature,
      // signatureSource 由 canonicalize.ts 统一显式化（'original'|'generated'|'none'）
    };
  }
  if (type === 'redacted_thinking') {
    // Anthropic redacted thinking：保留为 thinking 块，标记 redacted=true，签名视为 'none'
    return {
      kind: 'thinking',
      text: typeof block.data === 'string' ? block.data : '',
      signatureSource: 'none',
      redacted: true,
    };
  }
  if (type === 'tool_use') {
    // zod 已保证 id/name/input 存在；此处 typeof 守卫仅为类型窄化（形参为 Record<string, unknown>）。
    // 若守卫失败说明 schema 与 helper 假设不一致，应视为协议错误抛错而非静默丢弃。
    if (typeof block.id !== 'string' || typeof block.name !== 'string') {
      throw new Error(
        `anthropic.inbound: tool_use block 缺 id/name（已通过 zod 校验但 helper 收到异常输入）`,
      );
    }
    const input = ensureToolInput(block.input);
    return {
      kind: 'tool_use',
      id: block.id,
      name: block.name,
      input,
    };
  }
  if (type === 'tool_result') {
    if (typeof block.tool_use_id !== 'string') return null;
    const toolUseId = block.tool_use_id;
    try {
      const content = parseToolResultContent(block.content, (raw) => parseContentBlock(raw));
      return {
        kind: 'tool_result',
        toolUseId,
        content,
        ...(typeof block.is_error === 'boolean' ? { isError: block.is_error } : {}),
      };
    } catch (err) {
      throw new Error(
        `anthropic.inbound: tool_result (tool_use_id=${toolUseId}) content 解析失败: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  if (type === 'image') {
    const source = parseImageSource(block.source as Record<string, unknown> | undefined);
    if (source) return { kind: 'image', source };
    return { kind: 'text', text: '[image]' };
  }
  // 未知 block：丢弃（Anthropic 协议可能新增 block 类型，保留向后兼容）
  return null;
};

/** 解析 message content（string 或 blocks 数组）到 CanonicalBlock[]。 */
const parseMessageContent = (
  content: string | Array<Record<string, unknown>>,
): CanonicalBlock[] => {
  if (typeof content === 'string') {
    return content ? [{ kind: 'text', text: content }] : [];
  }
  const blocks: CanonicalBlock[] = [];
  for (const raw of content) {
    const block = parseContentBlock(raw);
    if (block) blocks.push(block);
  }
  return blocks;
};

/** 解析单条 system block 数组元素到 SystemBlock。 */
const parseSystemBlock = (raw: Record<string, unknown>): SystemBlock | null => {
  const type = typeof raw.type === 'string' ? raw.type : '';
  if (type === 'text') {
    return {
      kind: 'text',
      text: typeof raw.text === 'string' ? raw.text : '',
      ...(isCacheControl(raw.cache_control) ? { cacheControl: raw.cache_control } : {}),
    };
  }
  if (type === 'image') {
    const source = parseImageSource(raw.source as Record<string, unknown> | undefined);
    if (source) return { kind: 'image', source };
  }
  return null;
};

/** 解析 system 字段到 IR `string | SystemBlock[]`。 */
const parseSystem = (system: unknown): string | SystemBlock[] | undefined => {
  if (system === undefined || system === null) return undefined;
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    const blocks: SystemBlock[] = [];
    for (const raw of system as Array<Record<string, unknown>>) {
      const block = parseSystemBlock(raw);
      if (block) blocks.push(block);
    }
    return blocks;
  }
  return undefined;
};

/** 解析 Anthropic top-level `thinking` 到 ReasoningSpec。Anthropic 用 budget_tokens，不带 effort。 */
const parseReasoning = (thinking: AnthropicWireBody['thinking']): ReasoningSpec | undefined => {
  if (!thinking) return undefined;
  const spec: ReasoningSpec = { source: 'client' };
  if (thinking.type === 'enabled') {
    spec.enabled = true;
    spec.type = 'enabled';
  } else if (thinking.type === 'disabled') {
    spec.enabled = false;
    spec.type = 'disabled';
  } else if (thinking.type === 'adaptive') {
    spec.type = 'adaptive';
  }
  if (typeof thinking.budget_tokens === 'number') {
    spec.budgetTokens = thinking.budget_tokens;
  }
  return spec;
};

/** 解析 Anthropic generation params 到 GenerationSpec。 */
const parseGeneration = (body: AnthropicWireBody): GenerationSpec => ({
  maxTokens: body.max_tokens,
  temperature: body.temperature,
  topP: body.top_p,
  stopSequences: body.stop_sequences,
  // stream 默认 false（wire 未声明）；下游 pipeline 应用 RouteDecision.streamPolicy
  stream: body.stream === true,
});

// --- InboundAdapter 实现 ---

export const anthropicInboundAdapter: InboundAdapter = {
  name: 'anthropic',
  canHandle(ctx: InboundContext): boolean {
    return ctx.clientProtocol === 'anthropic';
  },
  decode(body: WireBody, ctx: InboundContext): CanonicalRequest {
    const parsed = anthropicBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new Error(
        `anthropic.inbound: wire body 校验失败: ${parsed.error.issues.map((i) => i.path.join('.') || '<root>').join(', ')}`,
      );
    }
    const data = parsed.data;

    // content 已在 schema 校验为 `string | z.infer<union>`，联合类型直接传入 parseMessageContent。
    // parseMessageContent 的形参类型是 `string | Array<Record<string, unknown>>`，
    // 调用方把窄类型转宽类型以适配 helper（helper 内部仅按 typeof 与字符串字段守卫取值，
    // 不依赖形参为窄类型来保证正确性）。
    const messages: CanonicalMessage[] = data.messages.map((m) => ({
      role: m.role,
      blocks: parseMessageContent(m.content as string | Array<Record<string, unknown>>),
    }));

    const tools: CanonicalTool[] | undefined = data.tools?.map((t) => normalizeTool(t));
    const toolChoice = data.tool_choice
      ? normalizeToolChoice(data.tool_choice as unknown)
      : undefined;
    const system = parseSystem(data.system);
    const reasoning = parseReasoning(data.thinking);

    // metadata：zod schema 定义为 record(z.unknown())，traceId/requestId 由下游消费方按需收窄。
    // 此处保持原状透传，不强制类型断言以免丢失其它元数据字段。
    const metadata = data.metadata;

    return {
      clientProtocol: 'anthropic',
      logicalModel: data.model,
      messages,
      ...(system !== undefined ? { system } : {}),
      ...(tools ? { tools } : {}),
      ...(toolChoice ? { toolChoice } : {}),
      generation: parseGeneration(data),
      ...(reasoning ? { reasoning } : {}),
      ...(metadata ? { metadata } : {}),
    };
  },
};

// decode 签名保留 ctx 形参以备未来 trace id 提取（与 InboundAdapter 接口契约对齐），
// 当前 Anthropic 入站无需读取 ctx；InboundContext 的 unused 警告由调用方通过参数名前缀下划线规避。