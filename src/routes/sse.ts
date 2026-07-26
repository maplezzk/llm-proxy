import { streamSSE, type SSEStreamingApi } from 'hono/streaming';
import { z, type ZodIssue } from 'zod';
import { log } from '../lib/logger.js';
import type { Context } from 'hono';

const ROUTE = 'GET /sse';

const sseQuerySchema = z.object({
  count: z.coerce.number().int().min(1).max(50).default(5),
  intervalMs: z.coerce.number().int().min(0).max(2000).default(100),
});

type SseQuery = z.infer<typeof sseQuerySchema>;
type ParseResult =
  | { ok: true; value: SseQuery }
  | { ok: false; code: 'VALIDATION_ERROR'; fields: string[]; issues: ZodIssue[] };

const parseSseQuery = (raw: Record<string, string | undefined>): ParseResult => {
  const parsed = sseQuerySchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      fields: parsed.error.issues.map((i) => i.path.join('.')),
      issues: parsed.error.issues,
    };
  }
  return { ok: true, value: parsed.data };
};

const runSseStages = async (
  stream: SSEStreamingApi,
  count: number,
  intervalMs: number,
): Promise<void> => {
  await stream.writeSSE({
    event: 'open',
    data: JSON.stringify({ t: Date.now() }),
  });
  for (let i = 1; i <= count; i++) {
    if (stream.aborted) return;
    await new Promise((r) => setTimeout(r, intervalMs));
    await stream.writeSSE({
      id: String(i),
      event: 'tick',
      data: JSON.stringify({ i, msg: `event-${i}` }),
    });
  }
  if (!stream.aborted) {
    await stream.writeSSE({ event: 'done', data: '[DONE]' });
  }
};

export const handleSse = (c: Context): Response => {
  const parsed = parseSseQuery(c.req.query());
  if (!parsed.ok) {
    log.warn({ route: ROUTE, fields: parsed.fields }, 'rejecting bad query');
    return c.json(
      { error: `bad query for ${ROUTE}`, code: parsed.code, fields: parsed.fields, issues: parsed.issues },
      400,
    );
  }
  const { count, intervalMs } = parsed.value;

  return streamSSE(c, async (stream) => {
    stream.onAbort(() => log.info({ route: ROUTE }, 'client aborted sse'));
    try {
      await runSseStages(stream, count, intervalMs);
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      log.error(
        { err: reason, route: ROUTE, count, intervalMs, stage: 'write' },
        'sse stream write failed',
      );
      if (!stream.aborted) {
        await stream
          .writeSSE({ event: 'error', data: `stream interrupted: ${reason}` })
          .catch((writeErr: unknown) => {
            const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
            log.warn({ err: msg, route: ROUTE }, 'failed to write error event');
            throw new Error(`failed to write error event on ${ROUTE}: ${msg}`, { cause: writeErr });
          });
      }
      throw new Error(`SSE write failed on ${ROUTE} (count=${count}): ${reason}`, { cause: err });
    }
  });
};
