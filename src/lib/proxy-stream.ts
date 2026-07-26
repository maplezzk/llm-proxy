/**
 * 统一 SSE 透传模块：把上游 `Response.body`（Web ReadableStream<Uint8Array>）
 * 零拷贝管道给客户端（也是 Web Streams / Hono stream sink）。
 *
 * 设计要点（spike 已验证）：
 * - `getReader()` 后必须 `releaseLock()`；放在 finally 保证异常路径也释放。
 * - 写入失败由调用方处理（sse 路由会写 error 事件再重抛；proxy-sse 直接抛）。
 * - 不在循环里 await Promise.all / 缓冲多帧；保持线性 write，避免 SSE 帧顺序错乱。
 *
 * 错误归属：
 * - 来自 reader.read() 的网络中断等错误会原样上抛（含原始 cause），
 *   由调用方决定是否写错误事件 / 关闭 stream sink。
 * - reader.releaseLock() 自身不会抛。
 */
export type StreamSink = {
  write: (chunk: Uint8Array) => Promise<unknown>;
};

export const pipeReadableStream = async (
  body: ReadableStream<Uint8Array>,
  sink: StreamSink,
): Promise<void> => {
  const reader = body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) await sink.write(value);
    }
  } finally {
    reader.releaseLock();
  }
};
