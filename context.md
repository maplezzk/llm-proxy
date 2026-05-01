# Code Context

## Files Retrieved
1. `CLAUDE.md` (full) - project overview, conventions, protocol translation notes
2. `package.json` (full) - Node.js >= 20, ESM, deps: alpinejs + yaml, dev: tsx/esbuild/TypeScript
3. `tsconfig.json` (full) - strict mode, ES2022 target, NodeNext module resolution
4. `src/index.ts` (lines 1-74) - CLI entry point, command dispatch
5. `src/proxy/handlers.ts` (lines 1-144) - proxy request entry (auth → route → transform → forward)
6. `src/proxy/router.ts` (lines 1-28) - model name → Provider lookup
7. `src/proxy/types.ts` (lines 1-7) - RouterResult interface
8. `src/proxy/translation.ts` (lines 1-100, top of 937) - protocol conversion exports, helpers, tool conversion
9. `src/proxy/stream-converter.ts` (lines 1-100+, top of 1140) - SSE streaming converters, 4+ converters
10. `src/proxy/provider.ts` (lines 1-80, top of 251) - forwardRequest, curl generation, response conversion dispatch
11. `src/proxy/capture.ts` (lines 1-74) - request/response capture with ring buffer + SSE push
12. `src/api/server.ts` (lines 1-152) - HTTP routing via regex table, creates ServerContext
13. `src/adapter/handlers.ts` (lines 1-164) - adapter virtual endpoint handler, mirrors proxy handler
14. `src/config/types.ts` (lines 1-73) - Config/Provider/Adapter type definitions
15. `src/config/store.ts` (lines 1-66) - ConfigStore with mutex-protected reload + write
16. `src/lib/http-utils.ts` (lines 1-14) - readBody helper, default API base URLs
17. `docs/architecture.md` (lines 1-60) - mermaid architecture diagram, module overview

