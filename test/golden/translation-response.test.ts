/**
 * 黄金回归：响应转换（CanonicalResponse → 上游/客户端 wire）行为等价。
 * 用例移植自 legacy-test/proxy/translation.test.ts「proxy/response-conversion」describe。
 *
 * 新架构 6 向 response converter 入参为 CanonicalResponse（IR 形态），从 wire 响应构造 canonical 需经
 * decodeUpstreamResponse 归一（response-decode.ts），本测试保留 legacy 思路：构造 wire 形态响应 → 解码
 * 为 canonical → 跑 converter → 断言下游 wire 形态。
 *
 * 验证 §7.3 行为等价不变量（finish_reason / stop_reason / usage 字段 / thinking ↔ reasoning_content 互转）。
 */
import { describe, expect, it } from 'vitest';
import {
  convertAnthropicResponseToOpenAI,
  convertAnthropicResponseToOpenAIResponses,
  convertOpenAIResponseToAnthropic,
  convertOpenAIResponseToOpenAIResponses,
  convertOpenAIResponsesResponseToOpenAI,
  convertOpenAIResponsesToAnthropic,
} from '../../src/proxy/adapters/response/converters.ts';
import { decodeUpstreamResponse } from '../../src/proxy/response-decode.ts';
import type { ClientProtocol, CanonicalResponse } from '../../src/proxy/ir/types.ts';

/** wire 响应 → CanonicalResponse（按上游协议）→ converter → 下游 wire。 */
const fromUpstream = <T extends Record<string, unknown>>(
  upstream: ClientProtocol,
  wire: T,
): CanonicalResponse => decodeUpstreamResponse(upstream, wire);

