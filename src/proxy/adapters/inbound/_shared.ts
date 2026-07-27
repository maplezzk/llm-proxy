/**
 * 入站适配器共享工具：image 三态归一、tool 归一、MCP 探测工具剥离、tool_choice 归一。
 *
 * 设计依据：docs/plans/2026-07-27-003-feat-p1-protocol-core-design.md §4 / §6 / §7.3.8。
 *
 * 关键约定：
 * - image 三态（url/base64/file_id）统一收敛为 IR ImageSource；file_id 由 caller 决定是否降级。
 * - 工具 kind 按 type 字段推断（function/computer/web_search/code_interpreter/file_search/mcp）。
 * - MCP 探测工具前缀（list_mcp_/read_mcp_/write_mcp_/subscribe_mcp_）剥离仅在 Responses inbound 入口执行。
 * - tool_choice 字符串与对象形态归一为 CanonicalToolChoice。
 *
 * 这些 helpers 是协议无关的 IR 形态归一；各协议的 wire 解析逻辑仍在各自 adapter 中实现。
 */

import type {
  CanonicalBlock,
  CanonicalTool,
  CanonicalToolChoice,
  ImageSource,
  ToolInput,
} from '../../ir/types.ts';

/** MCP 探测工具前缀（仅在 Responses inbound 入口剥离，IR 规范化阶段不剥离）。 */
export const MCP_PROBE_PREFIXES = [
  'list_mcp_',
  'read_mcp_',
  'write_mcp_',
  'subscribe_mcp_',
] as const satisfies readonly string[];

/** image detail 合法值（Chat / Responses 共用）。 */
const IMAGE_DETAIL_VALUES = ['auto', 'low', 'high'] as const;
type ImageDetail = (typeof IMAGE_DETAIL_VALUES)[number];

const isValidDetail = (value: unknown): value is ImageDetail =>
  typeof value === 'string' && (IMAGE_DETAIL_VALUES as readonly string[]).includes(value);

/** 构造 url 形态 ImageSource（带可选 detail 校验）。 */
const buildUrlSource = (url: string, detail: unknown): ImageSource =>
  isValidDetail(detail) ? { kind: 'url', url, detail } : { kind: 'url', url };

/** 构造 file_id 形态 ImageSource（带可选 detail 校验）。 */
const buildFileIdSource = (fileId: string, detail: unknown): ImageSource =>
  isValidDetail(detail) ? { kind: 'file_id', fileId, detail } : { kind: 'file_id', fileId };

/**
 * 判断工具是否为 Codex Responses 入口的 MCP 探测工具（应被剥离）。
 * 匹配规则：工具名（顶层 name 或 nested function.name）以 MCP_PROBE_PREFIXES 任一前缀开头（大小写无关，
 * 兼容 Codex 偶发的大写工具名如 READ_MCP_RESOURCE）。
 */
export const isMcpProbeTool = (tool: Record<string, unknown>): boolean => {
  const fn = tool.function as Record<string, unknown> | undefined;
  const name = String(tool.name ?? fn?.name ?? '').toLowerCase();
  return MCP_PROBE_PREFIXES.some((prefix) => name.startsWith(prefix));
};

/**
 * 解析 Anthropic / Responses 风格的 image block。
 * 形态：source = { type: 'url' | 'base64', url?, media_type?, data? }。
 * 对于 Anthropic，没有 file_id 形态（Anthropic 不引用 Files API）。
 */
export const parseImageSource = (source: Record<string, unknown> | undefined): ImageSource | null => {
  if (!source) return null;
  const type = String(source.type ?? '');
  if (type === 'url') {
    const url = String(source.url ?? '');
    if (!url) return null;
    return buildUrlSource(url, undefined);
  }
  if (type === 'base64') {
    const data = String(source.data ?? '');
    if (!data) return null;
    return {
      kind: 'base64',
      mediaType: String(source.media_type ?? 'image/png'),
      data,
    };
  }
  return null;
};

/**
 * 解析 Chat 风格的 image_url block。
 * 形态：image_url = string | { url: string, detail?: 'auto'|'low'|'high' }。
 */
export const parseImageUrlSource = (imageUrl: unknown): ImageSource | null => {
  if (typeof imageUrl === 'string') {
    return imageUrl ? buildUrlSource(imageUrl, undefined) : null;
  }
  if (imageUrl && typeof imageUrl === 'object') {
    const obj = imageUrl as Record<string, unknown>;
    const url = String(obj.url ?? '');
    if (!url) return null;
    return buildUrlSource(url, obj.detail);
  }
  return null;
};

/**
 * 解析 Responses 风格的 input_image block。
 * 形态：{ image_url: string | { url, detail? }, file_id?: string }。
 * 优先级：image_url > file_id（file_id 形态在 IR 中独立保留为 ImageSource）。
 */
