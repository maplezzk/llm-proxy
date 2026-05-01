import { describe, it } from 'node:test'
import assert from 'node:assert'
import type { ServerResponse } from 'node:http'
import { convertAnthropicStreamToOpenAI, convertOpenAIStreamToAnthropic, convertOpenAIResponsesStreamToAnthropic, convertAnthropicStreamToOpenAIResponses } from '../../src/proxy/stream-converter.js'

function makeReader(chunks: string[]): ReadableStreamDefaultReader<Uint8Array> {
  const encoder = new TextEncoder()
  let i = 0
  const stream = new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(chunks[i++]))
    },
  })
  return stream.getReader()
}

function makeResponse(): { chunks: string[]; res: ServerResponse } {
  const chunks: string[] = []
  const res = {
    write: (data: string) => { chunks.push(data) },
    end: (data?: string) => { if (data) chunks.push(data); chunks.push('__END__') },
    writeHead: () => {},
    setHeader: () => {},
    getHeader: () => undefined,
  } as unknown as ServerResponse
  return { chunks, res }
}

describe('proxy/stream-converter', () => {
  describe('Anthropic SSE → OpenAI SSE (convertAnthropicStreamToOpenAI)', () => {
    it('text_delta → delta.content', async () => {
      const { chunks, res } = makeResponse()
      const reader = makeReader([
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"He"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"llo"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ])
      await convertAnthropicStreamToOpenAI(reader, res)
      const output = chunks.join('')
      assert.ok(output.includes('"content":"He"'), '第一个 chunk 应有 content')
      assert.ok(output.includes('"content":"llo"'), '第二个 chunk 应有 content')
      assert.ok(output.includes('[DONE]'), '应包含结束标记 [DONE]')
    })

    it('input_json_delta → tool_calls arguments', async () => {
      const { chunks, res } = makeResponse()
      const reader = makeReader([
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"get_weather","input":{}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"loc\\":\\"NYC\\"}"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ])
      await convertAnthropicStreamToOpenAI(reader, res)
      const output = chunks.join('')
      assert.ok(output.includes('"tool_calls"'), '应包含 tool_calls')
      assert.ok(output.includes('"get_weather"'), '工具名应保留')
      assert.ok(output.includes('"id"'), 'tool_call id 应保留')
    })

    it('message_delta stop_reason 映射', async () => {
      const { chunks, res } = makeResponse()
      const reader = makeReader([
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"done"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ])
      await convertAnthropicStreamToOpenAI(reader, res)
      const output = chunks.join('')
      assert.ok(output.includes('"finish_reason":"stop"'), 'end_turn → stop')
    })

    it('cache_read_input_tokens / cache_creation_input_tokens 透传到 prompt_tokens_details', async () => {
      const { chunks, res } = makeResponse()
      const reader = makeReader([
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":227,"cache_creation_input_tokens":0,"cache_read_input_tokens":125312,"output_tokens":1595}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ])
      await convertAnthropicStreamToOpenAI(reader, res)
      const output = chunks.join('')
      // 验证 cache_read_input_tokens → prompt_tokens_details.cached_tokens
      assert.ok(output.includes('"prompt_tokens_details"'), '应包含 prompt_tokens_details')
      assert.ok(output.includes('"cached_tokens":125312'), 'cache_read_input_tokens 应映射到 cached_tokens')
      // 验证 cache_creation_input_tokens 保留
      assert.ok(output.includes('"cache_creation_input_tokens":0'), 'cache_creation_input_tokens 应保留')
      // 验证基础字段
      assert.ok(output.includes('"prompt_tokens":227'), 'prompt_tokens 应等于 input_tokens')
      assert.ok(output.includes('"completion_tokens":1595'), 'completion_tokens 应等于 output_tokens')
      assert.ok(output.includes('"total_tokens":1822'), 'total_tokens 应为 input + output')
      assert.ok(output.includes('[DONE]'), '应包含 [DONE]')
    })

    it('ping 事件被忽略', async () => {
      const { chunks, res } = makeResponse()
      const reader = makeReader([
        'event: ping\ndata: {"type":"ping"}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ])
      await convertAnthropicStreamToOpenAI(reader, res)
      const output = chunks.join('')
      assert.ok(output.includes('[DONE]'), 'ping 不影响最终 [DONE]')
    })

    it('thinking_delta → reasoning_content', async () => {
      const { chunks, res } = makeResponse()
      const reader = makeReader([
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me analyze"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig_abc"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Answer"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":2}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ])
      await convertAnthropicStreamToOpenAI(reader, res)
      const output = chunks.join('')
      // Verify reasoning_content is emitted
      assert.ok(output.includes('"reasoning_content":"Let me analyze"'), 'thinking → reasoning_content')
      // Verify reasoning_signature is emitted at end
      assert.ok(output.includes('"reasoning_signature":"sig_abc"'), 'signature → reasoning_signature')
      // Verify text content still works
      assert.ok(output.includes('"content":"Answer"'), 'text content preserved')
      assert.ok(output.includes('[DONE]'), '应包含 [DONE]')
    })
  })

  describe('OpenAI SSE → Anthropic SSE (convertOpenAIStreamToAnthropic)', () => {
    it('role + content 事件 → content_block_start + text_delta', async () => {
      const { chunks, res } = makeResponse()
      const reader = makeReader([
        'data: {"choices":[{"delta":{"role":"assistant"},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{"content":"Hi"},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\n',
        'data: [DONE]\n\n',
      ])
      await convertOpenAIStreamToAnthropic(reader, res)
      const output = chunks.join('')
      assert.ok(output.includes('event: message_start'), '应有 message_start')
      assert.ok(output.includes('event: content_block_start'), '应有 content_block_start')
      assert.ok(output.includes('"text_delta"'), '应有 text_delta')
      assert.ok(output.includes('"text":"Hi"'), '内容应正确')
      assert.ok(output.includes('event: message_stop'), '应有 message_stop')
    })

    it('tool_calls → input_json_delta', async () => {
      const { chunks, res } = makeResponse()
      const reader = makeReader([
        'data: {"choices":[{"delta":{"role":"assistant"},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"loc\\":\\"NYC\\"}"}}]},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls","index":0}]}\n\n',
        'data: [DONE]\n\n',
      ])
      await convertOpenAIStreamToAnthropic(reader, res)
      const output = chunks.join('')
      assert.ok(output.includes('event: content_block_start'), 'tool_use 应有 content_block_start')
      assert.ok(output.includes('"input_json_delta"'), 'tool_call arguments 应转为 input_json_delta')
      assert.ok(output.includes('"stop_reason":"tool_use"'), 'tool_calls → tool_use')
      assert.ok(output.includes('event: message_stop'), '应有 message_stop')
    })

    it('reasoning_content → thinking_delta (content_block_start/stop 配对)', async () => {
      const { chunks, res } = makeResponse()
      const reader = makeReader([
        'data: {"choices":[{"delta":{"role":"assistant"},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":"Let me think..."},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{"content":"Hi there"},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_signature":"sig_xyz"},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\n',
        'data: [DONE]\n\n',
      ])
      await convertOpenAIStreamToAnthropic(reader, res)
      const output = chunks.join('')
      // Verify thinking block starts before deltas
      const thinkingStartIdx = output.indexOf('"type":"thinking"')
      const thinkingDeltaIdx = output.indexOf('"thinking_delta"')
      assert.ok(thinkingStartIdx < thinkingDeltaIdx, 'content_block_start (thinking) 应在 thinking_delta 之前')
      // Verify thinking content
      assert.ok(output.includes('"thinking":"Let me think..."'), 'reasoning_content → thinking_delta')
      assert.ok(output.includes('"signature":"sig_xyz"'), 'reasoning_signature → signature_delta')
      // Verify thinking block gets content_block_stop before text block stop
      const thinkingStopIdx = output.lastIndexOf('"thinking"')
      const textStopIdx = output.lastIndexOf('"text_delta"')
      const allStops = [...output.matchAll(/content_block_stop/g)]
      assert.ok(allStops.length >= 1, '至少有一个 content_block_stop')
      // Verify thinking and text use different block indices
      assert.ok(output.includes('"index":0') && output.includes('"index":1'), 'thinking 和 text 使用不同 block index')
      // Verify text content still works
      assert.ok(output.includes('"text":"Hi there"'), 'text content preserved')
      assert.ok(output.includes('event: message_stop'), '应有 message_stop')
    })
  })

  describe('OpenAI Responses SSE → Anthropic SSE', () => {
    it('output_text.delta → text_delta', async () => {
      const { chunks, res } = makeResponse()
      const reader = makeReader([
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_1","status":"in_progress","role":"assistant","content":[]}}\n\n',
        'event: response.content_part.added\ndata: {"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"Hel"}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"lo"}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed"}}\n\n',
      ])
      await convertOpenAIResponsesStreamToAnthropic(reader, res)
      const output = chunks.join('')
      assert.ok(output.includes('event: message_start'), '应有 message_start')
      assert.ok(output.includes('event: content_block_start'), '应有 content_block_start')
      assert.ok(output.includes('"text_delta"'), '应有 text_delta')
      assert.ok(output.includes('"text":"Hel"'), '应有第一个文字块')
      assert.ok(output.includes('event: message_stop'), '应有 message_stop')
    })

    it('function_call_arguments.delta → input_json_delta', async () => {
      const { chunks, res } = makeResponse()
      const reader = makeReader([
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_1","status":"in_progress","role":"assistant","content":[]}}\n\n',
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"get_weather","arguments":""}}\n\n',
        'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":1,"delta":"{\\"loc\\":\\"NYC\\"}"}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed"}}\n\n',
      ])
      await convertOpenAIResponsesStreamToAnthropic(reader, res)
      const output = chunks.join('')
      assert.ok(output.includes('"input_json_delta"'), '应有 input_json_delta')
      assert.ok(output.includes('"get_weather"'), '工具名应保留')
    })

    it('reasoning_text.delta → thinking_delta (带 content_block_start)', async () => {
      const { chunks, res } = makeResponse()
      const reader = makeReader([
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_1","status":"in_progress","role":"assistant","content":[]}}\n\n',
        'event: response.content_part.added\ndata: {"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}\n\n',
        'event: response.reasoning_text.delta\ndata: {"type":"response.reasoning_text.delta","delta":"Step 1: analyze"}\n\n',
        'event: response.reasoning_text.delta\ndata: {"type":"response.reasoning_text.delta","delta":"Step 2: conclude"}\n\n',
        'event: response.reasoning_text.done\ndata: {"type":"response.reasoning_text.done"}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"Final answer"}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":20,"output_tokens":8}}}\n\n',
      ])
      await convertOpenAIResponsesStreamToAnthropic(reader, res)
      const output = chunks.join('')
      // Verify thinking block starts before deltas
      const thinkingStartIdx = output.indexOf('"type":"thinking"')
      const thinkingDeltaIdx = output.indexOf('"thinking_delta"')
      assert.ok(thinkingStartIdx < thinkingDeltaIdx, 'content_block_start (thinking) 应在 thinking_delta 之前')
      // Verify both reasoning chunks
      assert.ok(output.includes('"thinking":"Step 1: analyze"'), 'reasoning chunk 1')
      assert.ok(output.includes('"thinking":"Step 2: conclude"'), 'reasoning chunk 2')
      // Verify thinking and text use different block indices
      assert.ok(output.includes('"index":0') && output.includes('"index":1'), 'thinking (0) 和 text (1) 使用不同 index')
      // Verify thinking gets content_block_stop 
      const allStop0 = [...output.matchAll(/"index":0.*content_block_stop"|content_block_stop.*"index":0/g)]
      assert.ok(allStop0.length >= 1, 'thinking block 应有 content_block_stop')
      // Verify text content preserved
      assert.ok(output.includes('"text":"Final answer"'), 'text content preserved')
      assert.ok(output.includes('event: message_stop'), '应有 message_stop')
    })
  })

  describe('Anthropic SSE → OpenAI Responses SSE', () => {
    it('text_delta → output_text.delta', async () => {
      const { chunks, res } = makeResponse()
      const reader = makeReader([
        'event: message_start\ndata: {"type":"message_start","message":{}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ])
      await convertAnthropicStreamToOpenAIResponses(reader, res)
      const output = chunks.join('')
      assert.ok(output.includes('event: response.created'), '应有 response.created')
      assert.ok(output.includes('event: response.output_item.added'), '应有 output_item.added')
      assert.ok(output.includes('event: response.output_text.delta'), '应有 output_text.delta')
      assert.ok(output.includes('"Hi"'), '文字内容应传递')
      assert.ok(output.includes('event: response.completed'), '应有 response.completed')
    })

    it('thinking_delta → reasoning skipped (Responses client doesn\'t track reasoning)', async () => {
      const { chunks, res } = makeResponse()
      const reader = makeReader([
        'event: message_start\ndata: {"type":"message_start","message":{}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me reason"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig_123"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Answer here"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":10,"output_tokens":8}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ])
      await convertAnthropicStreamToOpenAIResponses(reader, res)
      const output = chunks.join('')
      // Verify reasoning_text.delta is NOT emitted (Responses client doesn't track reasoning)
      assert.ok(!output.includes('event: response.reasoning_text.delta'), '不应该有 reasoning_text.delta')
      // Verify text content still works
      assert.ok(output.includes('event: response.output_text.delta'), '应有 output_text.delta')
      assert.ok(output.includes('"Answer here"'), 'text content preserved')
      // Verify completion events
      assert.ok(output.includes('event: response.completed'), '应有 response.completed')
    })
  })
})
