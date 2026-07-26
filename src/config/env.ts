/**
 * Startup env validation (Zod). Single source of truth for runtime config.
 *
 * - DATABASE_URL: required by db client; missing -> getDb() throws.
 * - PORT: Hono listen port, default 9000.
 * - PROXY_KEY: optional; when set, /proxy-sse requires Authorization or x-api-key.
 * - LOG_LEVEL: debug | info | warn | error, default info.
 * - NODE_ENV: optional; default 'production'. Drives pino-pretty vs JSON output.
 *
 * Why a typed cached env:
 * - All downstream modules import `loadEnv()` once; no scattered process.env reads.
 * - Tests can `resetEnvCache()` then call `loadEnv({ ... })` with a stub.
 */
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().url().optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(9000),
  // Empty string is treated as "no key set" (equivalent to undefined).
  PROXY_KEY: z.preprocess(
    (v) => (typeof v === 'string' && v.length === 0 ? undefined : v),
    z.string().min(1).optional(),
  ),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export const loadEnv = (source: NodeJS.ProcessEnv = process.env): Env => {
  if (cached) return cached;
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.'));
    throw new Error(
      `env validation failed: ${fields.join(', ')}; issues=${JSON.stringify(parsed.error.issues)}`,
    );
  }
  cached = parsed.data;
  return cached;
};

export const resetEnvCache = (): void => {
  cached = null;
};