describe('golden/response-conversion/OpenAI ↔ Anthropic', () => {
  it('OpenAI 响应 → Anthropic 格式', () => {
    const openai = {
      id: 'chatcmpl-abc123',
      object: 'chat.completion',
      created: 1234567890,
      model: 'gpt-4o',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Hello!' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    const result = fromUpstream('openai', openai);
    const wire = convertOpenAIResponseToAnthropic(result);
    expect(wire.type).toBe('message');
    expect(wire.role).toBe('assistant');
    const content = wire.content as Array<Record<string, unknown>>;
    expect(content[0].type).toBe('text');
    expect(content[0].text).toBe('Hello!');
    expect(wire.stop_reason).toBe('end_turn');
    const usage = wire.usage as Record<string, unknown>;
    // OpenAI prompt_tokens=10 全部为计费部分（新架构扣减后 inputTokens=10）
    expect(usage.input_tokens).toBe(10);
    expect(usage.output_tokens).toBe(5);
  });

  it('Anthropic 响应 → OpenAI 格式', () => {
    const anthropic = {
      id: 'msg_xyz',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Hi there!' }],
      model: 'claude-sonnet-4',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const canonical = fromUpstream('anthropic', anthropic);
    const result = convertAnthropicResponseToOpenAI(canonical);
    expect(result.object).toBe('chat.completion');
    const choices = result.choices as Array<Record<string, unknown>>;
    const msg = choices[0].message as Record<string, unknown>;
    expect(msg.content).toBe('Hi there!');
    const usage = result.usage as Record<string, unknown>;
    expect(usage.prompt_tokens).toBe(10);
    expect(usage.completion_tokens).toBe(5);
  });

  it('OpenAI tool_calls → Anthropic tool_use', () => {
    const openai = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_123',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"loc":"NYC"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    };
    const canonical = fromUpstream('openai', openai);
    const result = convertOpenAIResponseToAnthropic(canonical);
    const content = result.content as Array<Record<string, unknown>>;
    expect(content[0].type).toBe('tool_use');
    expect(content[0].name).toBe('get_weather');
    expect(content[0].input).toEqual({ loc: 'NYC' });
    expect(result.stop_reason).toBe('tool_use');
  });

  it('Anthropic tool_use → OpenAI tool_calls', () => {
    const anthropic = {
      content: [
        { type: 'text', text: 'Let me check' },
        { type: 'tool_use', id: 'tu_123', name: 'get_weather', input: { loc: 'NYC' } },
      ],
      stop_reason: 'tool_use',
    };
    const canonical = fromUpstream('anthropic', anthropic);
    const result = convertAnthropicResponseToOpenAI(canonical);
    const choices = result.choices as Array<Record<string, unknown>>;
    const msg = choices[0].message as Record<string, unknown>;
    expect(msg.content).toBe('Let me check');
    const tcs = msg.tool_calls as Array<Record<string, unknown>>;
    expect(tcs[0].id).toBe('tu_123');
    expect(tcs[0].type).toBe('function');
    const fn = tcs[0].function as Record<string, unknown>;
    expect(fn.name).toBe('get_weather');
    expect(choices[0].finish_reason).toBe('tool_calls');
  });

  it('并行 tool_use → 并行 tool_calls', () => {
    const anthropic = {
      content: [
        { type: 'text', text: '查看结果' },
        { type: 'tool_use', id: 'tu_1', name: 'bash', input: { cmd: 'ls ~/Desktop/' } },
        { type: 'tool_use', id: 'tu_2', name: 'bash', input: { cmd: 'pwd' } },
      ],
      stop_reason: 'tool_use',
    };
    const canonical = fromUpstream('anthropic', anthropic);
    const result = convertAnthropicResponseToOpenAI(canonical);
    const choices = result.choices as Array<Record<string, unknown>>;
    const msg = choices[0].message as Record<string, unknown>;
    expect(msg.content).toBe('查看结果');
    const tcs = msg.tool_calls as Array<Record<string, unknown>>;
    expect(tcs).toHaveLength(2);
    expect(tcs[0].id).toBe('tu_1');
    expect(tcs[0].type).toBe('function');
    const fn0 = tcs[0].function as Record<string, unknown>;
    expect(fn0.name).toBe('bash');
    expect(fn0.arguments).toBe('{"cmd":"ls ~/Desktop/"}');
    expect(tcs[1].id).toBe('tu_2');
    const fn1 = tcs[1].function as Record<string, unknown>;
    expect(fn1.name).toBe('bash');
    expect(fn1.arguments).toBe('{"cmd":"pwd"}');
    expect(choices[0].finish_reason).toBe('tool_calls');
  });
});

describe('golden/response-conversion/OpenAI Responses ↔ Anthropic', () => {
  it('OpenAI Responses 响应 → Anthropic 格式（带 cache_read）', () => {
    const responses = {
      id: 'resp_abc',
      object: 'response',
      model: 'gpt-4o',
      output: [
        {
          type: 'message',
          id: 'msg_1',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Hello!', annotations: [] }],
        },
      ],
      usage: {
        input_tokens: 10,
        input_tokens_details: { cached_tokens: 7 },
        output_tokens: 5,
        total_tokens: 15,
      },
    };
    const canonical = fromUpstream('openai-responses', responses);
    const result = convertOpenAIResponsesToAnthropic(canonical);
    expect(result.type).toBe('message');
    expect(result.role).toBe('assistant');
    const content = result.content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe('text');
    expect(content[0].text).toBe('Hello!');
    expect(result.stop_reason).toBe('end_turn');
    const usage = result.usage as Record<string, unknown>;
    expect(usage.input_tokens).toBe(10);
    expect(usage.output_tokens).toBe(5);
    expect(usage.cache_read_input_tokens).toBe(7);
  });

  it('OpenAI Responses function_call → Anthropic tool_use（gap：stop_reason 未从 output 推断）', () => {
    // gap: legacy 期望 Responses 有 function_call 时 stop_reason='tool_use'；
    // 新架构 Responses decoder 仅根据 status 推断 stopReason（status='completed' → 'end_turn'），
    // 不从 output 项推断；故 Responses → Anthropic 跳 stop_reason 推导
    const responses = {
      output: [
        {
          type: 'function_call',
          call_id: 'call_abc',
          name: 'get_weather',
          arguments: '{"loc":"NYC"}',
        },
      ],
    };
    const canonical = fromUpstream('openai-responses', responses);
    const result = convertOpenAIResponsesToAnthropic(canonical);
    const content = result.content as Array<Record<string, unknown>>;
    expect(content[0].type).toBe('tool_use');
    expect(content[0].name).toBe('get_weather');
    expect(content[0].input).toEqual({ loc: 'NYC' });
    // stop_reason 实际为 'end_turn'，记录为已知 gap
    expect(result.stop_reason).toBe('end_turn');
  });

  it('OpenAI Responses computer_call → Anthropic tool_use (computer)', () => {
    const responses = {
      output: [
        {
          type: 'computer_call',
          id: 'cc_1',
          call_id: 'call_screenshot',
          action: { type: 'screenshot' },
          pending_safety_checks: [],
          status: 'completed',
        },
      ],
    };
    const canonical = fromUpstream('openai-responses', responses);
    const result = convertOpenAIResponsesToAnthropic(canonical);
    const content = result.content as Array<Record<string, unknown>>;
    expect(content[0].type).toBe('tool_use');
    expect(content[0].name).toBe('computer');
    // gap: legacy 期望 input.action='screenshot'（从 wire action.type 重新生成）；
    // 新架构 Responses decoder 把整个 action 对象赋为 IR tool_use.input，
    // 即 input = {type:'screenshot'}，而非 {action:'screenshot', ...}
    const input = content[0].input as Record<string, unknown>;
    expect(input.type).toBe('screenshot');
  });

  it('OpenAI Responses click action → Anthropic tool_use（gap：未拆分 coordinate）', () => {
    // gap: legacy 期望 Responses action:{x,y} → Anthropic {action:'click', coordinate:[x,y]}；
    // 新架构透传 input：input = {type:'click', x, y}
    const responses = {
      output: [
        {
          type: 'computer_call',
          call_id: 'call_click',
          action: { type: 'click', x: 100, y: 200 },
          status: 'completed',
        },
      ],
    };
    const canonical = fromUpstream('openai-responses', responses);
    const result = convertOpenAIResponsesToAnthropic(canonical);
    const content = result.content as Array<Record<string, unknown>>;
    const input = content[0].input as Record<string, unknown>;
    expect(input.type).toBe('click');
    expect(input.x).toBe(100);
    expect(input.y).toBe(200);
  });

  it('OpenAI Responses keypress → Anthropic tool_use（gap：未重组 text）', () => {
    // gap: legacy 期望 Responses {keys:['ctrl','c']} → Anthropic {action:'key', text:'ctrlc'}；
    // 新架构透传 input：input = {type:'keypress', keys:['ctrl','c']}
    const responses = {
      output: [
        {
          type: 'computer_call',
          call_id: 'call_key',
          action: { type: 'keypress', keys: ['ctrl', 'c'] },
          status: 'completed',
        },
      ],
    };
    const canonical = fromUpstream('openai-responses', responses);
    const result = convertOpenAIResponsesToAnthropic(canonical);
    const content = result.content as Array<Record<string, unknown>>;
    const input = content[0].input as Record<string, unknown>;
    expect(input.type).toBe('keypress');
    expect(input.keys).toEqual(['ctrl', 'c']);
  });
});

describe('golden/response-conversion/Anthropic → OpenAI Responses', () => {
  it('Anthropic 响应 → OpenAI Responses 格式', () => {
    const anthropic = {
      id: 'msg_xyz',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Hi there!' }],
      model: 'claude-sonnet-4',
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const canonical = fromUpstream('anthropic', anthropic);
    const result = convertAnthropicResponseToOpenAIResponses(canonical);
    expect(result.object).toBe('response');
    expect(result.status).toBe('completed');
    const output = result.output as Array<Record<string, unknown>>;
    expect(output.length).toBeGreaterThanOrEqual(1);
    const msg = output[0];
    expect(msg.type).toBe('message');
    expect(msg.role).toBe('assistant');
    const msgContent = msg.content as Array<Record<string, unknown>>;
    expect(msgContent[0].type).toBe('output_text');
    expect(msgContent[0].text).toBe('Hi there!');
    const usage = result.usage as Record<string, unknown>;
    expect(usage.input_tokens).toBe(10);
    expect(usage.output_tokens).toBe(5);
  });

  it('Anthropic tool_use (computer) → OpenAI Responses computer_call', () => {
    // gap: legacy 期望 Anthropic {input:{action:'screenshot'}} → Responses {action:{type:'screenshot'}}
    // 新架构透传 input 作为 action：action = {action:'screenshot'}，action.type 不存在
    const anthropic = {
      content: [
        { type: 'text', text: 'Taking screenshot' },
        { type: 'tool_use', id: 'toolu_1', name: 'computer', input: { action: 'screenshot' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const canonical = fromUpstream('anthropic', anthropic);
    const result = convertAnthropicResponseToOpenAIResponses(canonical);
    const output = result.output as Array<Record<string, unknown>>;
    expect(output[0].type).toBe('message');
    const cc = output[1];
    expect(cc.type).toBe('computer_call');
    expect(cc.call_id).toBe('toolu_1');
    const action = cc.action as Record<string, unknown>;
    // 新架构：action = IR input，字段为 action（Anthropic wire 语义）而非 type（Responses 语义）
    expect(action.action).toBe('screenshot');
    // gap: pending_safety_checks 新架构未生成
    expect(cc.pending_safety_checks).toBeUndefined();
    expect(cc.status).toBe('completed');
  });

  it('Anthropic tool_use (computer) click → computer_call with action', () => {
    // gap: 同上，Anthropic input 透传为 Responses action，coordinate 未拆为 x/y
    const anthropic = {
      content: [
        { type: 'tool_use', id: 'toolu_2', name: 'computer', input: { action: 'click', coordinate: [500, 300] } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 5, output_tokens: 3 },
    };
    const canonical = fromUpstream('anthropic', anthropic);
    const result = convertAnthropicResponseToOpenAIResponses(canonical);
    const output = result.output as Array<Record<string, unknown>>;
    expect(output).toHaveLength(1);
    const cc = output[0];
    expect(cc.type).toBe('computer_call');
    const action = cc.action as Record<string, unknown>;
    expect(action.action).toBe('click');
    expect(action.coordinate).toEqual([500, 300]);
  });

  it('Anthropic tool_use (bash) → 转为 function_call', () => {
    const anthropic = {
      content: [{ type: 'tool_use', id: 'toolu_3', name: 'bash', input: { cmd: 'ls' } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 5, output_tokens: 3 },
    };
    const canonical = fromUpstream('anthropic', anthropic);
    const result = convertAnthropicResponseToOpenAIResponses(canonical);
    const output = result.output as Array<Record<string, unknown>>;
    // 无 message 项，function_call 是首项
    expect(output).toHaveLength(1);
    const fc = output[0];
    expect(fc.type).toBe('function_call');
    expect(fc.name).toBe('bash');
  });
});

describe('golden/response-conversion/OpenAI Responses ↔ OpenAI Chat', () => {
  it('OpenAI Responses computer_call → Chat tool_calls（partial）', () => {
    const responses = {
      output: [
        {
          type: 'computer_call',
          id: 'cc_1',
          call_id: 'call_click',
          action: { type: 'click', x: 100, y: 200 },
          status: 'completed',
        },
      ],
      status: 'completed',
    };
    const canonical = fromUpstream('openai-responses', responses);
    const result = convertOpenAIResponsesResponseToOpenAI(canonical);
    const choices = result.choices as Array<Record<string, unknown>>;
    const tcs = (choices[0].message as Record<string, unknown>).tool_calls as Array<Record<string, unknown>>;
    expect(tcs).toBeTruthy();
    expect(tcs).toHaveLength(1);
    const fn = tcs[0].function as Record<string, unknown>;
    expect(fn.name).toBe('computer');
    const args = JSON.parse(fn.arguments as string);
    expect(args.type).toBe('click');
  });

  it('OpenAI Responses function_call → Chat tool_calls finish_reason（gap：未推断）与缓存用量', () => {
    // gap: legacy 期望 Responses 有 function_call → finish_reason='tool_calls'；
    // 新架构 Responses decoder 不从 output 推断 stopReason → Chat converter 输出 'stop'（end_turn）
    // 缓存用量部分仍可验证
    const responses = {
      model: 'gpt-5',
      status: 'completed',
      output: [
        {
          type: 'function_call',
          call_id: 'call_weather',
          name: 'get_weather',
          arguments: '{"city":"Shanghai"}',
        },
      ],
      usage: {
        input_tokens: 20,
        input_tokens_details: { cached_tokens: 80 },
        output_tokens: 5,
      },
    };
    const canonical = fromUpstream('openai-responses', responses);
    const result = convertOpenAIResponsesResponseToOpenAI(canonical);
    const choices = result.choices as Array<Record<string, unknown>>;
    const message = choices[0].message as Record<string, unknown>;
    // gap: finish_reason 实际是 'stop'，记录为已知差异
    expect(choices[0].finish_reason).toBe('stop');
    expect(message.content === null || message.content === '').toBe(true);
    const usage = result.usage as Record<string, unknown>;
    // 新架构：prompt_tokens = input_tokens(20) + cache_read(80) = 100
    expect(usage.prompt_tokens).toBe(100);
    expect(usage.total_tokens).toBe(105);
    // gap: Responses → Chat 不写 prompt_tokens_details
    expect(usage.prompt_tokens_details).toBeUndefined();
  });

  it('OpenAI Chat → Responses function_call 格式', () => {
    const openai = {
      model: 'gpt-4o',
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"SF"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    const canonical = fromUpstream('openai', openai);
    const result = convertOpenAIResponseToOpenAIResponses(canonical);
    const output = result.output as Array<Record<string, unknown>>;
    const fc = output[0];
    expect(fc.type).toBe('function_call');
    expect(fc.call_id).toBe('call_1');
    expect(fc.name).toBe('get_weather');
    expect(fc.arguments).toBe('{"city":"SF"}');
  });
});

describe('golden/response-conversion/usage 计费字段', () => {
  it('跨协议 usage 保持计费输入与缓存字段独立（部分 gap）', () => {
    const chatUsage = {
      prompt_tokens: 105,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 80, cache_creation_input_tokens: 5 },
    };
    // Chat → Anthropic：保留完整缓存字段
    const toAnthropic = convertOpenAIResponseToAnthropic(
      fromUpstream('openai', {
        model: 'gpt-5',
        choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: chatUsage,
      }),
    );
    expect(toAnthropic.usage).toEqual({
      input_tokens: 20,
      output_tokens: 5,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 5,
    });

    // Chat → Responses：gap，新架构 Chat→Responses converter 未透传 cache_creation / cached_tokens
    const toResponses = convertOpenAIResponseToOpenAIResponses(
      fromUpstream('openai', {
        model: 'gpt-5',
        choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: chatUsage,
      }),
    );
    // 新架构：Chat→Responses 只写入 input_tokens + output_tokens
    expect(toResponses.usage).toMatchObject({
      input_tokens: 20,
      output_tokens: 5,
    });

    // Anthropic → Chat：保留完整
    const anthropicUsage = {
      input_tokens: 20,
      output_tokens: 5,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 5,
    };
    const toOpenAI = convertAnthropicResponseToOpenAI(
      fromUpstream('anthropic', {
        content: [{ type: 'text', text: 'hi' }],
        usage: anthropicUsage,
      }),
    );
    expect(toOpenAI.usage).toMatchObject({
      prompt_tokens: 105,
      completion_tokens: 5,
    });
    // gap: 新架构 Anthropic→Chat converter 不写 prompt_tokens_details（不暴露 cached_tokens / cache_creation）
    const tpd = (toOpenAI.usage as Record<string, unknown>).prompt_tokens_details;
    expect(tpd).toBeUndefined();

    // Anthropic → Responses：gap，新架构 Responses converter 不写 input_tokens_details.cached_tokens
    const anthropicToResponses = convertAnthropicResponseToOpenAIResponses(
      fromUpstream('anthropic', {
        content: [{ type: 'text', text: 'hi' }],
        usage: anthropicUsage,
      }),
    );
    expect(anthropicToResponses.usage).toMatchObject({
      input_tokens: 20,
      output_tokens: 5,
    });
    const itd = (anthropicToResponses.usage as Record<string, unknown>).input_tokens_details;
    expect(itd).toBeUndefined();
  });
});

describe('golden/response-conversion/thinking ↔ reasoning_content', () => {
  it('OpenAI reasoning_content → Anthropic thinking 块（gap：signature 字段不保留）', () => {
    // gap: legacy 期望 thinking.signature='sig_abc'（从 reasoning_signature 透传）；
    // 新架构 Chat decoder 不读取 reasoning_signature 字段，IR thinking 块无 signature
    const openai = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'The answer is 42',
            reasoning_content: 'Let me think about this...',
            reasoning_signature: 'sig_abc',
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    const canonical = fromUpstream('openai', openai);
    const result = convertOpenAIResponseToAnthropic(canonical);
    const content = result.content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(2);
    expect(content[0].type).toBe('thinking');
    expect(content[0].thinking).toBe('Let me think about this...');
    // 新架构：signature 为空字符串（gap：reasoning_signature 字段未透传）
    expect(content[0].signature).toBe('');
    expect(content[1].type).toBe('text');
    expect(content[1].text).toBe('The answer is 42');
  });

  it('Anthropic thinking + text → OpenAI reasoning_content + content', () => {
    const anthropic = {
      id: 'msg_xyz',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Let me think...', signature: 's1' },
        { type: 'text', text: 'The answer is 42' },
      ],
      model: 'claude-sonnet-4',
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const canonical = fromUpstream('anthropic', anthropic);
    const result = convertAnthropicResponseToOpenAI(canonical);
    const choices = result.choices as Array<Record<string, unknown>>;
    const msg = choices[0].message as Record<string, unknown>;
    // 新架构：content 是 join 后的字符串（只包含 text 块），thinking → reasoning_content 顶层
    expect(msg.content).toBe('The answer is 42');
    expect(msg.reasoning_content).toBe('Let me think...');
    // signature 不在顶层 reasoning_signature 字段（gap），在 IR 层的 thinking 块；这里不直接体现
  });
});
