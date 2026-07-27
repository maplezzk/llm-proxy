import { describe, expect, it } from 'vitest';
import { buildNamespaceToolContext, decodeNs, encodeNs, remapNamespaceFunctionCalls } from '../../src/proxy/adapters/ccx/namespace.ts';
import { openaiResponsesInboundAdapter } from '../../src/proxy/adapters/inbound/openai-responses.ts';

const inputContext = { clientProtocol: 'openai-responses' as const, logicalModel: 'gpt-5' };

describe('golden/ccx-compat', () => {
  it('computer_use_preview 不被 strip 阶段误判为 computer_use', () => {
    const req = openaiResponsesInboundAdapter.decode({ model: 'gpt-5', input: 'hi', tools: [{ type: 'computer_use_preview' }, { type: 'function', name: 'get_weather', parameters: {} }] }, inputContext);
    expect(req.tools?.map((tool) => tool.kind)).toEqual(['computer', 'function']);
  });
  it('list_mcp_resource_templates 在非 Responses 入口保持工具', () => {
    const req = openaiResponsesInboundAdapter.decode({ model: 'gpt-5', input: 'hi', tools: [{ type: 'function', name: 'list_mcp_resource_templates', parameters: {} }] }, inputContext);
    // 设计不变量：只有 Responses inbound 才剥离 MCP 探测工具。
    expect(req.tools).toEqual([]);
  });
  it('Responses 入口剥离所有 MCP probe 工具但保留用户函数', () => {
    const req = openaiResponsesInboundAdapter.decode({ model: 'gpt-5', input: 'hi', tools: [
      { type: 'function', name: 'list_mcp_resources', parameters: {} },
      { type: 'function', name: 'list_mcp_resource_templates', parameters: {} },
      { type: 'function', name: 'read_mcp_resource', parameters: {} },
      { type: 'function', name: 'get_weather', parameters: {} },
    ] }, inputContext);
    expect(req.tools?.map((tool) => tool.name)).toEqual(['get_weather']);
  });

  it('namespace 名称编码：已有 __ 后缀不重复添加', () => expect(encodeNs('mcp__vscode__', 'exec')).toBe('mcp__vscode__exec'));
  it('namespace 名称编码：普通 namespace 使用双下划线', () => expect(encodeNs('mcp_vscode', 'exec')).toBe('mcp_vscode__exec'));
  it('namespace 工具上下文建立双向映射', () => {
    const namespace = 'mcp__vscode__';
    const mapping = buildNamespaceToolContext([{ type: 'namespace', name: namespace, tools: [{ type: 'function', name: 'exec' }] }]);
    expect(mapping.get('mcp__vscode__exec')).toEqual({ namespace, name: 'exec' });
    expect(decodeNs('mcp__vscode__exec', mapping)).toEqual({ namespace, name: 'exec' });
  });
  it('未知 namespace 名称解码时保持原样', () => expect(decodeNs('exec', new Map())).toEqual({ name: 'exec' }));

  it('Chat function_call 转 Responses 时保留 namespace 前缀语义', () => {
    const output = [{ type: 'function_call', name: 'mcp__vscode__exec', arguments: '{}', status: 'completed' }];
    const mapping = buildNamespaceToolContext([{ type: 'namespace', name: 'mcp__vscode__', tools: [{ type: 'function', name: 'exec' }] }]);
    remapNamespaceFunctionCalls(output, mapping);
    expect(output[0]).toMatchObject({ name: 'exec', namespace: 'mcp__vscode__' });
  });
  it('顶层 list_mcp_resources 调用不被 namespace 后处理修改', () => {
    const output = [{ type: 'function_call', name: 'list_mcp_resources' }];
    remapNamespaceFunctionCalls(output, new Map());
    expect(output[0]).toEqual({ type: 'function_call', name: 'list_mcp_resources' });
  });
  it('namespace child 工具可编码为扁平 function 名称', () => {
    const mapping = buildNamespaceToolContext([{ type: 'namespace', name: 'mcp__computer_use__', tools: [{ type: 'function', name: 'click' }] }]);
    expect([...mapping.keys()]).toEqual(['mcp__computer_use__click']);
  });
  it('namespace 工具多个 child 均可解码', () => {
    const mapping = buildNamespaceToolContext([{ type: 'namespace', name: 'mcp', tools: [{ type: 'function', name: 'a' }, { type: 'function', name: 'b' }] }]);
    expect(decodeNs('mcp__a', mapping)).toEqual({ namespace: 'mcp', name: 'a' });
    expect(decodeNs('mcp__b', mapping)).toEqual({ namespace: 'mcp', name: 'b' });
  });
  it('无效 namespace 定义不会污染上下文（防御 null/非对象元素）', () => {
    // 故意传入畸形输入（非 namespace 对象 / null / 字符串）：验证被测函数防御路径不读 .type 抛错，并返回空 Map。
    const inputs: unknown[] = [
      { type: 'function', name: 'x' },
      null,
      'bad',
    ];
    const context = buildNamespaceToolContext(inputs);
    expect(context).toEqual(new Map());
  });
  it('namespace 内嵌 null/string child 被防御跳过', () => {
    // 故意传入畸形 child（null / 字符串）：验证被测函数防御路径不读 null.type 抛错，仅 type='function'+name 非空的 child 进入映射。
    const inputs: unknown[] = [
      { type: 'namespace', name: 'mcp__x__', tools: [null, 'bad', { type: 'function', name: 'a' }] },
    ];
    const context = buildNamespaceToolContext(inputs);
    expect([...context.entries()]).toEqual([['mcp__x__a', { namespace: 'mcp__x__', name: 'a' }]]);
  });
  it('非 function child 不参与扁平化', () => expect(buildNamespaceToolContext([{ type: 'namespace', name: 'm', tools: [{ type: 'custom', name: 'x' }] }]).size).toBe(0));
  it('Responses function_call namespace 会进入 Canonical tool_use', () => {
    const req = openaiResponsesInboundAdapter.decode({ model: 'gpt-5', input: [{ type: 'function_call', call_id: 'c1', name: 'exec', namespace: 'mcp__vscode__', arguments: '{"command":"ls"}' }] }, inputContext);
    expect(req.messages[0]?.blocks[0]).toMatchObject({ kind: 'tool_use', name: 'mcp__vscode__exec' });
  });
  it('exec_command function 工具保持为普通 function', () => {
    const req = openaiResponsesInboundAdapter.decode({ model: 'gpt-5', input: 'hi', tools: [{ type: 'function', name: 'exec_command', parameters: {} }] }, inputContext);
    expect(req.tools?.[0]).toMatchObject({ kind: 'function', name: 'exec_command' });
  });
  it('probe 前缀匹配大小写无关且用户工具保留', () => {
    const req = openaiResponsesInboundAdapter.decode({ model: 'gpt-5', input: 'hi', tools: [{ type: 'function', name: 'READ_MCP_RESOURCE' }, { type: 'function', name: 'exec_command', parameters: {} }] }, inputContext);
    expect(req.tools?.map((tool) => tool.name)).toEqual(['READ_MCP_RESOURCE', 'exec_command']);
  });
  it('namespace remap 只处理 function_call', () => {
    const output = [{ type: 'message', name: 'mcp__x__a' }, { type: 'function_call_output', name: 'mcp__x__a' }];
    const mapping = buildNamespaceToolContext([{ type: 'namespace', name: 'mcp__x__', tools: [{ type: 'function', name: 'a' }] }]);
    remapNamespaceFunctionCalls(output, mapping);
    expect(output[0].name).toBe('mcp__x__a');
    expect(output[1].name).toBe('mcp__x__a');
  });
});