export const parseInputImageSource = (block: Record<string, unknown>): ImageSource | null => {
  const rawImageUrl = block.image_url;
  const fileId = typeof block.file_id === 'string' ? block.file_id : undefined;
  if (rawImageUrl) {
    const url = parseImageUrlSource(rawImageUrl);
    if (url) return url;
  }
  if (fileId) return buildFileIdSource(fileId, block.detail);
  return null;
};

/**
 * 推断 Anthropic / Responses built-in computer 工具的 display 元数据。
 *
 * 优先级：`display_width_px` / `display_height_px`（Anthropic wire）优先于
 * `display_width` / `display_height`（Responses wire）；`display_number` 直读。
 */
const extractComputerMeta = (
  item: Record<string, unknown>,
): { displayWidth?: number; displayHeight?: number; displayNumber?: number } => {
  const meta: { displayWidth?: number; displayHeight?: number; displayNumber?: number } = {};
  const widthPx = item.display_width_px ?? item.display_width;
  const heightPx = item.display_height_px ?? item.display_height;
  if (typeof widthPx === 'number') meta.displayWidth = widthPx;
  if (typeof heightPx === 'number') meta.displayHeight = heightPx;
  if (typeof item.display_number === 'number') meta.displayNumber = item.display_number;
  return meta;
};

/** 解析工具名（多种 wire 形态的 name 抽取，fallback 到 type 字符串）。 */
const resolveToolName = (item: Record<string, unknown>, fallbackType: string): string => {
  if (typeof item.name === 'string' && item.name) return item.name;
  const fn = item.function as Record<string, unknown> | undefined;
  if (fn && typeof fn.name === 'string' && fn.name) return fn.name;
  return fallbackType || 'unknown';
};

// --- 工具形态归一子步骤（按 wire 形态拆分） ---

/** Chat 形态：`{ type: 'function', function: { name, description?, parameters } }`。 */
const normalizeChatFunctionTool = (item: Record<string, unknown>): CanonicalTool => {
  const fn = item.function as Record<string, unknown>;
  return {
    name: String(fn.name ?? ''),
    description: typeof fn.description === 'string' ? fn.description : undefined,
    schema: (fn.parameters as Record<string, unknown>) ?? {},
    kind: 'function',
    raw: item,
  };
};

/** Responses 扁平形态：`{ type: 'function', name, description?, parameters? }`。 */
const normalizeResponsesFunctionTool = (item: Record<string, unknown>): CanonicalTool => ({
  name: String(item.name ?? ''),
  description: typeof item.description === 'string' ? item.description : undefined,
  schema: (item.parameters as Record<string, unknown>) ?? {},
  kind: 'function',
  raw: item,
});

/** Anthropic 形态：`{ name, description?, input_schema }`（无 type 字段或 type 缺失）。 */
const normalizeAnthropicFunctionTool = (item: Record<string, unknown>): CanonicalTool => ({
  name: String(item.name ?? ''),
  description: typeof item.description === 'string' ? item.description : undefined,
  schema: (item.input_schema as Record<string, unknown>) ?? {},
  kind: 'function',
  raw: item,
});

const normalizeComputerTool = (item: Record<string, unknown>): CanonicalTool => {
  const meta = extractComputerMeta(item);
  return {
    name: typeof item.name === 'string' ? item.name : 'computer',
    schema: {},
    kind: 'computer',
    builtIn: true,
    ...meta,
    raw: item,
  };
};

/** 通用内置工具工厂（web_search / code_interpreter / file_search / mcp 共用）。 */
const makeBuiltinTool = (
  raw: Record<string, unknown>,
  name: string,
  kind: CanonicalTool['kind'],
  extra: Partial<CanonicalTool> = {},
): CanonicalTool => ({
  name,
  schema: {},
  kind,
  builtIn: true,
  ...extra,
  raw,
});

const normalizeMcpTool = (item: Record<string, unknown>, type: string): CanonicalTool =>
  makeBuiltinTool(item, typeof item.name === 'string' ? item.name : type, 'mcp', {
    schema: (item.parameters as Record<string, unknown>) ?? {},
    description: typeof item.description === 'string' ? item.description : undefined,
    // MCP 工具由 provider 远程服务发现，不属于客户端 builtin
    builtIn: false,
  });

const normalizeCustomTool = (item: Record<string, unknown>, type: string): CanonicalTool => ({
  name: resolveToolName(item, type),
  schema: {},
  kind: 'custom',
  builtIn: type !== '' && type !== 'function',
  raw: item,
});

