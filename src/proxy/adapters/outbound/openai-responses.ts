import type { CanonicalBlock, CanonicalRequest, CanonicalTool } from '../../ir/types.ts';
import type { OutboundAdapter, RouteDecision, WireBody } from '../index.ts';

function responseContent(blocks: CanonicalBlock[]): unknown {
  return blocks.map(block => {
    if (block.kind==='text') return {type:'input_text',text:block.text};
    if (block.kind==='image') return block.source.kind==='url' ? {type:'input_image',image_url:block.source.url,detail:block.source.detail} : block.source.kind==='file_id' ? {type:'input_image',file_id:block.source.fileId} : {type:'input_image',image_url:`data:${block.source.mediaType};base64,${block.source.data}`};
    if (block.kind==='thinking' || block.kind==='reasoning') return {type:'reasoning',summary:[{type:'summary_text',text:block.text}]};
    if (block.kind==='tool_use') return {type:'function_call',call_id:block.id,name:block.namespace ? `${block.namespace}__${block.name}` : block.name,arguments:JSON.stringify(block.input)};
    if (block.kind==='tool_result') return {type:'function_call_output',call_id:block.toolUseId,output:typeof block.content==='string' ? block.content : JSON.stringify(block.content)};
    return {type:'input_text',text:`[${block.kind}]`};
  });
}
function responseTools(tools: CanonicalTool[]|undefined): unknown[]|undefined {
  if (!tools) return undefined;
  const result: Record<string, unknown>[]=[];
  for (const tool of tools) {
    if (tool.kind==='computer') { result.push({type:'computer_use_preview',display_width:tool.displayWidth,display_height:tool.displayHeight,display_number:tool.displayNumber}); continue; }
    if (!['function','mcp','custom'].includes(tool.kind)) continue;
    result.push({type:'function',name:tool.namespace ? `${tool.namespace}__${tool.name}` : tool.name,description:tool.description,parameters:tool.schema});
  }
  return result.length ? result : undefined;
}
export const openAiResponsesOutbound: OutboundAdapter={name:'openai-responses',encode(request: CanonicalRequest, route: RouteDecision): WireBody {
  const body: WireBody={model:request.resolvedModel?.modelId ?? request.logicalModel,input:request.messages.filter(m=>m.role!=='system').flatMap(m=>{ const item: Record<string,unknown>={type:'message',role:m.role==='developer'?'developer':m.role,content:responseContent(m.blocks)}; return [item]; })};
  if(typeof request.system==='string') body.instructions=request.system;
  else if(request.system) body.instructions=request.system.map(block=>block.kind==='text'?block.text:'[image]').join('');
  if(request.generation.maxTokens!==undefined) body.max_output_tokens=request.generation.maxTokens;
  if(request.generation.temperature!==undefined) body.temperature=request.generation.temperature;
  if(request.generation.topP!==undefined) body.top_p=request.generation.topP;
  if(request.generation.stopSequences) body.stop=request.generation.stopSequences;
  if(request.generation.stream) body.stream=true;
  const reasoning=request.reasoning ?? route.thinking;
  if(reasoning.effort || reasoning.summary) body.reasoning={...(reasoning.effort?{effort:reasoning.effort}:{}),...(reasoning.summary?{summary:reasoning.summary}: {})};
  const toolList=responseTools(request.tools); if(toolList) body.tools=toolList;
  if(request.toolChoice) body.tool_choice=request.toolChoice.kind==='tool'?{type:'function',name:request.toolChoice.name}:request.toolChoice.kind;
  return body;
}};
export default openAiResponsesOutbound;
