# llm-proxy

[English](./README.md) | [简体中文](./README.zh.md)

本地 LLM 代理服务，单端口同时提供管理 UI 和 AI API，支持多协议路由、协议互转、流式 SSE 转换、token 统计、协议抓包调试。

## 功能特性

- 🔀 **多协议支持**：单端口提供 Anthropic、OpenAI、OpenAI Responses 三种协议
- 🔄 **协议互转**：三个协议间双向转换（流式 + 非流式）
- 🖥️ **macOS 桌面应用**：原生菜单栏 App，内嵌代理服务，拖拽安装、零依赖
- 📊 **管理界面**：Alpine.js 单页应用，包含仪表盘、Provider 管理、适配器配置、抓包调试
- 🎯 **虚拟适配器**：自定义端点 + 模型重映射（`/{adapter-name}/v1/...`）
- 📡 **SSE 流式**：4 个双向流转换器，每行带时间戳
- 🔍 **协议抓包**：环形缓冲记录原始请求/响应，支持左右对比 + 差异分析
- 🔥 **热加载**：配置原子替换，进行中请求不受影响
- 📈 **Token 统计**：按 Provider 统计 token 使用量

## 安装

**macOS（推荐）：**
从 [Releases](https://github.com/maplezzk/llm-proxy/releases) 下载 `LLMProxy.dmg`，拖入 `/Applications`。如果 macOS 阻止运行，执行：
```bash
xattr -cr /Applications/LLMProxy.app
```
再次打开即可。内含完整代理服务和管理界面。

**仅 CLI：**
```bash
npm install -g @maplezzk/llm-proxy
```

## 快速开始

```bash
# 创建配置文件
mkdir -p ~/.llm-proxy

# 启动
llm-proxy start

# 打开管理界面 → http://127.0.0.1:9000/admin/
```

## 配置

`~/.llm-proxy/config.yaml`:

```yaml
log_level: debug          # debug | info | warn | error
proxy_key: sk-xxx         # 可选：设置后 /v1/* 需认证

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

API Key 通过环境变量注入（`${VAR}`），配置文件不保存明文密钥。

## CLI 命令

```bash
llm-proxy start     # 启动代理
llm-proxy stop      # 停止代理
llm-proxy restart   # 重启
llm-proxy reload    # 热加载配置（零中断）
llm-proxy status    # 查看状态
```

## 管理 API

| 端点 | 方法 | 说明 |
|----------|--------|-------------|
| `/admin/config` | GET | 查看配置（Key 脱敏） |
| `/admin/config/reload` | POST | 热加载配置 |
| `/admin/health` | GET | 健康检查 |
| `/admin/status/providers` | GET | Provider 状态统计 |
| `/admin/logs` | GET | 请求日志 |
| `/admin/logs/stats` | GET | 日志统计 |
| `/admin/token-stats` | GET | Token 统计 |

## 协议转换矩阵

| 源 | 目标 | 非流式 | 流式 (SSE) |
|--------|--------|:---:|:---:|
| Anthropic | OpenAI | ✅ | ✅ |
| OpenAI | Anthropic | ✅ | ✅ |
| Anthropic | OpenAI Responses | ✅ | ✅ |
| OpenAI Responses | Anthropic | ✅ | ✅ |

## 架构

- **运行时**：Node.js >= 20, TypeScript ESM
- **前端**：Alpine.js 单页应用
- **构建**：`tsc` + `esbuild`
- **测试**：Node.js 原生测试运行器 + tsx（115 tests）

## 开发

详见 [DEVELOPMENT.md](./DEVELOPMENT.md)。

```bash
npm run dev          # 开发模式启动代理
npm test             # 运行 115 个测试
npm run build:app    # 构建 macOS .app + .dmg
```

## FAQ

**Homebrew 安装显示旧版本？** 强制刷新 tap：
```bash
brew untap maplezzk/tap && brew tap maplezzk/tap && brew install --cask llm-proxy
```

**macOS 阻止应用运行？** 清除隔离标记：
```bash
xattr -cr /Applications/LLMProxy.app
```
