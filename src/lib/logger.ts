/**
 * Centralized pino logger.
 *
 * - LOG_LEVEL and NODE_ENV sourced via loadEnv() (no scattered process.env reads).
 * - dev (NODE_ENV=development) -> pino-pretty; otherwise structured JSON.
 * - Module-level singleton.
 */
import { pino, type Logger } from 'pino';
import { loadEnv } from '../config/env.js';

const buildLogger = (): Logger => {
  const env = loadEnv();
  if (env.NODE_ENV === 'development') {
    return pino({
      name: 'llm-proxy',
      level: env.LOG_LEVEL,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
      },
    });
  }
  return pino({ name: 'llm-proxy', level: env.LOG_LEVEL });
};

export const log: Logger = buildLogger();