/**
 * 归一工具 wire 形态到 CanonicalTool（分发到子步骤）。
 *
 * 支持的形态：
 * - Chat function: `{ type: 'function', function: { name, description?, parameters } }`
 * - Responses function: `{ type: 'function', name, description?, parameters, strict? }`
 * - Anthropic function: `{ name, description?, input_schema }`（无 type 或 type 缺失）
 * - Anthropic computer: `{ type: 'computer_20251124', name?, display_* }`
 * - Responses computer: `{ type: 'computer_use_preview', display_* }`
 * - Responses web_search / code_interpreter / file_search
 * - Responses MCP（type=mcp，非探测工具）
 *
 * 其它未识别 type：原样保留，kind 标 'custom'。
 */
export const normalizeTool = (item: Record<string, unknown>): CanonicalTool => {
  const type = String(item.type ?? '');
  const fn = item.function;

  // Chat function：嵌套 function 对象形态
  if (type === 'function' && fn && typeof fn === 'object') {
    return normalizeChatFunctionTool(item);
  }
  // Responses function：扁平形态（顶层有 name）
  if (type === 'function' && typeof item.name === 'string') {
    return normalizeResponsesFunctionTool(item);
  }
  // Anthropic function：type 缺失，或无 type 但有 input_schema
  if (type === '' || item.input_schema !== undefined) {
    return normalizeAnthropicFunctionTool(item);
  }
  // Computer：Anthropic `computer_20251124` / Responses `computer_use_preview`
  if (type.startsWith('computer_20') || type === 'computer_use_preview') {
    return normalizeComputerTool(item);
  }
  // Web search
  if (type === 'web_search_preview' || type === 'web_search') {
    return makeBuiltinTool(item, type, 'web_search');
  }
  // Code interpreter
  if (type === 'code_interpreter') {
    return makeBuiltinTool(item, type, 'code_interpreter');
  }
  // File search
  if (type === 'file_search') {
    return makeBuiltinTool(item, type, 'file_search');
  }
  // MCP（type=mcp 的 wire 形态，非探测工具）
  if (type === 'mcp') {
    return normalizeMcpTool(item, type);
  }
  // 未识别：原样保留为 custom
  return normalizeCustomTool(item, type);
};

/** 归一 tool_choice 形态到 CanonicalToolChoice（协议无关 IR 形态）。 */
export const normalizeToolChoice = (choice: unknown): CanonicalToolChoice | undefined => {
  if (choice === undefined || choice === null) return undefined;
  if (typeof choice === 'string') {
    if (choice === 'auto') return { kind: 'auto' };
    if (choice === 'none') return { kind: 'none' };
    if (choice === 'required' || choice === 'any') return { kind: 'required' };
    // 未知字符串：返回 undefined，让 caller 决定处理
    return undefined;
  }
  if (typeof choice !== 'object') return undefined;
  const tc = choice as Record<string, unknown>;
  const type = String(tc.type ?? '');
  if (type === 'auto') return { kind: 'auto' };
  if (type === 'none') return { kind: 'none' };
  if (type === 'any' || type === 'required') return { kind: 'required' };
  if (type === 'tool' && typeof tc.name === 'string') {
    return { kind: 'tool', name: tc.name };
  }
  if (type === 'function') {
    const fn = tc.function as Record<string, unknown> | undefined;
    if (fn && typeof fn.name === 'string') {
      return { kind: 'tool', name: fn.name };
    }
    if (typeof tc.name === 'string') {
      // Responses 扁平形态：{ type: 'function', name }
      return { kind: 'tool', name: tc.name };
    }
  }
  return undefined;
};

/**
 * 解析 tool_use.input：Anthropic 是 JSON 对象；Chat function.arguments 是 JSON 字符串。
 * 这里接收已 parse 的对象（adapter 已解析），仅做空对象 fallback。
 */
export const ensureToolInput = (input: unknown): ToolInput => {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return {};
};

/**
 * 解析 Anthropic tool_result.content：可以是字符串或 content blocks 数组（Anthropic/Chat 形态）。
 * 归一到 CanonicalBlock[] 或 string。
 *
 * 当 content 既非 string 也非数组（如 null / 数字 / 布尔）时抛错，强制上游显式修复；
 * 不做静默降级，避免吞掉上游格式错误。caller（adapter）应捕获并附加自己的上下文。
 */
export const parseToolResultContent = (
  content: unknown,
  parseBlock: (b: Record<string, unknown>) => CanonicalBlock | null,
): CanonicalBlock[] | string => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const blocks: CanonicalBlock[] = [];
    for (const raw of content as Array<Record<string, unknown>>) {
      const block = parseBlock(raw);
      if (block) blocks.push(block);
    }
    return blocks;
  }
  throw new Error(
    `parseToolResultContent: unsupported content shape (${content === null ? 'null' : typeof content}), expected string or content block array`,
  );
};