/**
 * 代理端点 Hono 路由（P1.11）。
 *
 * 直连：
 *   POST /v1/messages            Anthropic 入站
 *   POST /v1/chat/completions    OpenAI Chat 入站
 *   POST /v1/responses           OpenAI Responses 入站
 * 适配器虚拟端点（legacy-src/adapter/handlers.ts 路径契约）：
 *   POST /{name}/v1/messages | chat/completions | responses
 *   GET  /{name}/v1/models
 *
 * 入站协议由请求路径决定（与 legacy 一致；adapter.type 仅用于配置校验）。
 * 路由失败映射：模型未找到 → 404；ADAPTER_NOT_FOUND / MODEL_MAPPING_NOT_FOUND → 404；
 * 其余适配器错误 → 502。
 */
import { type Context, Hono } from 'hono';
import { loadEnv } from '../config/env.ts';
import type { RouteDecision } from './adapters/index.ts';
import type { ClientProtocol } from './ir/types.ts';
import { type PipelineDeps, forwardPipeline, jsonError, parseAndAuth } from './pipeline.ts';
import {
  AdapterError,
  type AdapterRouteResult,
  resolveAdapterRoute,
  routeModel,
  selectRoute,
} from './router.ts';

/** 直连端点处理器工厂。 */
const proxyHandler =
  (deps: PipelineDeps, clientProtocol: ClientProtocol) =>
  async (c: Context): Promise<Response> => {
    const rawBody = await c.req.raw.text();
    const pre = parseAndAuth(deps, rawBody, c.req.raw.headers);
    if (pre instanceof Response) return pre;

    let route: RouteDecision;
    try {
      route = routeModel(deps.store, pre.modelName);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.logger?.warn({ model: pre.modelName, clientProtocol, err: message }, 'model not found');
      return jsonError(404, message);
    }

    return forwardPipeline(deps, {
      clientProtocol,
      wireBody: pre.wireBody,
      rawBody,
      route,
      signal: c.req.raw.signal,
    });
  };

/** 适配器端点处理器工厂（入站协议由路径决定）。 */
const adapterHandler =
  (deps: PipelineDeps, clientProtocol: ClientProtocol) =>
  async (c: Context): Promise<Response> => {
    const adapterName = c.req.param('name') ?? '';
    const rawBody = await c.req.raw.text();
    const pre = parseAndAuth(deps, rawBody, c.req.raw.headers);
    if (pre instanceof Response) return pre;

    let resolved: AdapterRouteResult;
    try {
      resolved = resolveAdapterRoute(deps.store, adapterName, pre.modelName);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status =
        err instanceof AdapterError &&
        (err.code === 'ADAPTER_NOT_FOUND' ||
          err.code === 'MODEL_MAPPING_NOT_FOUND' ||
          err.code === 'ROUTE_GROUP_NOT_FOUND' ||
          err.code === 'CHANNEL_NOT_FOUND')
          ? 404
          : 502;
      deps.logger?.warn(
        { adapter: adapterName, model: pre.modelName, err: message },
        'adapter route failed',
      );
      return jsonError(status, message);
    }

    // U3: selectRoute 从候选中选一个 + 取出 alternatives 透传 forwardPipeline（U6 failover 用）
    const { selected, alternatives } = selectRoute(resolved.routes);

    return forwardPipeline(deps, {
      clientProtocol,
      wireBody: pre.wireBody,
      rawBody,
      route: selected,
      alternatives,
      adapterName,
      signal: c.req.raw.signal,
    });
  };

/** 适配器模型列表（legacy handleAdapterModels 等价）。 */
const adapterModelsHandler =
  (deps: PipelineDeps) =>
  (c: Context): Response => {
    const adapterName = c.req.param('name') ?? '';
    const { config } = deps.store.getConfig();
    const adapter = config.adapters?.find((a) => a.name === adapterName);
    if (!adapter) {
      return jsonError(404, `适配器 "${adapterName}" 未找到`);
    }
    const now = Math.floor(Date.now() / 1000);
    const models = adapter.models.map((m) => ({
      id: m.sourceModelId,
      object: 'model',
      created: now,
      owned_by: adapterName,
    }));
    return new Response(JSON.stringify({ object: 'list', data: models }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  };

/**
 * 创建代理路由子应用。
 * fallbackProxyKey 默认取 env PROXY_KEY（P0 行为兼容），config.proxyKey 优先。
 */
export const createProxyRoutes = (deps: PipelineDeps): Hono => {
  const withFallback: PipelineDeps = {
    ...deps,
    fallbackProxyKey: deps.fallbackProxyKey ?? loadEnv().PROXY_KEY,
  };
  const app = new Hono();

  // 直连三协议
  app.post('/v1/messages', proxyHandler(withFallback, 'anthropic'));
  app.post('/v1/chat/completions', proxyHandler(withFallback, 'openai'));
  app.post('/v1/responses', proxyHandler(withFallback, 'openai-responses'));

  // 适配器虚拟端点（name 约束与 legacy ADAPTER_PATH_RE 一致：字母数字下划线中划线）
  const namePattern = '[a-zA-Z0-9_-]+';
  app.post(`/:name{${namePattern}}/v1/messages`, adapterHandler(withFallback, 'anthropic'));
  app.post(`/:name{${namePattern}}/v1/chat/completions`, adapterHandler(withFallback, 'openai'));
  app.post(`/:name{${namePattern}}/v1/responses`, adapterHandler(withFallback, 'openai-responses'));
  app.get(`/:name{${namePattern}}/v1/models`, adapterModelsHandler(withFallback));

  return app;
};
