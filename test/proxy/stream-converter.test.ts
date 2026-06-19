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
      // 验证基础字段（prompt_tokens = 计费 input + 缓存命中 input）
      assert.ok(output.includes('"prompt_tokens":125539'), 'prompt_tokens 应等于 input_tokens + cache_read_input_tokens')
      assert.ok(output.includes('"completion_tokens":1595'), 'completion_tokens 应等于 output_tokens')
      assert.ok(output.includes('"total_tokens":127134'), 'total_tokens 应为 prompt_tokens + completion_tokens')
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
      // Verify reasoning_signature is emitted
      assert.ok(output.includes('"reasoning_signature":"sig_abc"'), 'signature → reasoning_signature')
      // reasoning_signature 应在 finish_reason chunk 的 delta 中，而非独立 chunk
      const finishIdx = output.indexOf('"finish_reason":"stop"')
      assert.ok(finishIdx > -1, '应有 finish_reason')
      // 找到包含 finish_reason 的 SSE data 行
      const finishLine = output.slice(Math.max(0, finishIdx - 200), finishIdx + 100)
      assert.ok(finishLine.includes('"reasoning_signature":"sig_abc"'), 'reasoning_signature 应在 finish_reason 同一个 chunk 的 delta 中')
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

    it('供应商不发送 [DONE] 时也能正确发送 message_stop（如 MiniMax）', async () => {
      const { chunks, res } = makeResponse()
      // MiniMax: role+content in same chunk, finish_reason+content in last chunk, no [DONE]
      const reader = makeReader([
        'data: {"id":"x","choices":[{"index":0,"delta":{"content":"Hello","role":"assistant"}}],"model":"minimax-m3","object":"chat.completion.chunk"}\n\n',
        'data: {"id":"x","choices":[{"finish_reason":"stop","index":0,"delta":{"content":" World","role":"assistant"}}],"model":"minimax-m3","object":"chat.completion.chunk"}\n\n',
      ])
      await convertOpenAIStreamToAnthropic(reader, res)
      const output = chunks.join('')
      // Should have complete Anthropic stream even without [DONE]
      assert.ok(output.includes('event: message_start'), '应有 message_start')
      assert.ok(output.includes('"text_delta"'), '应有 text_delta')
      assert.ok(output.includes('event: content_block_stop'), '应有 content_block_stop')
      assert.ok(output.includes('event: message_delta'), '应有 message_delta')
      assert.ok(output.includes('event: message_stop'), '即使无 [DONE] 也应有 message_stop')
      assert.ok(output.includes('__END__'), '应正常结束响应')
    })

    it('usage-only chunk (choices=[]) 补发 usage 时应正确转发（finish_reason chunk usage 为 0）', async () => {
      const { chunks, res } = makeResponse()
      // 模拟上游（如 glm-5.2）：finish_reason chunk 的 usage 是 0，后续单独发一个 usage-only chunk 带真实 usage
      const reader = makeReader([
        'data: {"choices":[{"delta":{"role":"assistant"},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{"content":"Hi"},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls","index":0}],"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}}\n\n',
        'data: {"choices":[],"usage":{"total_tokens":135630,"completion_tokens":1963,"prompt_tokens":133667,"prompt_tokens_details":{"cached_tokens":100000}}}\n\n',
        'data: [DONE]\n\n',
      ])
      await convertOpenAIStreamToAnthropic(reader, res)
      const output = chunks.join('')
      // message_delta 应带完整的真实 usage，而非 0
      const messageDeltaMatch = output.match(/event: message_delta\ndata: (\{[^\n]*\})/)
      assert.ok(messageDeltaMatch, '应有 message_delta 事件')
      const delta = JSON.parse(messageDeltaMatch![1])
      // OpenAI prompt_tokens 是总输入（含 cache），Anthropic input_tokens 不含 cache
      assert.strictEqual(delta.usage.input_tokens, 33667, 'input_tokens = prompt_tokens - cached_tokens')
      assert.strictEqual(delta.usage.output_tokens, 1963, 'message_delta usage.output_tokens 应来自 usage-only chunk')
      assert.strictEqual(delta.usage.cache_read_input_tokens, 100000, 'cached_tokens 应映射为 cache_read_input_tokens')
      assert.strictEqual(delta.delta.stop_reason, 'tool_use', 'stop_reason 应为 tool_use')
      // message_delta 应在 message_stop 之前
      const messageDeltaIdx = output.indexOf('event: message_delta')
      const messageStopIdx = output.indexOf('event: message_stop')
      assert.ok(messageDeltaIdx > -1 && messageStopIdx > -1 && messageDeltaIdx < messageStopIdx, 'message_delta 应在 message_stop 之前')
    })

    it('finish_reason chunk 不带 usage，usage-only chunk 补发', async () => {
      const { chunks, res } = makeResponse()
      const reader = makeReader([
        'data: {"choices":[{"delta":{"role":"assistant"},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{"content":"ok"},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":154541,"completion_tokens":64,"prompt_tokens_details":{"cached_tokens":153984}}}\n\n',
        'data: [DONE]\n\n',
      ])
      await convertOpenAIStreamToAnthropic(reader, res)
      const output = chunks.join('')
      const messageDeltaMatch = output.match(/event: message_delta\ndata: (\{[^\n]*\})/)
      assert.ok(messageDeltaMatch, '应有 message_delta 事件')
      const delta = JSON.parse(messageDeltaMatch![1])
      // prompt_tokens=154541 - cached_tokens=153984 = 557
      assert.strictEqual(delta.usage.input_tokens, 557, 'input_tokens = prompt_tokens - cached_tokens')
      assert.strictEqual(delta.usage.cache_read_input_tokens, 153984, 'cache_read_input_tokens 应正确映射')
      assert.strictEqual(delta.usage.output_tokens, 64, 'output_tokens 应来自 usage-only chunk')
    })

    it('cached_tokens=0 时 message_delta 不应包含 cache_read_input_tokens 字段', async () => {
      const { chunks, res } = makeResponse()
      const reader = makeReader([
        'data: {"choices":[{"delta":{"role":"assistant"},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{"content":"ok"},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":10,"prompt_tokens_details":{"cached_tokens":0}}}\n\n',
        'data: [DONE]\n\n',
      ])
      await convertOpenAIStreamToAnthropic(reader, res)
      const output = chunks.join('')
      const messageDeltaMatch = output.match(/event: message_delta\ndata: (\{[^\n]*\})/)
      assert.ok(messageDeltaMatch, '应有 message_delta 事件')
      const delta = JSON.parse(messageDeltaMatch![1])
      assert.strictEqual(delta.usage.input_tokens, 100, 'cached_tokens=0 时 input_tokens = prompt_tokens')
      assert.strictEqual(delta.usage.output_tokens, 10, 'output_tokens 正确')
      assert.ok(!('cache_read_input_tokens' in delta.usage), 'cached_tokens=0 时不应输出 cache_read_input_tokens 字段')
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

    it('computer_call → tool_use (computer) with action conversion', async () => {
      const { chunks, res } = makeResponse()
      const reader = makeReader([
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_1","status":"in_progress","role":"assistant","content":[]}}\n\n',
        'event: response.content_part.added\ndata: {"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"Taking screenshot"}\n\n',
        'event: response.output_text.done\ndata: {"type":"response.output_text.done"}\n\n',
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":1,"item":{"type":"computer_call","id":"cc_1","call_id":"call_screenshot","action":{"type":"screenshot"},"pending_safety_checks":[],"status":"in_progress"}}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed"}}\n\n',
      ])
      await convertOpenAIResponsesStreamToAnthropic(reader, res)
      const output = chunks.join('')
      // Verify computer_call → content_block_start (tool_use, computer)
      assert.ok(output.includes('"name":"computer"'), '工具名为 computer')
      assert.ok(output.includes('"action":"screenshot"'), 'action 应映射为 screenshot')
      // Verify content_block_stop for computer tool_use is emitted
      const stopEvents = [...output.matchAll(/content_block_stop/g)]
      assert.ok(stopEvents.length >= 2, '应有至少 2 个 content_block_stop（text + computer tool_use）')
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

    it('thinking_delta → reasoning_text.delta (with top-level reasoning.summary)', async () => {
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
      // Verify reasoning_text.delta IS emitted (streaming reasoning text)
      assert.ok(output.includes('event: response.reasoning_text.delta'), '应该有 reasoning_text.delta')
      assert.ok(output.includes('"Let me reason"'), 'reasoning 内容应传递')
      // Verify reasoning_text.done IS emitted when thinking block ends
      assert.ok(output.includes('event: response.reasoning_text.done'), '应该有 reasoning_text.done')
      // Verify text content still works
      assert.ok(output.includes('event: response.output_text.delta'), '应有 output_text.delta')
      assert.ok(output.includes('"Answer here"'), 'text content preserved')
      // Verify completion events
      assert.ok(output.includes('event: response.completed'), '应有 response.completed')
      // Verify reasoning is at top-level summary in response.completed
      assert.ok(output.includes('"summary_text"'), '顶层 reasoning 应为 summary_text 格式')
      // Verify message content in response.completed does NOT contain reasoning block type
      // (output item's content should only have output_text, not reasoning)
    })

    it('tool_use (computer) → computer_call output_item', async () => {
      const { chunks, res } = makeResponse()
      const reader = makeReader([
        'event: message_start\ndata: {"type":"message_start","message":{}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Clicking now"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"computer","input":{"action":"click","coordinate":[100,200]}}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"input_tokens":10,"output_tokens":5}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ])
      await convertAnthropicStreamToOpenAIResponses(reader, res)
      const output = chunks.join('')
      // Verify computer_call output_item.added is emitted (not function_call)
      assert.ok(output.includes('"type":"computer_call"'), 'should emit computer_call type')
      assert.ok(!output.includes('"type":"function_call"'), 'should NOT emit function_call for computer tool')
      // Verify the action is converted: click → {type: "click", x, y}
      assert.ok(output.includes('"action"'), 'should have action field')
      assert.ok(output.includes('"click"'), 'action should be click')
      // Verify output_item.done is emitted
      assert.ok(output.includes('event: response.completed'), 'should have response.completed')
    })
  })
})
