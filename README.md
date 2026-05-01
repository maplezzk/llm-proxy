# llm-proxy

[English](#english) | [中文](#中文)

---

<a name="english"></a>

A local LLM proxy server — single port serving both admin UI and AI API, with multi-protocol routing, protocol translation, streaming SSE conversion, token tracking, and protocol capture debugging.

## Features

- 🔀 **Multi-Protocol**: Anthropic, OpenAI, and OpenAI Responses on a single port
- 🔄 **Protocol Translation**: Bidirectional conversion across all three protocols (streaming + non-streaming)
- 📊 **Admin UI**: Alpine.js SPA with dashboard, provider management, adapter config, and capture debugger
- 🎯 **Virtual Adapters**: Custom endpoints with model remapping (`/{adapter-name}/v1/...`)
- 📡 **SSE Streaming**: 4 bidirectional stream converters with per-line timestamps
- 🔍 **Protocol Capture**: Ring buffer recording raw request/response pairs with side-by-side diff
- 🔥 **Hot Reload**: Atomic config swap without dropping in-flight requests
- 📈 **Token Tracking**: Per-provider token usage statistics

## Install

```bash
npm install -g @maplezzk/llm-proxy
```

## Quick Start

```bash
# Create config
mkdir -p ~/.llm-proxy
cat > ~/.llm-proxy/config.yaml << 'EOF'
log_level: debug
providers:
  - name: deepseek
    type: openai
    api_key: ${DEEPSEEK_API_KEY}
    api_base: https://api.deepseek.com
    models:
      - id: deepseek-chat
EOF

# Start proxy
llm-proxy start

# Open admin UI → http://127.0.0.1:9000/admin/
```

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

---

<a name="中文"></a>

## llm-proxy · 中文

本地 LLM 代理服务，单端口同时提供管理 UI 和 AI API，支持多协议路由、协议互转、流式 SSE 转换、token 统计、协议抓包调试。

### 功能特性

- 🔀 **多协议支持**：单端口提供 Anthropic、OpenAI、OpenAI Responses 三种协议
- 🔄 **协议互转**：三个协议间双向转换（流式 + 非流式）
- 📊 **管理界面**：Alpine.js 单页应用，包含仪表盘、Provider 管理、适配器配置、抓包调试
- 🎯 **虚拟适配器**：自定义端点 + 模型重映射（`/{adapter-name}/v1/...`）
- 📡 **SSE 流式**：4 个双向流转换器，每行带时间戳
- 🔍 **协议抓包**：环形缓冲记录原始请求/响应，支持左右对比 + 差异分析
- 🔥 **热加载**：配置原子替换，进行中请求不受影响
- 📈 **Token 统计**：按 Provider 统计 token 使用量

### 安装

```bash
npm install -g @maplezzk/llm-proxy
```

### 快速开始

```bash
# 创建配置文件
mkdir -p ~/.llm-proxy

# 启动
llm-proxy start

# 打开管理界面 → http://127.0.0.1:9000/admin/
```

### 配置

配置文件位于 `~/.llm-proxy/config.yaml`，API Key 通过环境变量注入，不保存明文密钥。

### CLI 命令

```bash
llm-proxy start     # 启动代理
llm-proxy stop      # 停止代理
llm-proxy restart   # 重启
llm-proxy reload    # 热加载配置（零中断）
llm-proxy status    # 查看状态
```

### 管理 API

| 端点 | 方法 | 说明 |
|----------|--------|-------------|
| `/admin/config` | GET | 查看配置（Key 脱敏） |
| `/admin/config/reload` | POST | 热加载配置 |
| `/admin/health` | GET | 健康检查 |
| `/admin/status/providers` | GET | Provider 状态统计 |
| `/admin/logs` | GET | 请求日志 |
| `/admin/logs/stats` | GET | 日志统计 |
| `/admin/token-stats` | GET | Token 统计 |

### 协议转换矩阵

| 源 | 目标 | 非流式 | 流式 (SSE) |
|--------|--------|:---:|:---:|
| Anthropic | OpenAI | ✅ | ✅ |
| OpenAI | Anthropic | ✅ | ✅ |
| Anthropic | OpenAI Responses | ✅ | ✅ |
| OpenAI Responses | Anthropic | ✅ | ✅ |

### 架构

- **运行时**：Node.js >= 20, TypeScript ESM
- **前端**：Alpine.js 单页应用
- **构建**：`tsc` + `esbuild`
- **测试**：Node.js 原生测试运行器 + tsx（115 tests）

### 开发

详见 [DEVELOPMENT.md](./DEVELOPMENT.md)。
