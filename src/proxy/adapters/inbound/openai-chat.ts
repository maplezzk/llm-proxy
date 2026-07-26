/**
 * OpenAI Chat Completions 入站适配器：Chat wire body → CanonicalRequest。
 *
 * 设计依据：docs/plans/2026-07-27-003-feat-p1-protocol-core-design.md §4 / §7.3。
 *
 * 覆盖形态：
 * - messages: system / user / assistant / developer / tool 五种 role
 *   - system: 首条 system 消息抽出到 IR.system（可为 string 或 content blocks 数组）
 *   - user: content 可为 string 或 image_url/text 块数组
 *   - assistant: 含 reasoning_content / reasoning_signature / tool_calls（OpenAI 推理扩展）
 *   - tool: {tool_call_id, content} → IR tool 消息（canonicalize 会把 role 'tool' 改为 'user'）
 *   - developer: 透传为 IR developer role（IR 允许）
 * - tools: `{ type: 'function', function: { name, description?, parameters } }`
 * - tool_choice: 'auto' | 'none' | 'required' | {type:'function', function:{name}}
 * - reasoning_effort: 顶层字符串 → ReasoningSpec（source='client', clientEffort 保留）
 *
 * 不变量：
 * - assistant 的 reasoning_content 转 IR thinking 块；reasoning_signature 保留为 signature。
 * - assistant 的 tool_calls 转 IR tool_use 块；多个连续 tool_calls 在同一 assistant 内成多 block。
 * - tool 消息的 content 转 IR tool_result 块（含 image_url → image 转换）。
 * - 连续 tool role 合并：canonicalize.ts 负责 IR 层 mergeConsecutiveMessages。
 *
 * 实现说明：zod 校验 wire body 结构，不信任 wire 数据。校验失败抛 Error。
 */

import { z } from 'zod';

import type {
  CanonicalBlock,
  CanonicalMessage,
  CanonicalRequest,
  CanonicalTool,
  GenerationSpec,
  ReasoningEffort,
  ReasoningSpec,
  SystemBlock,
} from '../../ir/types.ts';
import type { InboundAdapter, InboundContext, WireBody } from '../index.ts';
import {
  ensureToolInput,
  normalizeTool,
  normalizeToolChoice,
  parseImageUrlSource,
} from './_shared.ts';

// --- zod schemas（wire 形态校验） ---

const REASONING_EFFORT_VALUES = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

const textContentBlockSchema = z
  .object({ type: z.literal('text'), text: z.string() })
  .passthrough();

const imageUrlBlockSchema = z
  .object({
    type: z.literal('image_url'),
    image_url: z.union([z.string(), z.record(z.unknown())]),
  })
  .passthrough();

const chatContentBlockSchema = z.union([textContentBlockSchema, imageUrlBlockSchema]);

const chatToolCallSchema = z
  .object({
    id: z.string(),
    type: z.literal('function').optional(),
    function: z.object({
      name: z.string(),
      arguments: z.string().optional(),
    }),
  })
  .passthrough();

const chatToolSchema = z
  .object({
    type: z.literal('function'),
    function: z.object({
      name: z.string(),
      description: z.string().optional(),
      parameters: z.record(z.unknown()).optional(),
    }),
  })
  .passthrough();

const chatToolChoiceSchema = z
  .union([
    z.enum(['auto', 'none', 'required']),
    z
      .object({ type: z.literal('function'), function: z.object({ name: z.string() }) })
      .passthrough(),
  ])
  .optional();

const chatMessageSchema = z
  .object({
    role: z.enum(['system', 'user', 'assistant', 'developer', 'tool']),
    // Chat 允许 assistant 消息 content 为 null（tool_calls 场景）或省略
    content: z
      .union([z.string(), z.array(chatContentBlockSchema), z.null()])
      .optional(),
    // assistant 扩展
    reasoning_content: z.string().optional(),
    reasoning_signature: z.string().optional(),
    tool_calls: z.array(chatToolCallSchema).optional(),
    // tool 消息
    tool_call_id: z.string().optional(),
    // 名字（兼容部分 SDK）
    name: z.string().optional(),
  })
  .passthrough();

const chatBodySchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(chatMessageSchema).min(1),
    tools: z.array(chatToolSchema).optional(),
    tool_choice: chatToolChoiceSchema,
    temperature: z.number().optional(),
    max_tokens: z.number().int().positive().optional(),
    stream: z.boolean().optional(),
    top_p: z.number().optional(),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
    reasoning_effort: z.enum(REASONING_EFFORT_VALUES).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .passthrough();

export type ChatWireBody = z.infer<typeof chatBodySchema>;

// --- wire → IR 转换辅助 ---

/** 解析单个 Chat content block 到 CanonicalBlock。 */
const parseContentBlock = (block: Record<string, unknown>): CanonicalBlock | null => {
  const type = typeof block.type === 'string' ? block.type : '';
  if (type === 'text') {
    return { kind: 'text', text: typeof block.text === 'string' ? block.text : '' };
  }
  if (type === 'image_url') {
    const source = parseImageUrlSource(block.image_url);
    if (source) return { kind: 'image', source };
    return { kind: 'text', text: '[image]' };
  }
  return null;
};

/** 解析 content（字符串或 blocks 数组）到 CanonicalBlock[]。 */
const parseMessageContent = (
  content: string | Array<Record<string, unknown>> | null | undefined,
): CanonicalBlock[] => {
  if (content === undefined || content === null) return [];
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

/** 解析 Chat system 消息内容（字符串或 blocks）到 IR `string | SystemBlock[]`。
 * Chat system 的 array 形态与 message content 共用 chatContentBlockSchema，故复用 parseContentBlock
 * 后仅保留 text/image 形态（SystemBlock 仅允许这两种）。
 */
const parseSystemContent = (
  content: string | Array<Record<string, unknown>> | null | undefined,
): string | SystemBlock[] => {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  const blocks: SystemBlock[] = [];
  for (const raw of content) {
    const irBlock = parseContentBlock(raw);
    if (irBlock && (irBlock.kind === 'text' || irBlock.kind === 'image')) {
      blocks.push(irBlock);
    }
  }
  return blocks;
};

/**
 * 解析 Chat assistant 消息到 CanonicalMessage。
 *
 * 处理：
 * - reasoning_content → thinking 块（含 reasoning_signature）
 * - tool_calls → tool_use 块（每个 call 一个 block，arguments JSON 字符串解析为对象）
 *
 * 顺序：thinking（若有）→ text（若有）→ tool_use（按 call 顺序）
 */
const parseAssistantMessage = (msg: ChatWireBody['messages'][number]): CanonicalMessage => {
  const reasoning = typeof msg.reasoning_content === 'string' ? msg.reasoning_content : undefined;
  const signature =
    typeof msg.reasoning_signature === 'string' ? msg.reasoning_signature : undefined;
  const blocks: CanonicalBlock[] = [];

  // thinking 在前（如果存在）
  if (reasoning) {
    blocks.push({
      kind: 'thinking',
      text: reasoning,
      signature,
      // signatureSource 由 canonicalize.ts 统一显式化
    });
  }

  // text content（string 或 blocks 数组）
  blocks.push(...parseMessageContent(msg.content));

  // tool_calls → tool_use 块
  if (msg.tool_calls && msg.tool_calls.length > 0) {
    for (const tc of msg.tool_calls) {
      const args = typeof tc.function.arguments === 'string' ? tc.function.arguments : '';
      let input: Record<string, unknown> = {};
      if (args) {
        try {
          const parsed = JSON.parse(args);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            input = parsed as Record<string, unknown>;
          }
        } catch {
          // arguments 解析失败：保留为空对象，不抛错（LLM 偶发输出非 JSON 时降级）
          input = {};
        }
      }
      blocks.push({
        kind: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: ensureToolInput(input),
      });
    }
  }

  return { role: 'assistant', blocks };
};

/**
 * 解析 Chat tool 消息到 CanonicalMessage（role='tool'，canonicalize 会合并为 user）。
 *
 * content 是 string 或 array：
 * - string → 直接作为 tool_result.content 字符串
 * - array → 每个 block 转 IR CanonicalBlock
 */
