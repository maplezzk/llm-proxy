import { randomUUID } from 'node:crypto';
/**
 * Hono 服务装配（P1.11）：
 *   middleware chain: req-id → request log → 路由
 *
 * Endpoints:
 *   GET  /health                 JSON 状态
 *   GET  /db/insert              Drizzle 探针插入（需要 DATABASE_URL）
 *   POST /v1/messages            Anthropic 代理入站
 *   POST /v1/chat/completions    OpenAI Chat 代理入站
 *   POST /v1/responses           OpenAI Responses 代理入站
 *   POST /{name}/v1/*            适配器虚拟端点
 *
 * 代理认证在管线 parseAndAuth 中执行（config.proxyKey 优先，env PROXY_KEY 回退）；
 * P0 的 /sse、/proxy-sse 占位路由已移除。
 */
import { serve } from '@hono/node-server';
import { type Context, Hono, type Next } from 'hono';
import { ConfigStore } from './config/store.ts';
import { log } from './lib/logger.ts';
import type { PipelineDeps } from './proxy/pipeline.ts';
import { createProxyRoutes } from './proxy/routes.ts';
import { handleDbInsert } from './routes/db-insert.js';
import { handleHealth } from './routes/health.js';

const HEADER_REQ_ID = 'x-request-id';

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

export interface BuildAppOptions {
  /** 管线依赖（store/usage/capture/logger）；不传则用空配置 store（所有模型 404）。 */
  pipeline?: PipelineDeps;
}

export const buildApp = (opts: BuildAppOptions = {}): Hono => {
  const app = new Hono();
  app.use('*', reqIdMiddleware);
  app.use('*', requestLogMiddleware);

  app.get('/health', handleHealth);
  app.get('/db/insert', handleDbInsert);

  // 代理管线端点（直连 + 适配器）
  const deps: PipelineDeps = opts.pipeline ?? {
    store: emptyStore(),
    logger: log,
  };
  app.route('/', createProxyRoutes({ logger: log, ...deps }));

  return app;
};

/** 无配置文件回退：空配置 store（所有模型路由 404）。 */
const emptyStore = (): ConfigStore => ConfigStore.fromMemory({ providers: [] });

export interface StartServerOptions {
  port: number;
  host: string;
  pipeline?: PipelineDeps;
}

export const startServer = (opts: StartServerOptions): { server: ReturnType<typeof serve> } => {
  const app = buildApp({ pipeline: opts.pipeline });
  const server = serve({ fetch: app.fetch, port: opts.port, hostname: opts.host }, (info) => {
    log.info({ port: info.port, host: info.address, pid: process.pid }, 'server listening');
  });
  return { server };
};

export default buildApp;
