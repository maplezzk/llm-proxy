/**
 * 流式测试专用 helper。
 *
 * 目标：把 legacy `makeReader` / `makeResponse` 风格（直接喂 reader + 收集 res.write 缓冲）
 * 迁移到新架构的 stream adapter 接口：
 *   - inbound：ReadableStream<Uint8Array>  →  AsyncIterable<CanonicalStreamEvent>
 *   - outbound：AsyncIterable<CanonicalStreamEvent>  →  ReadableStream<Uint8Array>
 *
 * 本文件只做接线，不做断言；用例放在 test/golden/stream-equivalence.test.ts。
 *
 * 注意：本文件中的 `chunkedSseStream` / `abortableSseStream` 在 delayMs>0 时会
 * 引入真实 setTimeout。需要在 fake-timer 环境下使用的用例，请改写调用方。
 */

import type { RouteDecision, StreamInboundAdapter, StreamOutboundAdapter } from '../../src/proxy/adapters/index.ts';
import type { CanonicalStreamEvent } from '../../src/proxy/ir/stream-events.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** 文本累积器：把 ReadableStream<Uint8Array> 拼成一个完整字符串。 */
async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let out = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return out;
}

/** 抽出的共享拉取子步骤：闭包内索引自增、越界关闭、可选延迟。 */
async function pullNextChunk(
  controller: ReadableStreamDefaultController<Uint8Array>,
  chunks: string[],
  state: { i: number },
  delayMs: number,
): Promise<void> {
  if (state.i >= chunks.length) {
    controller.close();
    return;
  }
  controller.enqueue(encoder.encode(chunks[state.i++]));
  if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
}

/** 一次性把整段 SSE 字符串灌入 ReadableStream。适合无延迟、无分块场景。 */
export function sseToReadableStream(sse: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(sse));
      controller.close();
    },
  });
}

/**
 * 分块灌入：每帧 `delayMs` 推一段。复刻 legacy `makeReader(chunks, delayMs)` 行为。
 * 用于需要在流过程中触发 cancel/abort 的测试。
 */
export function chunkedSseStream(chunks: string[], delayMs = 0): ReadableStream<Uint8Array> {
  const state = { i: 0 };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      await pullNextChunk(controller, chunks, state, delayMs);
    },
  });
}

/**
 * 把一个可被中途取消的分块流包成「AbortSignal 驱动」版本。
 * signal abort 时立刻关闭流（模拟上游被 caller 取消），下游 decoder 会从 read 拿到 done。
 *
 * 比真实 cancel() 轻量一些，但足以验证「中途 abort 后下游提前退出」行为。
 */
export function abortableSseStream(
  chunks: string[],
  signal: AbortSignal,
  delayMs = 0,
): ReadableStream<Uint8Array> {
  const state = { i: 0 };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (signal.aborted) {
        controller.close();
        return;
      }
      await pullNextChunk(controller, chunks, state, delayMs);
    },
  });
}

/** 拉完整个 inbound 适配器，收集所有 CanonicalStreamEvent 到数组。 */
export async function collectStreamEvents(
  stream: ReadableStream<Uint8Array>,
  adapter: StreamInboundAdapter,
): Promise<CanonicalStreamEvent[]> {
  const events: CanonicalStreamEvent[] = [];
  for await (const event of adapter.decode(stream)) events.push(event);
  return events;
}

/** 数组 → AsyncIterable（流式出站适配器接收的是异步迭代）。 */
export async function* eventsToAsyncIterable(
  events: CanonicalStreamEvent[],
): AsyncGenerator<CanonicalStreamEvent> {
  for (const event of events) yield event;
}

/**
 * 把出站适配器产生的字节流合并成单个 SSE 字符串，便于按包含/正则断言。
 * 内部对底层错误做一次包装，附带 adapter 名称与原 error.cause，便于测试快速定位。
 */
export async function encodeToSse(
  events: CanonicalStreamEvent[],
  adapter: StreamOutboundAdapter,
  route: RouteDecision,
): Promise<string> {
  try {
    const stream = adapter.encode(eventsToAsyncIterable(events), route);
    return await readAll(stream);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `stream helper: encodeToSse 失败（adapter=${adapter.name}）：${detail}`,
      { cause: error },
    );
  }
}

/** 解析 SSE 文本为「event + JSON data」列表。heartbeat / [DONE] 帧静默跳过。 */
export interface ParsedSseEvent {
  event: string;
  data: Record<string, unknown>;
}

/** 是否为心跳/结束哨兵帧（raw === '' 或 raw === '[DONE]'）。 */
function isHeartbeatOrDone(raw: string): boolean {
  return raw === '' || raw === '[DONE]';
}

/**
 * 把单帧文本解析成 {event, data}。
 * - 心跳/结束帧返回 undefined（哨兵）。
 * - 非 JSON 帧默认静默跳过（保留 legacy `parseSseEvents` 容错契约）；
 *   `strict=true` 时抛错，便于需要严格断言上游协议错误的用例。
 */
function parseSseFrame(frame: string, strict: boolean): ParsedSseEvent | undefined {
  if (!frame.trim()) return undefined;
  let event = '';
  const dataLines: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith(':')) continue; // SSE 注释行
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return undefined;
  const raw = dataLines.join('\n').trim();
  if (isHeartbeatOrDone(raw)) return undefined;
  try {
    return { event, data: JSON.parse(raw) as Record<string, unknown> };
  } catch (error) {
    if (!strict) return undefined;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `stream helper: parseSseFrame 失败（event=${event || '<none>'}）：${detail}；raw=${raw.slice(0, 200)}`,
      { cause: error },
    );
  }
}

export function parseSseEvents(sse: string, strict = false): ParsedSseEvent[] {
  const events: ParsedSseEvent[] = [];
  for (const frame of sse.split(/\r?\n\r?\n/)) {
    const parsed = parseSseFrame(frame, strict);
    if (parsed) events.push(parsed);
  }
  return events;
}