const parseToolMessage = (msg: ChatWireBody['messages'][number]): CanonicalMessage => {
  if (typeof msg.tool_call_id !== 'string' || !msg.tool_call_id) {
    throw new Error(
      `openai-chat.inbound: tool 消息缺 tool_call_id（content=${JSON.stringify(msg.content ?? null).slice(0, 200)}）`,
    );
  }
  const toolUseId = msg.tool_call_id;
  const content = msg.content;
  let resultContent: CanonicalBlock[] | string;
  if (typeof content === 'string') {
    resultContent = content;
  } else if (Array.isArray(content)) {
    const blocks: CanonicalBlock[] = [];
    for (const raw of content as Array<Record<string, unknown>>) {
      const block = parseContentBlock(raw);
      if (block) blocks.push(block);
    }
    resultContent = blocks;
  } else {
    // undefined / null / 其它 → 视为空字符串
    resultContent = '';
  }
  return {
    role: 'tool',
    blocks: [
      {
        kind: 'tool_result',
        toolUseId,
        content: resultContent,
      },
    ],
  };
};

/** 解析 Chat `reasoning_effort` 字符串到 ReasoningSpec。 */
const parseReasoning = (
  effort: (typeof REASONING_EFFORT_VALUES)[number] | undefined,
): ReasoningSpec | undefined => {
  if (!effort) return undefined;
  const effortValue: ReasoningEffort = effort;
  return {
    enabled: true,
    effort: effortValue,
    source: 'client',
    clientEffort: effortValue,
  };
};

/** 解析 Chat generation params 到 GenerationSpec。 */
const parseGeneration = (body: ChatWireBody): GenerationSpec => ({
  maxTokens: body.max_tokens,
  temperature: body.temperature,
  topP: body.top_p,
  stopSequences: typeof body.stop === 'string' ? [body.stop] : body.stop,
  // stream 默认 false（wire 未声明）；下游 pipeline 应用 RouteDecision.streamPolicy
  stream: body.stream === true,
});

/**
 * 抽取所有 Chat messages 到 IR messages + system。
 *
 * 规则：
 * - 首条 system role 抽出到 system 字段（剩余不再视为 system）。
 * - assistant / tool 走专用 parser。
 * - 其它 role（user / developer）走通用 content parser，name 字段透传。
 */
const extractMessagesAndSystem = (
  rawMessages: ChatWireBody['messages'],
): { messages: CanonicalMessage[]; system: string | SystemBlock[] | undefined } => {
  const messages: CanonicalMessage[] = [];
  let system: string | SystemBlock[] | undefined;
  let systemExtracted = false;
  for (const msg of rawMessages) {
    if (msg.role === 'system' && !systemExtracted) {
      system = parseSystemContent(msg.content);
      systemExtracted = true;
      continue;
    }
    if (msg.role === 'tool') {
      messages.push(parseToolMessage(msg));
      continue;
    }
    if (msg.role === 'assistant') {
      messages.push(parseAssistantMessage(msg));
      continue;
    }
    // user / developer
    const irMsg: CanonicalMessage = {
      role: msg.role,
      blocks: parseMessageContent(msg.content),
    };
    if (typeof msg.name === 'string') irMsg.name = msg.name;
    messages.push(irMsg);
  }
  return { messages, system };
};

// --- InboundAdapter 实现 ---

export const openaiChatInboundAdapter: InboundAdapter = {
  name: 'openai',
  canHandle(ctx: InboundContext): boolean {
    return ctx.clientProtocol === 'openai';
  },
  decode(body: WireBody, ctx: InboundContext): CanonicalRequest {
    const parsed = chatBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new Error(
        `openai-chat.inbound: wire body 校验失败: ${parsed.error.issues.map((i) => i.path.join('.') || '<root>').join(', ')}`,
      );
    }
    const data = parsed.data;

    const { messages, system } = extractMessagesAndSystem(data.messages);
    const tools: CanonicalTool[] | undefined = data.tools?.map((t) => normalizeTool(t));
    const toolChoice = data.tool_choice ? normalizeToolChoice(data.tool_choice) : undefined;
    const reasoning = parseReasoning(data.reasoning_effort);
    const metadata = data.metadata;

    return {
      clientProtocol: 'openai',
      logicalModel: data.model,
      messages,
      ...(system !== undefined && system !== '' ? { system } : {}),
      ...(tools ? { tools } : {}),
      ...(toolChoice ? { toolChoice } : {}),
      generation: parseGeneration(data),
      ...(reasoning ? { reasoning } : {}),
      ...(metadata ? { metadata } : {}),
    };
  },
};