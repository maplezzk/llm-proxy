import type { Context } from 'hono';
import { loadEnv } from '../config/env.js';

export const handleHealth = (c: Context): Response => {
  const env = loadEnv();
  return c.json({
    status: 'ok',
    service: 'llm-proxy',
    time: new Date().toISOString(),
    hasDatabase: Boolean(env.DATABASE_URL),
  });
};
