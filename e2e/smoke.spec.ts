/**
 * 冒烟测试（P1.11 更新）：P0 的 /sse、/proxy-sse 占位路由已移除，
 * 改为验证 /health 与代理端点的基本契约（空配置下模型 404）。
 */
import { test, expect } from '@playwright/test';

test('GET /health returns 200 JSON with ok status', async ({ request }) => {
  const res = await request.get('/health');
  expect(res.status()).toBe(200);
  const json = await res.json();
  expect(json).toMatchObject({ status: 'ok' });
  expect(typeof json.time).toBe('string');
});

test('POST /v1/chat/completions with unknown model returns 404 JSON error', async ({ request }) => {
  const res = await request.post('/v1/chat/completions', {
    data: { model: 'no-such-model', messages: [{ role: 'user', content: 'hi' }] },
  });
  expect(res.status()).toBe(404);
  const json = await res.json();
  expect(typeof json.error?.message).toBe('string');
});

test('POST /v1/messages without model returns 400', async ({ request }) => {
  const res = await request.post('/v1/messages', {
    data: { max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
  });
  expect(res.status()).toBe(400);
  const json = await res.json();
  expect(json.error?.message).toContain('model');
});
