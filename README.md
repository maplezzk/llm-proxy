# llm-proxy

[English](./README.md) | [简体中文](./README.zh.md)

A local LLM proxy server — single port serving both admin UI and AI API, with multi-protocol routing, protocol translation, streaming SSE conversion, token tracking, and protocol capture debugging.

## Features

- 🔀 **Multi-Protocol**: Anthropic, OpenAI, and OpenAI Responses on a single port
- 🔄 **Protocol Translation**: Bidirectional conversion across all three protocols (streaming + non-streaming)
- 🖥️ **macOS App**: Native menu bar app with built-in proxy — zero dependencies, drag & drop install
- 📊 **Admin UI**: Alpine.js SPA with dashboard, provider management, adapter config, and capture debugger
- 🎯 **Virtual Adapters**: Custom endpoints with model remapping (`/{adapter-name}/v1/...`)
- 📡 **SSE Streaming**: 4 bidirectional stream converters with per-line timestamps
- 🔍 **Protocol Capture**: Ring buffer recording raw request/response pairs with side-by-side diff
- 🔥 **Hot Reload**: Atomic config swap without dropping in-flight requests
- 📈 **Token Tracking**: Per-provider token usage statistics

## Install

**macOS (recommended):**
Download `LLMProxy.dmg` from [Releases](https://github.com/maplezzk/llm-proxy/releases), drag to `/Applications`. If macOS blocks the app, run:
```bash
xattr -cr /Applications/LLMProxy.app
```
Then open again. Includes everything — CLI, proxy, and admin UI.

**CLI only:**
```bash
npm install -g @maplezzk/llm-proxy
```

## Quick Start

```bash
# Start proxy
llm-proxy start

# Open admin UI → http://127.0.0.1:9000/admin/
```

首次启动会自动创建配置目录。打开管理页面后，你可以直接在网页中添加 AI 供应商、配置适配器、设置代理密钥等，无需手动编辑 YAML 文件。

管理页面支持：
- **Provider 管理**：添加/编辑/删除 AI 供应商，支持从 API 拉取模型列表
- **Adapter 配置**：创建虚拟端点，实现模型映射和多协议适配
- **代理密钥**：设置 API 认证密钥
- **在线测试**：直接发送测试请求验证配置
- **协议抓包**：实时查看请求/响应报文

## Configuration

`~/.llm-proxy/config.yaml`:

```yaml
log_level: debug          # debug | info | warn | error
proxy_key: sk-xxx         # Optional: if set, /v1/* requires auth

providers:
  - name: deepseek
    type: openai          # anthropic | openai | openai-responses
    api_key: ${DEEPSEEK_API_KEY}
    api_base: https://api.deepseek.com
    models:
      - id: deepseek-chat

  - name: anthropic
    type: anthropic
    api_key: ${ANTHROPIC_API_KEY}
    models:
      - id: claude-sonnet-4

adapters:
  - name: my-tool
    type: anthropic
    models:
      - sourceModelId: claude-sonnet-4
        provider: anthropic
        targetModelId: claude-sonnet-4-20250514
```

API keys use environment variable interpolation (`${VAR}`) — never stored in plain text.

## CLI

```bash
llm-proxy start     # Start proxy server
llm-proxy stop      # Stop proxy server
llm-proxy restart   # Restart
llm-proxy reload    # Hot-reload config
llm-proxy status    # Show status
```

## Admin API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/admin/config` | GET | Current config (keys redacted) |
| `/admin/config/reload` | POST | Hot-reload config |
| `/admin/health` | GET | Health check |
| `/admin/status/providers` | GET | Provider stats |
| `/admin/logs` | GET | Request logs |
| `/admin/logs/stats` | GET | Log statistics |
| `/admin/token-stats` | GET | Token usage stats |

## Protocol Translation Matrix

| Source | Target | Non-streaming | Streaming (SSE) |
|--------|--------|:---:|:---:|
| Anthropic | OpenAI | ✅ | ✅ |
| OpenAI | Anthropic | ✅ | ✅ |
| Anthropic | OpenAI Responses | ✅ | ✅ |
| OpenAI Responses | Anthropic | ✅ | ✅ |

## Architecture

```
Client → POST /v1/chat/completions
  → server.ts (regex route match)
    → pipeline.ts (unified request pipeline)
      → router.ts (modelName → Provider)
      → translation.ts (protocol conversion)
      → provider.ts (fetch upstream)
      → stream-converter.ts (SSE transform)
    → capture.ts (ring buffer + SSE push)
  → Response
```

- **Runtime**: Node.js >= 20, TypeScript ESM
- **Frontend**: Alpine.js SPA (admin UI)
- **Build**: `tsc` + `esbuild` (admin-app.js)
- **Testing**: Node.js native test runner + tsx (115 tests)

## Development

See [DEVELOPMENT.md](./DEVELOPMENT.md) for full development workflow.

```bash
# CLI
npm run dev          # Start proxy in dev mode
npm test             # Run 115 tests

# macOS app
npm run build:app    # Build .app + .dmg
```

## FAQ

**Homebrew shows old version?** Refresh tap:
```bash
brew untap maplezzk/tap && brew tap maplezzk/tap && brew install --cask llm-proxy
```

**macOS blocks the app?** Remove quarantine:
```bash
xattr -cr /Applications/LLMProxy.app
```
