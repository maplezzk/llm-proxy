import type {
  CanonicalBlock,
  CanonicalMessage,
  CanonicalRequest,
  CanonicalTool,
} from '../../ir/types.ts';
import type { OutboundAdapter, WireBody } from '../index.ts';

function content(blocks: CanonicalBlock[]): unknown {
  const parts: Record<string, unknown>[] = [];
  for (const block of blocks) {
    if (block.kind === 'text') parts.push({ type: 'text', text: block.text });
    else if (block.kind === 'thinking')
      parts.push({
        type: 'thinking',
        thinking: block.text,
        ...(block.signature ? { signature: block.signature } : {}),
      });
    else if (block.kind === 'image') {
      const source = block.source;
      parts.push(
        source.kind === 'url'
          ? { type: 'image_url', image_url: { url: source.url, detail: source.detail } }
          : source.kind === 'base64'
            ? {
                type: 'image_url',
                image_url: { url: `data:${source.mediaType};base64,${source.data}` },
              }
            : { type: 'text', text: `[image:file_id=${source.fileId}]` },
      );
    } else if (block.kind === 'tool_use')
      parts.push({
        type: 'tool_use',
        id: block.id,
        name: block.namespace ? `${block.namespace}__${block.name}` : block.name,
        input: block.input,
      });
    else if (block.kind === 'tool_result')
      parts.push({
        type: 'tool_result',
        tool_use_id: block.toolUseId,
        content: typeof block.content === 'string' ? block.content : content(block.content),
        ...(block.isError ? { is_error: true } : {}),
      });
    else if (block.kind === 'reasoning') parts.push({ type: 'thinking', thinking: block.text });
  }
  return parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts;
}
function message(message: CanonicalMessage): Record<string, unknown> {
  const role = message.role === 'developer' ? 'system' : message.role;
  const result: Record<string, unknown> = { role, content: content(message.blocks) };
  if (message.role === 'assistant') {
    const calls = message.blocks.filter(
      (block): block is Extract<CanonicalBlock, { kind: 'tool_use' }> => block.kind === 'tool_use',
    );
    const thinking = message.blocks
      .filter(
        (block): block is Extract<CanonicalBlock, { kind: 'thinking' }> =>
          block.kind === 'thinking',
      )
      .map((block) => block.text)
      .join('');
    if (thinking) result.reasoning_content = thinking;
    if (calls.length)
      result.tool_calls = calls.map((call) => ({
        id: call.id,
        type: 'function',
        function: {
          name: call.namespace ? `${call.namespace}__${call.name}` : call.name,
          arguments: JSON.stringify(call.input),
        },
      }));
  }
  return result;
}
function openAiTools(tools: CanonicalTool[] | undefined): unknown[] | undefined {
  if (!tools) return undefined;
  const output: Record<string, unknown>[] = [];
  for (const tool of tools) {
    if (tool.kind !== 'function' && tool.kind !== 'mcp' && tool.kind !== 'custom') continue;
    output.push({
      type: 'function',
      function: {
        name: tool.namespace ? `${tool.namespace}__${tool.name}` : tool.name,
        description: tool.description,
        parameters: tool.schema,
      },
    });
  }
  return output.length ? output : undefined;
}
export const openAiChatOutbound: OutboundAdapter = {
  name: 'openai',
  encode(request: CanonicalRequest): WireBody {
    const messages: Record<string, unknown>[] = [];
    if (typeof request.system === 'string')
      messages.push({ role: 'system', content: request.system });
    else if (request.system)
      messages.push({
        role: 'system',
        content: request.system.map((block) =>
          block.kind === 'text'
            ? { type: 'text', text: block.text }
            : { type: 'text', text: '[image]' },
        ),
      });
    messages.push(...request.messages.filter((message) => message.role !== 'system').map(message));
    const body: WireBody = {
      model: request.resolvedModel?.modelId ?? request.logicalModel,
      messages,
    };
    const maxTokens = request.generation.maxTokens;
    if (maxTokens !== undefined) body.max_tokens = maxTokens;
    if (request.generation.temperature !== undefined)
      body.temperature = request.generation.temperature;
    if (request.generation.topP !== undefined) body.top_p = request.generation.topP;
    if (request.generation.stopSequences) body.stop = request.generation.stopSequences;
    if (request.generation.stream) body.stream = true;
    const effort = request.reasoning?.enabled === false ? undefined : request.reasoning?.effort;
    if (effort) body.reasoning_effort = effort;
    const toolList = openAiTools(request.tools);
    if (toolList) body.tools = toolList;
    if (request.toolChoice)
      body.tool_choice =
        request.toolChoice.kind === 'tool'
          ? { type: 'function', function: { name: request.toolChoice.name } }
          : request.toolChoice.kind === 'required'
            ? 'required'
            : request.toolChoice.kind;
    return body;
  },
};
export default openAiChatOutbound;
