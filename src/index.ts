#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
/**
 * llm-proxy CLI entry (citty skeleton).
 *
 * Subcommands:
 *   start      boot Hono server (auto-runs migrate unless --skip-migrate)
 *   stop       graceful stop via pid file
 *   restart    stop + start
 *   reload     hot-reload config (P1 hook)
 *   migrate    run drizzle migrate only, no HTTP
 *
 * Design:
 * - Core orchestration is in plain async functions (executeStart/Stop/Restart/...).
 * - citty commands are thin wrappers: they only parse args and dispatch.
 * - SIGTERM uses process.exit(0) because SSE long-poll blocks server.close().
 */
import { defineCommand, runMain } from 'citty';
import { loadEnv } from './config/env.js';
import { ConfigStore } from './config/store.ts';
import { runMigrations } from './db/migrate.js';
import { log } from './lib/logger.js';
import { CaptureBuffer } from './proxy/capture-store.ts';
import type { PipelineDeps } from './proxy/pipeline.ts';
import { startServer } from './server.js';
import { UsageStore } from './status/usage-store.ts';

const DEFAULT_PID_PATH = '/tmp/llm-proxy.pid';
const DEFAULT_HOST = '127.0.0.1';
const PID_RESTART_GRACE_MS = 300;
const VALID_PORT_MIN = 1;
const VALID_PORT_MAX = 65535;

interface ProxyState {
  pid: number;
  port: number;
  startedAt: number;
}

const readState = (pidPath: string): ProxyState | null => {
  try {
    const raw = readFileSync(pidPath, 'utf-8').trim();
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as ProxyState).pid === 'number' &&
      typeof (parsed as ProxyState).port === 'number' &&
      (parsed as ProxyState).pid > 0 &&
      (parsed as ProxyState).port >= VALID_PORT_MIN &&
      (parsed as ProxyState).port <= VALID_PORT_MAX
    ) {
      return parsed as ProxyState;
    }
    return null;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err: msg, pidPath }, 'failed to read pid file; treating as not running');
    return null;
  }
};

const writeState = (pidPath: string, state: ProxyState): void => {
  mkdirSync(dirname(pidPath), { recursive: true });
  writeFileSync(pidPath, JSON.stringify(state));
};

const removeState = (pidPath: string): void => {
  if (!existsSync(pidPath)) return;
  unlinkSync(pidPath);
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.debug({ err: msg, pid }, 'isAlive check failed; treating as not alive');
    return false;
  }
};

const parseListenAddress = (host: string, portRaw?: string): { host: string; port?: number } => {
  if (!host || host.trim().length === 0) {
    throw new Error('host must not be empty');
  }
  // 未传 --port 时返回 undefined，由 executeStart 按 config.port → PORT env → 9000 兜底
  if (portRaw === undefined || portRaw === '') {
    return { host, port: undefined };
  }
  const port = Number(portRaw);
  if (Number.isNaN(port) || port < VALID_PORT_MIN || port > VALID_PORT_MAX) {
    throw new Error(`invalid port: ${portRaw}`);
  }
  return { host, port };
};

