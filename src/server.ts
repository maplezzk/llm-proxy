/**
 * P0 Hono 服务装配：
 *   middleware chain: req-id → auth（可选 PROXY_KEY）→ request log → 路由
 *
 * Endpoints:
 *   GET  /health      JSON 状态
 *   GET  /sse         server-sent events（zod 校验 count / intervalMs）
 *   POST /proxy-sse   上游 SSE 透传（fetch + zero-copy pipe）
 *   GET  /db/insert   Drizzle 探针插入（需要 DATABASE_URL）
 */
import { serve } from '@hono/node-server';
import { Hono, type Context, type Next } from 'hono';
import { randomUUID } from 'node:crypto';
import { log } from './lib/logger.js';
import { loadEnv } from './config/env.js';
import { handleHealth } from './routes/health.js';
import { handleSse } from './routes/sse.js';
import { handleProxySse } from './routes/proxy-sse.js';
import { handleDbInsert } from './routes/db-insert.js';

const HEADER_REQ_ID = 'x-request-id';
const HEADER_AUTH = 'authorization';
const HEADER_API_KEY = 'x-api-key';

const reqIdMiddleware = async (c: Context, next: Next): Promise<void> => {
  const incoming = c.req.header(HEADER_REQ_ID);
  const reqId = incoming ?? randomUUID();
  c.set('reqId', reqId);
  c.header(HEADER_REQ_ID, reqId);
  await next();
};

const requestLogMiddleware = async (c: Context, next: Next): Promise<void> => {
  const start = Date.now();
  await next();
  log.info(
    {
      reqId: c.get('reqId'),
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durMs: Date.now() - start,
    },
    'request',
  );
};

const proxyKeyAuthMiddleware = async (c: Context, next: Next): Promise<Response | undefined> => {
  const env = loadEnv();
  if (!env.PROXY_KEY) {
    await next();
    return undefined;
  }
  const auth = c.req.header(HEADER_AUTH);
  const provided =
    auth && auth.startsWith('Bearer ') ? auth.slice(7) : (c.req.header(HEADER_API_KEY) ?? '');
  if (provided !== env.PROXY_KEY) {
    return c.json({ error: 'invalid proxy key' }, 401);
  }
  await next();
  return undefined;
};

export const buildApp = (): Hono => {
  const app = new Hono();
  app.use('*', reqIdMiddleware);
  app.use('*', requestLogMiddleware);
  app.use('/proxy-sse', proxyKeyAuthMiddleware);

  app.get('/health', handleHealth);
  app.get('/sse', handleSse);
  app.post('/proxy-sse', handleProxySse);
  app.get('/db/insert', handleDbInsert);
  return app;
};

export interface StartServerOptions {
  port: number;
  host: string;
}

export const startServer = (opts: StartServerOptions): { server: ReturnType<typeof serve> } => {
  const app = buildApp();
  const server = serve(
    { fetch: app.fetch, port: opts.port, hostname: opts.host },
    (info) => {
      log.info({ port: info.port, host: info.address, pid: process.pid }, 'server listening');
    },
  );
  return { server };
};

export default buildApp;
