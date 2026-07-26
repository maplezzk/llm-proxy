/** 统一处理流式代理的客户端取消信号。 */
export async function abortAndCancel(
  signal: AbortSignal | undefined,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onCancelError?: (error: unknown) => void,
): Promise<boolean> {
  if (!signal?.aborted) return false
  try {
    await reader.cancel()
  } catch (error) {
    // 取消失败不应阻止退出循环，但交给调用方记录诊断信息。
    onCancelError?.(error)
  }
  return true
}
