/**
 * 统一 pino 日志器。
 *
 * - LOG_LEVEL 与 NODE_ENV 通过 loadEnv() 统一获取，避免散落各处的 process.env。
 * - 开发环境（NODE_ENV=development）走 pino-pretty；其余输出结构化 JSON。
 * - 模块级单例。
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
