import type { CanonicalBlock, CanonicalResponse, UsageRecord } from '../../ir/types.ts';
import type { WireBody } from '../index.ts';

function text(blocks: CanonicalBlock[]): string { return blocks.filter((b): b is Extract<CanonicalBlock,{kind:'text'}> => b.kind==='text').map(b=>b.text).join(''); }
function tools(blocks: CanonicalBlock[]): Record<string, unknown>[] { return blocks.filter((b): b is Extract<CanonicalBlock,{kind:'tool_use'}>=>b.kind==='tool_use').map(b=>({id:b.id,type:'function',function:{name:b.namespace?`${b.namespace}__${b.name}`:b.name,arguments:JSON.stringify(b.input)}})); }
/** canonical stopReason → OpenAI Chat finish_reason（end_turn→stop、tool_use→tool_calls、max_tokens→length）。 */
function toChatFinishReason(r: string): string { return r==='end_turn' ? 'stop' : r==='tool_use' ? 'tool_calls' : r==='max_tokens' ? 'length' : r==='stop_sequence' ? 'stop' : r; }
/** canonical stopReason → Anthropic stop_reason（content_filter→refusal，其余同名直通）。 */
function toAnthropicStopReason(r: string): string { return r==='content_filter' ? 'refusal' : r; }
/** 缓存读>0 才输出（legacy 约定，0 时省略）。 */
const hasCacheRead = (u: UsageRecord): boolean => typeof u.cacheReadTokens === 'number' && u.cacheReadTokens > 0;
/** 缓存创建>0 才输出（legacy 约定，0 时省略）。 */
const hasCacheCreate = (u: UsageRecord): boolean => typeof u.cacheCreationTokens === 'number' && u.cacheCreationTokens > 0;
/** 拼接 Chat usage：cache 计入 prompt_tokens，cache>0 时单独写 prompt_tokens_details 暴露。 */
function buildChatUsage(u: UsageRecord): Record<string, unknown> {
  const cr = u.cacheReadTokens ?? 0;
  const cc = u.cacheCreationTokens ?? 0;
  return {
    prompt_tokens: u.inputTokens + cr + cc,
    completion_tokens: u.outputTokens,
    total_tokens: u.inputTokens + u.outputTokens + cr + cc,
    ...(hasCacheRead(u) || hasCacheCreate(u)
      ? { prompt_tokens_details: { ...(hasCacheRead(u) ? { cached_tokens: cr } : {}), ...(hasCacheCreate(u) ? { cache_creation_input_tokens: cc } : {}) } }
      : {}),
  };
}
/** 拼接 Responses usage：cache_read 走 input_tokens_details.cached_tokens，cache_creation 顶层 key。 */
function buildResponsesUsage(u: UsageRecord): Record<string, unknown> {
  return {
    input_tokens: u.inputTokens,
    output_tokens: u.outputTokens,
    total_tokens: u.inputTokens + u.outputTokens,
    ...(hasCacheRead(u) ? { input_tokens_details: { cached_tokens: u.cacheReadTokens } } : {}),
    ...(hasCacheCreate(u) ? { cache_creation_input_tokens: u.cacheCreationTokens } : {}),
  };
}
/** 拼接 Anthropic usage：cache_read/cache_creation 顶层 key。 */
function buildAnthropicUsage(u: UsageRecord): Record<string, unknown> {
  return {
    input_tokens: u.inputTokens,
    output_tokens: u.outputTokens,
    ...(hasCacheRead(u) ? { cache_read_input_tokens: u.cacheReadTokens } : {}),
    ...(hasCacheCreate(u) ? { cache_creation_input_tokens: u.cacheCreationTokens } : {}),
  };
}
function anthropic(response: CanonicalResponse): WireBody { return {id:'msg_canonical',type:'message',role:'assistant',content:response.message.blocks.map(b=>b.kind==='text'?{type:'text',text:b.text}:b.kind==='thinking'?{type:'thinking',thinking:b.text,signature:b.signature??''}:b.kind==='tool_use'?{type:'tool_use',id:b.id,name:b.namespace?`${b.namespace}__${b.name}`:b.name,input:b.input}:{type:'text',text:b.kind==='reasoning'?b.text:''}),model:response.model,stop_reason:toAnthropicStopReason(response.stopReason),stop_sequence:null,usage:response.usage?buildAnthropicUsage(response.usage):undefined}; }
function chat(response: CanonicalResponse): WireBody { const calls=tools(response.message.blocks); return {id:'chatcmpl-canonical',object:'chat.completion',created:Math.floor(Date.now()/1000),model:response.model,choices:[{index:0,message:{role:'assistant',content:text(response.message.blocks),...(response.message.blocks.some(b=>b.kind==='thinking')?{reasoning_content:response.message.blocks.filter((b):b is Extract<CanonicalBlock,{kind:'thinking'}>=>b.kind==='thinking').map(b=>b.text).join('')}:{}),...(calls.length?{tool_calls:calls}:{})},finish_reason:toChatFinishReason(response.stopReason)}],usage:response.usage?buildChatUsage(response.usage):undefined}; }
function responses(response: CanonicalResponse): WireBody { const output: Record<string, unknown>[]=[]; const messageText=text(response.message.blocks); if(messageText) output.push({type:'message',role:'assistant',content:[{type:'output_text',text:messageText,annotations:[]}]}); for(const block of response.message.blocks) { if(block.kind==='tool_use') output.push(block.name==='computer'?{type:'computer_call',call_id:block.id,action:block.input,status:'completed'}:{type:'function_call',call_id:block.id,name:block.namespace?`${block.namespace}__${block.name}`:block.name,arguments:JSON.stringify(block.input),status:'completed'}); } return {id:'resp_canonical',object:'response',created_at:Math.floor(Date.now()/1000),model:response.model,output,status:response.finishReason==='completed'?'completed':'incomplete',usage:response.usage?buildResponsesUsage(response.usage):undefined}; }
export const convertAnthropicResponseToOpenAI = (r: CanonicalResponse): WireBody => chat(r);
export const convertAnthropicResponseToOpenAIResponses = (r: CanonicalResponse): WireBody => responses(r);
export const convertOpenAIResponseToAnthropic = (r: CanonicalResponse): WireBody => anthropic(r);
export const convertOpenAIResponsesToAnthropic = (r: CanonicalResponse): WireBody => anthropic(r);
export const convertOpenAIResponseToOpenAIResponses = (r: CanonicalResponse): WireBody => responses(r);
export const convertOpenAIResponsesResponseToOpenAI = (r: CanonicalResponse): WireBody => chat(r);
export const anthropicToOpenAi = convertAnthropicResponseToOpenAI;
export const anthropicToResponses = convertAnthropicResponseToOpenAIResponses;
export const openAiToAnthropic = convertOpenAIResponseToAnthropic;
export const responsesToAnthropic = convertOpenAIResponsesToAnthropic;
export const chatToResponses = convertOpenAIResponseToOpenAIResponses;
export const responsesToChat = convertOpenAIResponsesResponseToOpenAI;