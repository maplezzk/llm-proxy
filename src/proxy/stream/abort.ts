/** 统一处理流式代理的客户端取消信号。 */

/** race 结果：底层迭代器推进或客户端 abort 哨兵。 */
type AbortableRaceResult<T> =
  | { status: 'next'; result: IteratorResult<T, void> }
  | { status: 'aborted' };

/** 未提供 signal 时使用的挂起 promise：永不 abort，也不创建孤儿 AbortController。 */
function neverAbort(): Promise<never> {
  return new Promise<never>(() => undefined);
}

/** 为 AbortSignal 创建一次性 abort 哨兵；已 abort 时立即解决。 */
function waitForAbort(signal: AbortSignal): Promise<AbortableRaceResult<never>> {
  if (signal.aborted) return Promise.resolve({ status: 'aborted' });
  return new Promise<AbortableRaceResult<never>>((resolve) => {
    signal.addEventListener('abort', () => resolve({ status: 'aborted' }), { once: true });
  });
}

/**
 * 包装帧生成器，使解码编排层可以区分「正常 EOF」与「客户端 abort」。
 *
 * 返回值语义：generator 正常结束时 return false；被 abort 时 return true。
 * abort 后尽力释放底层帧生成器与 ReadableStream；清理失败通过 onCancelError
 * 上报，不掩盖 abort 这一主要结果。source 与 stream 同源时 source.return 先
 * 释放 reader 锁，随后 stream.cancel 才会生效。
 */
export async function* abortableIterator<T>(
  source: AsyncGenerator<T, void>,
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  onCancelError?: (error: unknown) => void,
): AsyncGenerator<T, boolean> {
  const abortPromise = signal ? waitForAbort(signal) : neverAbort();
  try {
    while (true) {
      if (signal?.aborted === true) return true;
      const raceResult = await Promise.race([
        source.next().then((result): AbortableRaceResult<T> => ({ status: 'next', result })),
        abortPromise,
      ]);
      if (raceResult.status === 'aborted') return true;
      if (raceResult.result.done) return false;
      yield raceResult.result.value;
    }
  } finally {
    if (signal?.aborted === true) {
      let cleanupError: unknown;
      try {
        await source.return(undefined);
      } catch (error) {
        cleanupError = error;
      }
      try {
        await stream.cancel();
      } catch (error) {
        cleanupError ??= error;
      }
      if (cleanupError !== undefined) onCancelError?.(cleanupError);
    }
  }
}

/**
 * 旧管线兼容入口：检查 signal 是否已 abort，若是则取消 reader 并返回 true。
 * 新流式适配器优先使用 abortableIterator，以便在等待中的 read 也能被 abort 打断。
 */
export async function abortAndCancel(
  signal: AbortSignal | undefined,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onCancelError?: (error: unknown) => void,
): Promise<boolean> {
  if (!signal?.aborted) return false;
  try {
    await reader.cancel();
  } catch (error) {
    // 取消失败不应阻止退出循环，但交给调用方记录诊断信息。
    onCancelError?.(error);
  }
  return true;
}
