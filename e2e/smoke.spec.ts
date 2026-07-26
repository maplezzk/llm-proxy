import { test, expect } from '@playwright/test';

const BASE_URL = process.env.LLM_PROXY_BASE_URL ?? 'http://127.0.0.1:9000';

test('GET /health returns 200 JSON with ok status', async ({ request }) => {
  const res = await request.get('/health');
  expect(res.status()).toBe(200);
  const json = await res.json();
  expect(json).toMatchObject({ status: 'ok' });
  expect(typeof json.time).toBe('string');
});

test('GET /sse streams at least one data: event with text/event-stream content-type', async ({
  request,
}) => {
  const res = await request.get('/sse?count=3&intervalMs=10', {
    headers: { Accept: 'text/event-stream' },
  });
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('text/event-stream');
  const body = await res.text();
  expect(body).toContain('event: open');
  expect(body).toContain('event: tick');
  expect(body).toContain('event: done');
  expect(body).toContain('data:');
});

test('GET /sse rejects out-of-range count with 400', async ({ request }) => {
  const res = await request.get('/sse?count=999');
  expect(res.status()).toBe(400);
  const json = await res.json();
  expect(json.error).toContain('bad query');
});

test('POST /proxy-sse against the local /sse endpoint streams upstream events', async ({
  request,
}) => {
  const res = await request.post('/proxy-sse', {
    data: { url: `${BASE_URL}/sse?count=2&intervalMs=10` },
  });
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('text/event-stream');
  const body = await res.text();
  expect(body).toContain('event: open');
  expect(body).toContain('event: tick');
  expect(body).toContain('event: done');
});

test('POST /proxy-sse returns 400 for malformed body', async ({ request }) => {
  const res = await request.post('/proxy-sse', { data: { url: 'not-a-url' } });
  expect(res.status()).toBe(400);
});
