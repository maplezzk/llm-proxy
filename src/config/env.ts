/**
 * 启动期环境变量校验（Zod）。运行时配置的唯一可信来源。
 *
 * - DATABASE_URL：db client 必需；缺失时 getDb() 抛出异常。
 * - PORT：Hono 监听端口，默认 9000。
 * - PROXY_KEY：可选；设置后，/proxy-sse 要求带 Authorization 或 x-api-key。
 * - LOG_LEVEL：debug | info | warn | error，默认 info。
 * - NODE_ENV：可选，默认 'production'。决定 pino-pretty 还是 JSON 输出。
 *
 * 为什么要用类型化并缓存的 env：
 * - 所有下游模块统一通过 `loadEnv()` 一次读取，避免散落各处的 process.env。
 * - 测试可以 `resetEnvCache()` 后用 stub 调用 `loadEnv({ ... })`。
 */
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().url().optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(9000),
  // 空字符串视为「未设置 key」（等价于 undefined）。
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
