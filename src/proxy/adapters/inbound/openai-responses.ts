/**
 * OpenAI Responses API 入站适配器：Responses wire body → CanonicalRequest。
 *
 * 设计依据：docs/plans/2026-07-27-003-feat-p1-protocol-core-design.md §4 / §7.3.8。
 *
 * 覆盖形态：
 * - instructions → IR.system（顶层字符串）
 * - input：string（折叠为 user 消息）或 array（5 种 item 类型）
 *   - message: {role, content: string | blocks}（input_text/output_text/input_image/input_file/reasoning）
 *   - function_call: {call_id, name, arguments, namespace?} → IR tool_use
 *   - function_call_output: {call_id, output} → IR tool_result
 *   - computer_call_output: {call_id, output: {image_url|file_id}} → IR tool_result（含 image）
 *   - item_reference: 跨会话引用，无状态代理不支持，跳过
 *   - reasoning（顶层 / item）：转 IR reasoning 块
 * - tools：扁平 function + built-in（web_search / code_interpreter / file_search / computer）
 *   - **MCP 探测工具（list_mcp_/read_mcp_/write_mcp_/subscribe_mcp_）在入口剥离**
 * - tool_choice：'auto'|'none'|'required' | {type:'function', name}
 * - reasoning：{effort, summary} → ReasoningSpec
 *
 * 不变量（§7.3.8）：
 * - MCP 探测工具剥离仅在 Responses inbound 入口执行，不进入 IR 规范化阶段。
 * - input_image 三态（image_url string / image_url object / file_id）按优先级收敛。
 * - reasoning item 转 IR reasoning 块（可独立成块，亦可在 stream 中以 reasoning_summary 增量表达）。
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
} from '../../ir/types.ts';
import type { InboundAdapter, InboundContext, WireBody } from '../index.ts';
import {
  MCP_PROBE_PREFIXES,
  ensureToolInput,
  isMcpProbeTool,
  normalizeTool,
  normalizeToolChoice,
  parseInputImageSource,
} from './_shared.ts';

// --- zod schemas（wire 形态校验） ---

const REASONING_EFFORT_VALUES = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const REASONING_SUMMARY_VALUES = ['auto', 'concise', 'detailed'] as const;

const inputTextBlockSchema = z
  .object({ type: z.literal('input_text'), text: z.string() })
  .passthrough();

const outputTextBlockSchema = z
  .object({ type: z.literal('output_text'), text: z.string() })
  .passthrough();

const inputImageBlockSchema = z
  .object({
    type: z.literal('input_image'),
    image_url: z.union([z.string(), z.record(z.unknown())]).optional(),
    file_id: z.string().optional(),
    detail: z.enum(['auto', 'low', 'high']).optional(),
  })
  .passthrough();

const inputFileBlockSchema = z
  .object({ type: z.literal('input_file'), file_id: z.string().optional() })
  .passthrough();

const reasoningBlockSchema = z
  .object({
    type: z.literal('reasoning'),
    summary: z.array(z.record(z.unknown())).optional(),
    reasoning_text: z.string().optional(),
    id: z.string().optional(),
  })
  .passthrough();

const responsesContentBlockSchema = z.union([
  inputTextBlockSchema,
  outputTextBlockSchema,
  inputImageBlockSchema,
  inputFileBlockSchema,
  reasoningBlockSchema,
]);

const messageItemSchema = z
  .object({
    type: z.literal('message'),
    role: z.enum(['user', 'assistant', 'system', 'developer']),
    content: z.union([z.string(), z.array(responsesContentBlockSchema)]).optional(),
    status: z.string().optional(),
  })
  .passthrough();

const functionCallItemSchema = z
  .object({
    type: z.literal('function_call'),
    id: z.string().optional(),
    call_id: z.string(),
    name: z.string(),
    arguments: z.string().optional(),
    namespace: z.string().optional(),
  })
  .passthrough();

const functionCallOutputItemSchema = z
  .object({
    type: z.literal('function_call_output'),
    call_id: z.string(),
    output: z
      .union([z.string(), z.array(z.union([inputTextBlockSchema, outputTextBlockSchema, inputImageBlockSchema]))])
      .optional(),
  })
  .passthrough();

const computerCallOutputItemSchema = z
  .object({
    type: z.literal('computer_call_output'),
    call_id: z.string(),
    output: z
      .object({
        type: z.string().optional(),
        image_url: z.string().optional(),
        file_id: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const itemReferenceItemSchema = z
  .object({
    type: z.literal('item_reference'),
    id: z.string().optional(),
  })
  .passthrough();

const reasoningItemSchema = z
  .object({
    type: z.literal('reasoning'),
    id: z.string().optional(),
    summary: z.array(z.record(z.unknown())).optional(),
    reasoning_text: z.string().optional(),
  })
  .passthrough();

const inputItemSchema = z.union([
  messageItemSchema,
  functionCallItemSchema,
  functionCallOutputItemSchema,
  computerCallOutputItemSchema,
  itemReferenceItemSchema,
  reasoningItemSchema,
]);

const responsesToolSchema = z
  .object({
    type: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    parameters: z.record(z.unknown()).optional(),
    strict: z.boolean().optional(),
    display_width: z.number().optional(),
    display_height: z.number().optional(),
    display_number: z.number().optional(),
  })
  .passthrough();

const responsesToolChoiceSchema = z
  .union([
    z.enum(['auto', 'none', 'required']),
    z.object({ type: z.literal('function'), name: z.string() }).passthrough(),
  ])
  .optional();

const responsesReasoningSchema = z
  .object({
    effort: z.enum(REASONING_EFFORT_VALUES).optional(),
    summary: z.enum(REASONING_SUMMARY_VALUES).optional(),
  })
  .passthrough();

const responsesBodySchema = z
  .object({
    model: z.string().min(1),
    input: z.union([z.string(), z.array(inputItemSchema)]),
    instructions: z.string().optional(),
    tools: z.array(responsesToolSchema).optional(),
    tool_choice: responsesToolChoiceSchema,
    temperature: z.number().optional(),
    max_output_tokens: z.number().int().positive().optional(),
    max_tokens: z.number().int().positive().optional(),
    stream: z.boolean().optional(),
    top_p: z.number().optional(),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
    reasoning: responsesReasoningSchema.optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .passthrough();

export type ResponsesWireBody = z.infer<typeof responsesBodySchema>;
type ResponsesInputItem = z.infer<typeof inputItemSchema>;
type ResponsesContentBlock = z.infer<typeof responsesContentBlockSchema>;

// --- wire → IR 转换辅助 ---

/** Responses reasoning.summary 数组 → 拼接文本。非数组兜底 + 元素 text 字段提取 + 拼接。 */
const summarizeReasoningText = (summary: unknown): string => {
  if (!Array.isArray(summary)) return '';
  return summary
    .map((entry) =>
      entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).text === 'string'
        ? ((entry as Record<string, unknown>).text as string)
        : '',
    )
    .join('');
};

