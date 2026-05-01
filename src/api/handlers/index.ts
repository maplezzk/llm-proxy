import type { ServerResponse } from 'node:http'

export function json(res: ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

export { handleGetConfig, handleReload, handleHealth, handleStatus, handleGetLogs, handleGetLogLevel, handleSetLogLevel, handleGetProxyKey, handleSetProxyKey, handleGetTokenStats, handleDebugCaptures, handleDebugCapturesStream } from './base.js'
export { handleCreateProvider, handleUpdateProvider, handleDeleteProvider } from './provider-crud.js'
export { handleGetAdapters, handleCreateAdapter, handleUpdateAdapter, handleDeleteAdapter } from './adapter-crud.js'
export { handleTestModel, handleTestAdapter, handleListModels, handlePullModels } from './model-handlers.js'