const registerShutdownHandlers = (pidPath: string): void => {
  const shutdown = (signal: NodeJS.Signals): void => {
    log.info({ signal, pid: process.pid }, 'shutting down');
    removeState(pidPath);
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
};

const runStartupMigration = async (): Promise<void> => {
  if (!loadEnv().DATABASE_URL) {
    log.warn('DATABASE_URL not set; skipping migrations');
    return;
  }
  await runMigrations();
};

const blockForever = (): Promise<never> => new Promise<never>(() => {});

/** 默认配置路径：$LLM_PROXY_CONFIG 或 ~/.llm-proxy/config.yaml。 */
const resolveConfigPath = (): string =>
  process.env.LLM_PROXY_CONFIG || join(homedir(), '.llm-proxy', 'config.yaml');

/**
 * 装配管线依赖：YAML ConfigStore（缺失时回退空配置）+ 内存 UsageStore + CaptureBuffer。
 * PG 持久化配置是 P1.16，用量持久化是 P4/P5。
 */
const buildPipelineDeps = async (configPath: string): Promise<PipelineDeps> => {
  let store: ConfigStore;
  if (existsSync(configPath)) {
    store = await ConfigStore.create(configPath);
    log.info({ configPath }, 'config loaded');
  } else {
    store = ConfigStore.fromMemory({ providers: [] }, configPath);
    log.warn({ configPath }, 'config file not found; starting with empty config (all models 404)');
  }
  const { config } = store.getConfig();
  const capture = new CaptureBuffer(config.captureMaxSize ?? 100);
  return { store, logger: log, usage: new UsageStore(), capture };
};

export const executeStart = async (opts: {
  host: string;
  port?: number;
  pidPath: string;
  skipMigrate: boolean;
  configPath: string;
}): Promise<void> => {
  if (!opts.skipMigrate) {
    await runStartupMigration();
  }
  const pipeline = await buildPipelineDeps(opts.configPath);
  // 端口优先级：--port 显式参数 > config.yaml port > PORT 环境变量 > 默认 9000（loadEnv 兜底）
  const { config } = pipeline.store.getConfig();
  const port = opts.port ?? config.port ?? loadEnv().PORT;
  if (!Number.isInteger(port) || port < VALID_PORT_MIN || port > VALID_PORT_MAX) {
    throw new Error(`invalid port: ${port}`);
  }
  const { server } = startServer({ port, host: opts.host, pipeline });
  writeState(opts.pidPath, { pid: process.pid, port, startedAt: Date.now() });
  log.info({ pid: process.pid, port, host: opts.host, pidPath: opts.pidPath }, 'llm-proxy started');
  registerShutdownHandlers(opts.pidPath);
  void server;
  await blockForever();
};

export const executeStop = (pidPath: string): void => {
  const state = readState(pidPath);
  if (!state) {
    log.info({ pidPath }, 'no pid file; nothing to stop');
    return;
  }
  if (!isAlive(state.pid)) {
    log.info({ pid: state.pid, pidPath }, 'pid not alive; cleaning stale pid file');
    removeState(pidPath);
    return;
  }
  process.kill(state.pid, 'SIGTERM');
  log.info({ pid: state.pid, pidPath }, 'sent SIGTERM');
};

export const executeReload = (pidPath: string): void => {
  const state = readState(pidPath);
  if (!state || !isAlive(state.pid)) {
    log.warn({ pidPath }, 'no live process to reload');
    return;
  }
  log.info({ pid: state.pid }, 'reload signal sent (SIGHUP)');
  process.kill(state.pid, 'SIGHUP');
};

const startCommand = defineCommand({
  meta: { name: 'start', description: '启动 llm-proxy HTTP 服务' },
  args: {
    host: { type: 'string', default: DEFAULT_HOST },
    port: {
      type: 'string',
      description: '监听端口（缺省依次取 config.yaml port、PORT 环境变量，最后 9000）',
    },
    'pid-path': { type: 'string', default: DEFAULT_PID_PATH },
    'skip-migrate': { type: 'boolean', default: false },
    config: { type: 'string', default: '' },
  },
  async run({ args }) {
    const { host, port } = parseListenAddress(args.host, args.port);
    const configPath = args.config || resolveConfigPath();
    await executeStart({
      host,
      port,
      pidPath: args['pid-path'],
      skipMigrate: args['skip-migrate'],
      configPath,
    });
  },
});

const stopCommand = defineCommand({
  meta: { name: 'stop', description: '停止 llm-proxy 服务（按 pid 文件）' },
  args: { 'pid-path': { type: 'string', default: DEFAULT_PID_PATH } },
  run({ args }) {
    executeStop(args['pid-path']);
  },
});

const restartCommand = defineCommand({
  meta: { name: 'restart', description: '重启 llm-proxy' },
  args: {
    host: { type: 'string', default: DEFAULT_HOST },
    port: {
      type: 'string',
      description: '监听端口（缺省依次取 config.yaml port、PORT 环境变量，最后 9000）',
    },
    'pid-path': { type: 'string', default: DEFAULT_PID_PATH },
    config: { type: 'string', default: '' },
  },
  async run({ args }) {
    executeStop(args['pid-path']);
    await new Promise((r) => setTimeout(r, PID_RESTART_GRACE_MS));
    const { host, port } = parseListenAddress(args.host, args.port);
    const configPath = args.config || resolveConfigPath();
    await executeStart({ host, port, pidPath: args['pid-path'], skipMigrate: false, configPath });
  },
});

const reloadCommand = defineCommand({
  meta: { name: 'reload', description: '热加载配置（P1 接入 config store）' },
  args: { 'pid-path': { type: 'string', default: DEFAULT_PID_PATH } },
  run({ args }) {
    executeReload(args['pid-path']);
  },
});

const migrateCommand = defineCommand({
  meta: { name: 'migrate', description: '只跑 drizzle migrate，不启 HTTP' },
  args: {},
  async run() {
    await runMigrations();
  },
});

const main = defineCommand({
  meta: { name: 'llm-proxy', description: '本地统一 LLM 模型代理' },
  subCommands: {
    start: startCommand,
    stop: stopCommand,
    restart: restartCommand,
    reload: reloadCommand,
    migrate: migrateCommand,
  },
});

runMain(main);