## File Size Summary
| File | Lines | Role |
|------|-------|------|
| `src/proxy/stream-converter.ts` | 1140 | 4 SSE converters (Anthropic↔OpenAI↔Responses) |
| `src/proxy/translation.ts` | 937 | Request/response body protocol conversion |
| `src/proxy/provider.ts` | 251 | forwardRequest: fetch + response dispatch |
| `src/api/server.ts` | 152 | Regex-based HTTP routing |
| `src/adapter/handlers.ts` | 164 | Adapter virtual endpoint (duplicates proxy pattern) |
| `src/proxy/handlers.ts` | 144 | Proxy request handler (auth/route/transform/forward) |
| `test/**/*.ts` | 2123 | 13 test files, 115 tests total |
| **Total src/** | **~5500** | |

## Key Code

### Core Types
```ts
// src/proxy/types.ts
export interface RouterResult {
  providerName: string
  providerType: 'anthropic' | 'openai' | 'openai-responses'
  apiKey: string
  apiBase: string
  modelId: string
}

// src/config/types.ts
export type ProviderType = 'anthropic' | 'openai' | 'openai-responses'
export interface Config {
  providers: Provider[]
  adapters?: AdapterConfig[]
  proxyKey?: string
  logLevel?: LogLevel
}
```

### Data Flow (proxy request)
```
HTTP POST /v1/messages → api/server.ts ROUTES regex match
  → proxy/handlers.ts handleAnthropicMessages()
    → checkProxyAuth() → readBody() → JSON.parse
    → routeModel(store, modelName) → RouterResult
    → transformInboundRequest(inboundType, route, body, logger) → { url, headers, body, crossProtocol }
    → forwardRequest({ url, method, headers, body, crossProtocol, ... }, res)
      → if streaming: pipe through SSE converter (e.g., convertAnthropicStreamToOpenAI)
      → if non-streaming: convert response JSON (e.g., convertOpenAIResponseToAnthropic)
```

### Protocol Conversion Functions (translation.ts)
- `transformInboundRequest(inboundType, route, body, logger)` — dispatches to specific converter
- `convertAnthropicMessagesToXxx()` / `convertOpenAIChatToXxx()` / `convertOpenAIResponsesToXxx()` — request body conversion
- `convertXxxResponseToYyy()` — response body conversion (6 functions for cross-protocol)

### SSE Converters (stream-converter.ts)
- `convertAnthropicStreamToOpenAI` — Anthropic SSE → OpenAI Chat SSE
- `convertOpenAIStreamToAnthropic` — OpenAI Chat SSE → Anthropic SSE
- `convertOpenAIResponsesStreamToAnthropic` — OpenAI Responses SSE → Anthropic SSE
- `convertAnthropicStreamToOpenAIResponses` — Anthropic SSE → OpenAI Responses SSE
- `convertOpenAIStreamToOpenAIResponses` — OpenAI Chat ↔ Responses (same protocol family)
- `convertOpenAIResponsesStreamToOpenAI`

Key patterns: Accumulator tracks role/content/thinking/toolCalls across SSE events. `rawLines` + `outLines` arrays capture timestamped SSE for debug. `makeSignature(thinkingText)` generates SHA-256 deterministic pseudo-signature for cross-protocol thinking blocks.

### Routing (api/server.ts)
Single flat array of `Route[]` objects with `method`, `pattern: RegExp`, `handler`. Route match order: admin routes first, then adapter models, then proxy endpoint patterns, finally adapter request pattern (last). Adapter route `/{name}/v1/(messages|chat/completions|responses)` must be ordered after `/v1/models` to avoid false matches.

## Architecture

```
CLI (index.ts → commands.ts)
  └─ createProxyServer(ConfigStore, Logger, StatusTracker, TokenTracker, CaptureBuffer?)
       ├─ Admin UI: Alpine.js SPA served as static HTML/JS
       ├─ Admin API: /admin/* → CRUD handlers for config/providers/adapters/logs/tokens/capture
       ├─ Proxy API: /v1/messages, /v1/chat/completions, /v1/responses
       └─ Adapter API: /{name}/v1/{messages,chat/completions,responses}
```

No framework — pure `node:http`. Single port (default 9000) for everything. Config is YAML, loaded at startup, hot-reloadable via `POST /admin/config/reload` or `llm-proxy reload`.

Adapter layer creates virtual endpoints that look like independent providers but map to real provider models — used for tool-aware routing (`/{adapterName}/v1/...` → resolved `RouterResult` → proxy).

## Notable Patterns & Conventions
- **Chinese commit messages** (`feat: 描述`, `fix: 描述`)
- **Feature branch naming**: `feature/<描述>`
- **Strict TypeScript** with ESM NodeNext resolution
- **No external HTTP framework** — raw `node:http` with regex route matching
- **SimpleMutex** in ConfigStore for safe concurrent reloads
- **Ring buffer** capture (200 entries max) with SSE push to subscribers
- **Token stats tracked in-memory only** — no persistence
- **Test runner**: `node --import tsx --test` (Node.js native test runner)
- **All converters are pure functions** that operate on parsed JSON — no side effects in translation, only in provider.ts (network)

## Pain Points & Gaps

1. **Monolithic converter files**: `translation.ts` (937 lines) and `stream-converter.ts` (1140 lines) are single files handling all 3 protocols. Hard to navigate, test, and extend.

2. **Adapter handler duplicates proxy handler**: `adapter/handlers.ts` copies auth, readBody, JSON parse, model lookup, error handling patterns verbatim from `proxy/handlers.ts`. Only differs in route resolution (`resolveAdapterRoute` vs `routeModel`).

3. **No body size limit**: `readBody()` buffers entire request body in memory — no protection against multi-MB payloads.

4. **Regex routing fragility**: Route ordering in `api/server.ts` ROUTES array matters for correctness. The adapter pattern `/([a-zA-Z0-9_-]+)/v1/...` could shadow proxy routes if not carefully ordered.

5. **provider.ts imports all converters**: `forwardRequest()` statically imports all 6 stream converter functions regardless of which path is taken.

6. **No rate limiting or timeout**: No per-client or per-provider rate limiting. No upstream request timeout beyond Node default.

7. **No response streaming for non-200 responses**: Error paths use `res.end(JSON.stringify(...))` — no SSE streaming, so cross-protocol error messages may not reach the client in streaming mode.

8. **Config reload race**: In-flight requests use the old config snapshot, but a concurrent `writeConfig` could mutate state mid-request (mitigated by SimpleMutex but not atomic copy-on-read).

9. **Token tracking is in-memory only**: Restart loses all token stats.

10. **No OpenTelemetry/metrics export**: No way to integrate with monitoring systems.

## Leverage Points for Improvement

1. **Split translation.ts by protocol pair**: Separate `anthropic-openai.ts`, `anthropic-responses.ts`, `openai-responses.ts` — each ~200-300 lines, independently testable.

2. **Split stream-converter.ts similarly**: One file per conversion direction.

3. **Extract shared proxy request pipeline**: Factor out auth + body parse + model lookup from both `proxy/handlers.ts` and `adapter/handlers.ts` into a shared `resolveRequest()` function.

4. **Add body size limit to readBody**: Simple `maxBytes` parameter (e.g., 1MB default).

5. **Consider middleware-style routing**: Replace flat array with a composable pipeline (but keep it simple — no need for Express).

6. **Dynamic converter imports**: `provider.ts` could dynamically import only the needed SSE converter.

7. **Add request timeout**: AbortController with configurable timeout for upstream fetches.

8. **Add /health endpoint depth**: Current health check is shallow — could probe provider endpoints.

9. **Watch mode for config**: `fs.watch` on config.yaml for automatic reload instead of manual `llm-proxy reload`.

## Start Here
Open `src/proxy/handlers.ts` — it's the central orchestrator for all proxy requests. From there, follow the call chain: `routeModel()` → `transformInboundRequest()` → `forwardRequest()`. Then open `src/proxy/translation.ts` to understand the protocol conversion dispatch, and `src/proxy/stream-converter.ts` for SSE streaming logic.
