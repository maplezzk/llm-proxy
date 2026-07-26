import { stream } from 'hono/streaming';
import { z } from 'zod';
import { log } from '../lib/logger.js';
import { pipeReadableStream } from '../lib/proxy-stream.js';
import type { Context } from 'hono';

const ROUTE = 'POST /proxy-sse';
const SSE_CONTENT_TYPE = 'text/event-stream';

const proxyBodySchema = z.object({
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
});

type UpstreamFetch =
  | { ok: true; body: ReadableStream<Uint8Array>; contentType: string }
  | { ok: false; status: number; error: string };

const resolveUpstream = async (
  url: string,
  headers: Record<string, string> | undefined,
): Promise<UpstreamFetch> => {
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: 'GET',
      headers: { Accept: SSE_CONTENT_TYPE, ...(headers ?? {}) },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg, url, op: 'proxy-sse.fetch' }, 'upstream fetch failed');
    return { ok: false, status: 0, error: msg };
  }
  if (!upstream.ok || !upstream.body) {
    return { ok: false, status: upstream.status, error: `upstream returned ${upstream.status}` };
  }
  return {
    ok: true,
    body: upstream.body,
    contentType: upstream.headers.get('content-type') ?? SSE_CONTENT_TYPE,
  };
};

export const handleProxySse = async (c: Context): Promise<Response> => {
  let rawBody: unknown = null;
  let jsonParseError: string | null = null;
  try {
    rawBody = await c.req.json();
  } catch (err: unknown) {
    jsonParseError = err instanceof Error ? err.message : String(err);
  }
  if (jsonParseError) {
    return c.json(
      { error: `bad body for ${ROUTE}`, reason: 'json-parse-failed', detail: jsonParseError },
      400,
    );
  }
  const parsed = proxyBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json(
      { error: `bad body for ${ROUTE}`, reason: 'schema-invalid', issues: parsed.error.issues },
      400,
    );
  }
  const { url, headers } = parsed.data;
  log.info({ url }, 'proxy-sse request');

  const upstream = await resolveUpstream(url, headers);
  if (!upstream.ok) {
    log.error({ url, status: upstream.status, error: upstream.error }, 'proxy-sse failed');
    return c.json(
      { error: `upstream failed for ${ROUTE}`, status: upstream.status, detail: upstream.error },
      502,
    );
  }

  c.header('Content-Type', upstream.contentType);
  c.header('Cache-Control', 'no-cache, no-transform');
  c.header('X-Accel-Buffering', 'no');

  return stream(c, async (s) => {
    try {
      await pipeReadableStream(upstream.body, s);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg, url, route: ROUTE }, 'proxy-sse stream interrupted');
      throw new Error(`proxy-sse pipe failed on ${ROUTE} (url=${url}): ${msg}`, { cause: err });
    }
  });
};