/** 解析单个 Responses content block 到 CanonicalBlock。 */
const parseContentBlock = (block: ResponsesContentBlock): CanonicalBlock | null => {
  switch (block.type) {
    case 'input_text':
    case 'output_text':
      return { kind: 'text', text: block.text };
    case 'input_image': {
      // ResponsesContentBlock 是 z.infer 后的窄类型，parseInputImageSource 接受
      // Record<string, unknown> 是为兼容其它协议 wire；此处把窄类型宽化以复用 helper。
      const source = parseInputImageSource(block as Record<string, unknown>);
      if (source) return { kind: 'image', source };
      return { kind: 'text', text: '[image]' };
    }
    case 'input_file':
      return { kind: 'text', text: '[file]' };
    case 'reasoning': {
      const text = summarizeReasoningText(block.summary) || block.reasoning_text || '';
      return { kind: 'reasoning', text, ...(block.id ? { id: block.id } : {}) };
    }
    default:
      return null;
  }
};

/** 解析 message item 的 content（字符串或 blocks）到 CanonicalBlock[]。 */
const parseMessageContent = (content: string | ResponsesContentBlock[] | undefined): CanonicalBlock[] => {
  if (content === undefined) return [];
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

/**
 * Responses namespace 展平：`namespace` + `name` → `${namespace}${name}` 或 `${namespace}__${name}`。
 * 与 legacy `transformInboundRequest` 的展平规则一致（CCX 兼容）。
 */
const flattenNamespace = (name: string, namespace: string): string =>
  namespace.endsWith('__') ? `${namespace}${name}` : `${namespace}__${name}`;

/** 解析 function_call 的最终工具名（含 namespace 展平）。 */
const resolveFunctionCallName = (rawName: string, namespace: string | undefined): string =>
  namespace ? flattenNamespace(rawName, namespace) : rawName;

/** 解析 Responses function_call arguments 字符串到对象。失败时降级为空对象。 */
const parseArguments = (args: string | undefined): Record<string, unknown> => {
  if (!args) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    // JSON 解析失败：LLM 偶发非 JSON；保留降级以便下游可观察到原始字符串（raw 中）
    return {};
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return {};
};

/** 解析顶层/独立 reasoning item 的 summary 数组到字符串。 */
const parseReasoningItemText = (item: { summary?: unknown; reasoning_text?: string }): string =>
  summarizeReasoningText(item.summary) || item.reasoning_text || '';

/**
 * 把 blocks 合并到上一条 assistant 消息（若存在），否则新建 assistant。
 * Responses 的 function_call / reasoning / computer_call 都需要这个模式。
 */
const appendToLastAssistant = (
  messages: CanonicalMessage[],
  blocks: CanonicalBlock[],
): void => {
  const last = messages[messages.length - 1];
  if (last && last.role === 'assistant') {
    last.blocks.push(...blocks);
    return;
  }
  messages.push({ role: 'assistant', blocks });
};

// --- 5 种 item type 的解析子步骤 ---

const parseMessageItem = (item: Extract<ResponsesInputItem, { type: 'message' }>): CanonicalMessage => ({
  role: item.role,
  blocks: parseMessageContent(item.content),
});

const parseFunctionCallItem = (
  item: Extract<ResponsesInputItem, { type: 'function_call' }>,
): CanonicalBlock[] => {
  const id = item.call_id || item.id || '';
  if (!id) {
    throw new Error(
      `openai-responses.inbound: function_call 缺 call_id/id（name=${JSON.stringify(item.name)}）`,
    );
  }
  return [
    {
      kind: 'tool_use',
      id,
      name: resolveFunctionCallName(item.name, item.namespace),
      input: ensureToolInput(parseArguments(item.arguments)),
    },
  ];
};

const parseFunctionCallOutputItem = (
  item: Extract<ResponsesInputItem, { type: 'function_call_output' }>,
): CanonicalMessage => {
  const toolUseId = item.call_id;
  let resultContent: CanonicalBlock[] | string = '';
  const output = item.output;
  if (typeof output === 'string') {
    resultContent = output;
  } else if (Array.isArray(output)) {
    const blocks: CanonicalBlock[] = [];
    for (const raw of output) {
      const block = parseContentBlock(raw);
      if (block) blocks.push(block);
    }
    resultContent = blocks;
  }
  return {
    role: 'tool',
    blocks: [{ kind: 'tool_result', toolUseId, content: resultContent }],
  };
};

const parseComputerCallOutputItem = (
  item: Extract<ResponsesInputItem, { type: 'computer_call_output' }>,
): CanonicalMessage => {
  const toolUseId = item.call_id;
  const output = item.output;
  let resultContent: CanonicalBlock[] | string;
  if (output?.image_url) {
    resultContent = [{ kind: 'image', source: { kind: 'url', url: output.image_url } }];
  } else if (output?.file_id) {
    resultContent = [{ kind: 'text', text: '[screenshot from file_id]' }];
  } else {
    resultContent = '';
  }
  return {
    role: 'tool',
    blocks: [{ kind: 'tool_result', toolUseId, content: resultContent }],
  };
};

const parseReasoningItem = (
  item: Extract<ResponsesInputItem, { type: 'reasoning' }>,
): CanonicalBlock | null => {
  const text = parseReasoningItemText(item);
  if (!text) return null;
  return { kind: 'reasoning', text, ...(item.id ? { id: item.id } : {}) };
};

// --- dispatch：5 种 item type 分发到子步骤 ---

/**
 * 转换 Responses input array 到 IR messages。
 *
 * item type 分发：
 * - message → 独立 CanonicalMessage
 * - function_call → tool_use 块，合并到上一条 assistant
 * - function_call_output → tool role 消息 + tool_result 块（canonicalize 会改为 user）
 * - computer_call_output → tool role 消息 + tool_result（含 image）
 * - item_reference → 跳过（跨会话引用，无状态代理不支持）
 * - reasoning（独立 item）→ reasoning 块，合并到上一条 assistant
 *
 * 未知 item type 跳过（Responses 协议可能扩展，保留向后兼容）。
 */
const convertInputArray = (input: ResponsesInputItem[]): CanonicalMessage[] => {
  const messages: CanonicalMessage[] = [];
  for (const item of input) {
    switch (item.type) {
      case 'message':
        messages.push(parseMessageItem(item));
        break;
      case 'function_call':
        appendToLastAssistant(messages, parseFunctionCallItem(item));
        break;
      case 'function_call_output':
        messages.push(parseFunctionCallOutputItem(item));
        break;
      case 'computer_call_output':
        messages.push(parseComputerCallOutputItem(item));
        break;
      case 'item_reference':
        // 跨会话引用，无状态代理不支持，跳过
        break;
      case 'reasoning': {
        const block = parseReasoningItem(item);
        if (block) appendToLastAssistant(messages, [block]);
        break;
      }
      default:
        // 未知 item type 跳过（保留向后兼容）
        break;
    }
  }
  return messages;
};

/** 解析 Responses top-level `reasoning: { effort, summary }` 到 ReasoningSpec。 */
const parseReasoning = (reasoning: ResponsesWireBody['reasoning']): ReasoningSpec | undefined => {
  if (!reasoning) return undefined;
  const spec: ReasoningSpec = { source: 'client' };
  if (reasoning.effort) {
    const effort: ReasoningEffort = reasoning.effort;
    spec.enabled = true;
    spec.effort = effort;
    spec.clientEffort = effort;
  }
  if (reasoning.summary) {
    spec.summary = reasoning.summary;
  }
  return spec;
};

/** 解析 Responses generation params 到 GenerationSpec。 */
const parseGeneration = (body: ResponsesWireBody): GenerationSpec => ({
  maxTokens: body.max_output_tokens ?? body.max_tokens,
  temperature: body.temperature,
  topP: body.top_p,
  stopSequences: typeof body.stop === 'string' ? [body.stop] : body.stop,
  // stream 默认 false（wire 未声明）；下游 pipeline 应用 RouteDecision.streamPolicy
  stream: body.stream === true,
});

/**
 * 过滤 MCP 探测工具（Responses 入口剥离点）。
 *
 * 剥离规则（与 legacy transformInboundRequest 一致）：
 * - 工具名（顶层 name 或 nested function.name）以 list_mcp_/read_mcp_/write_mcp_/subscribe_mcp_ 前缀开头
 * - 这些工具是 Codex 为 Responses API server-side MCP handling 注入的探测函数，
 *   非 Responses 上游会触发错误的 MCP server call
 * - 命名空间 MCP 工具（mcp__xxx__yyy）不被剥离，保留走 namespace 展平逻辑
 */
const stripMcpProbeTools = (
  tools: ReadonlyArray<z.infer<typeof responsesToolSchema>>,
): Array<z.infer<typeof responsesToolSchema>> => tools.filter((tool) => !isMcpProbeTool(tool));

/**
 * 把 input（string 或 array）归一到 CanonicalMessage[]。
 * 字符串：折叠为单条 user 消息；数组：分发到 convertInputArray。
 */
const convertInput = (input: ResponsesWireBody['input']): CanonicalMessage[] => {
  if (typeof input === 'string') {
    return input ? [{ role: 'user', blocks: [{ kind: 'text', text: input }] }] : [];
  }
  if (Array.isArray(input)) {
    return convertInputArray(input);
  }
  return [];
};

// --- InboundAdapter 实现 ---

export const openaiResponsesInboundAdapter: InboundAdapter = {
  name: 'openai-responses',
  canHandle(ctx: InboundContext): boolean {
    return ctx.clientProtocol === 'openai-responses';
  },
  decode(body: WireBody, ctx: InboundContext): CanonicalRequest {
    const parsed = responsesBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new Error(
        `openai-responses.inbound [clientProtocol=openai-responses]: wire body 校验失败: ${parsed.error.issues
          .map((i) => i.path.join('.') || '<root>')
          .join(', ')}`,
      );
    }
    const data = parsed.data;

    const messages = convertInput(data.input);
    // **MCP 探测工具剥离：仅在 Responses inbound 入口执行（§7.3.8）**
    const rawTools = data.tools ? stripMcpProbeTools(data.tools) : undefined;
    const tools: CanonicalTool[] | undefined = rawTools?.map((t) => normalizeTool(t));
    const toolChoice = data.tool_choice ? normalizeToolChoice(data.tool_choice) : undefined;
    const reasoning = parseReasoning(data.reasoning);
    const metadata = data.metadata;

    return {
      clientProtocol: 'openai-responses',
      logicalModel: data.model,
      messages,
      ...(data.instructions ? { system: data.instructions } : {}),
      ...(tools ? { tools } : {}),
      ...(toolChoice ? { toolChoice } : {}),
      generation: parseGeneration(data),
      ...(reasoning ? { reasoning } : {}),
      ...(metadata ? { metadata } : {}),
    };
  },
};

// 公开 MCP 探测前缀供测试或文档使用
export { MCP_PROBE_PREFIXES };