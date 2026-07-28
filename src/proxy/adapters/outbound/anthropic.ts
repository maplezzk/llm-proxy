import type { CanonicalBlock, CanonicalMessage, CanonicalRequest, CanonicalTool, SystemBlock } from '../../ir/types.ts';
import type { OutboundAdapter, WireBody } from '../index.ts';

const textOf = (blocks: CanonicalBlock[]) => blocks.filter((b): b is Extract<CanonicalBlock, {kind:'text'}> => b.kind === 'text').map(b => b.text).join('');
const image = (b: Extract<CanonicalBlock,{kind:'image'}>) => ({ type: 'image', source: b.source.kind === 'url' ? { type:'url', url:b.source.url } : b.source.kind === 'base64' ? { type:'base64', media_type:b.source.mediaType, data:b.source.data } : { type:'file', file_id:b.source.fileId } });
const anthropicBlocks = (blocks: CanonicalBlock[]): unknown[] => blocks.map(b => {
  if (b.kind === 'text') return { type:'text', text:b.text };
  if (b.kind === 'thinking') return { type:'thinking', thinking:b.text, ...(b.signature ? {signature:b.signature} : {}) };
  if (b.kind === 'image') return image(b);
  if (b.kind === 'tool_use') return { type:'tool_use', id:b.id, name:b.namespace ? `${b.namespace}__${b.name}` : b.name, input:b.input };
  if (b.kind === 'tool_result') return { type:'tool_result', tool_use_id:b.toolUseId, content: typeof b.content === 'string' ? b.content : anthropicBlocks(b.content), ...(b.isError ? {is_error:true} : {}) };
  return { type:'text', text:b.kind === 'reasoning' ? b.text : `[${b.kind}]` };
});
const tools = (items: CanonicalTool[] | undefined): unknown[] | undefined => {
  if (!items) return undefined;
  const out: unknown[] = [];
  for (const t of items) {
    if (t.kind === 'computer') { out.push({type:'computer_20251124', name:'computer', ...(t.displayWidth ? {display_width_px:t.displayWidth} : {}), ...(t.displayHeight ? {display_height_px:t.displayHeight} : {}), ...(t.displayNumber ? {display_number:t.displayNumber} : {})}); continue; }
    if (['web_search','code_interpreter','file_search'].includes(t.kind)) continue;
    out.push({ name:t.namespace ? `${t.namespace}__${t.name}` : t.name, ...(t.description ? {description:t.description} : {}), input_schema:t.schema });
  }
  return out.length ? out : undefined;
};
const choice = (c: CanonicalRequest['toolChoice']) => !c ? undefined : c.kind === 'auto' ? {type:'auto'} : c.kind === 'required' ? {type:'any'} : c.kind === 'none' ? {type:'none'} : {type:'tool',name:c.name};
const system = (s: CanonicalRequest['system']) => typeof s === 'string' ? s : s?.map((b: SystemBlock) => b.kind === 'text' ? {type:'text',text:b.text,...(b.cacheControl ? {cache_control:b.cacheControl} : {})} : image(b as Extract<CanonicalBlock,{kind:'image'}>));
const msg = (m: CanonicalMessage) => ({ role:m.role === 'developer' ? 'user' : m.role, content: anthropicBlocks(m.blocks) });

export const anthropicOutbound: OutboundAdapter = { name:'anthropic', encode(req): WireBody {
  const reasoning = req.reasoning;
  const max = req.generation.maxTokens ?? 16384;
  const body: WireBody = { model:req.resolvedModel?.modelId ?? req.logicalModel, max_tokens:max, messages:req.messages.filter(m => m.role !== 'system').map(msg) };
  const s = system(req.system); if (s !== undefined) body.system = s;
  if (req.generation.temperature !== undefined) body.temperature=req.generation.temperature;
  if (req.generation.topP !== undefined) body.top_p=req.generation.topP;
  if (req.generation.stopSequences) body.stop_sequences=req.generation.stopSequences;
  if (req.generation.stream) body.stream=true;
  if (reasoning?.enabled !== false && reasoning?.budgetTokens !== undefined) body.thinking={type:reasoning.type ?? 'enabled',budget_tokens:reasoning.budgetTokens};
  else if (reasoning?.enabled !== false && reasoning?.type && reasoning.type !== 'disabled') body.thinking={type:reasoning.type};
  const ts=tools(req.tools); if(ts) body.tools=ts; const tc=choice(req.toolChoice); if(tc) body.tool_choice=tc;
  return body;
} };
export default anthropicOutbound;
