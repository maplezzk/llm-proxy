/**
 * IR 内部归一（canonicalize）：把 inbound 适配器产出的 CanonicalRequest
 * 规范化为满足 IR 不变量的形态。纯函数，不修改入参，返回新结构。
 *
 * 设计依据：docs/plans/2026-07-27-003-feat-p1-protocol-core-design.md §3.6 / §4。
 *
 * 归一内容（均为协议无关的 IR 层处理，协议特有逻辑留给适配器）：
 * 1. tool role 消息 → user 消息（anthropic 要求 tool_result 在 user 轮）；
 * 2. thinking 块签名来源（signatureSource）显式化；
 * 3. 合并相邻同 role（user/assistant）消息；
 * 4. 工具命名空间（namespace__name）展平一致性。
 *
 * 边界用例（如跨会话 item_reference、连续 tool 轮顺序）由 P1.13 测试移植对照 legacy 行为校验。
 */

import type {
  CanonicalBlock,
  CanonicalMessage,
  CanonicalRequest,
  CanonicalTool,
} from './types.ts';

/** 显式化 thinking 块签名来源：有签名且未标注 → 'original'；无签名且未标注 → 'none'。 */
const normalizeThinkingSignature = (block: CanonicalBlock): CanonicalBlock => {
  if (block.kind !== 'thinking') return block;
  if (block.signatureSource) return block;
  return block.signature
    ? { ...block, signatureSource: 'original' }
    : { ...block, signatureSource: 'none' };
};

/**
 * 归一单条消息：tool role 转为 user（tool_result 块归入 user 轮），
 * 并对所有块做 thinking 签名来源显式化。
 * 契约：始终返回新对象，不修改入参消息及其 blocks；name 原样透传（当前 IR 规则不要求清空）。
 */
const normalizeMessage = (msg: CanonicalMessage): CanonicalMessage => ({
  role: msg.role === 'tool' ? 'user' : msg.role,
  blocks: msg.blocks.map(normalizeThinkingSignature),
  name: msg.name,
});

/** 合并相邻同 role（仅 user/assistant）消息，块顺序拼接；全程不可变，不就地修改。 */
const mergeConsecutiveMessages = (messages: CanonicalMessage[]): CanonicalMessage[] => {
  const merged: CanonicalMessage[] = [];
  for (const msg of messages) {
    const prev = merged[merged.length - 1];
    const mergeable = msg.role === 'user' || msg.role === 'assistant';
    if (prev && mergeable && prev.role === msg.role) {
      // 不可变合并：用新对象替换末尾元素，而非就地改 prev.blocks。
      merged[merged.length - 1] = { ...prev, blocks: [...prev.blocks, ...msg.blocks] };
      continue;
    }
    merged.push({ role: msg.role, blocks: [...msg.blocks], name: msg.name });
  }
  return merged;
};

/** 工具命名空间展平一致性：有 namespace 时，name 规整为 `${namespace}__${basename}`。 */
const normalizeToolNamespace = (tool: CanonicalTool): CanonicalTool => {
  if (!tool.namespace) return tool;
  const prefix = `${tool.namespace}__`;
  if (tool.name.startsWith(prefix)) return tool;
  // 取最后一段作为 basename 再展平（pop 可能 undefined，回退原名）。
  const basename = tool.name.includes('__') ? (tool.name.split('__').pop() ?? tool.name) : tool.name;
  return { ...tool, name: `${prefix}${basename}` };
};

/** messages 归一（两阶段）：先逐条归一（tool→user + thinking 签名），再合并相邻同 role。 */
const normalizeMessages = (messages: CanonicalMessage[]): CanonicalMessage[] =>
  mergeConsecutiveMessages(messages.map(normalizeMessage));

/** 工具列表归一（可能为空）。 */
const normalizeTools = (tools: CanonicalTool[] | undefined): CanonicalTool[] | undefined =>
  tools?.map(normalizeToolNamespace);

/**
 * IR 归一入口：对 inbound 产出的 CanonicalRequest 实施 IR 不变量。
 * 同步纯函数；返回新对象，入参不变。
 *
 * 输入契约：req 由 inbound 适配器经 zod 校验后产出，结构已保证合法；
 * 本函数不重复做 wire 层校验，仅在 IR 层做形态归一。
 */
export const normalizeRequest = (req: CanonicalRequest): CanonicalRequest => ({
  ...req,
  messages: normalizeMessages(req.messages),
  tools: normalizeTools(req.tools),
});
