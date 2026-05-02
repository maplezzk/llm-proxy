# CLAUDE.md — llm-proxy

## 项目概览

本地 LLM 代理服务，单端口同时提供管理 UI 和 AI API，支持多协议（Anthropic/OpenAI/OpenAI Responses）的路由、协议互转、流式 SSE 转换、token 统计、协议抓包调试。

- **运行时**: Node.js >= 20, TypeScript ESM
- **前端**: Alpine.js 单页应用（admin UI）
- **构建**: `tsc` + `esbuild`（admin-app.js 打包）
- **测试**: `node --import tsx --test test/**/*.test.ts`
- **启动**: `npm start` 或 `llm-proxy start`

## 目录结构

```
src/
  cli/commands.ts          # CLI 入口（start/stop/restart/reload）
  config/                  # YAML 配置加载、校验、热重载
  api/
    server.ts              # HTTP 路由分发（正则匹配）
    admin/                 # Admin UI（Alpine.js 组件）
      components/          # dashboard/logs/providers/adapters/capture/...
    handlers/              # API 处理器（CRUD/日志/token统计/抓包）
  proxy/
    router.ts              # 模型路由（modelName → Provider）
    translation.ts         # 协议转换核心（Anthropic↔OpenAI↔Responses）
    stream-converter.ts    # SSE 流式双向转换（4 个 converter）
    provider.ts            # forwardRequest → fetch 上游
    handlers.ts            # 代理请求入口（认证/解析/路由/转发）
    capture.ts             # 协议抓包（环形缓冲 + SSE 推送）
    types.ts               # 共享类型
  adapter/                 # 适配器虚拟端点（/{name}/v1/...）
  status/                  # StatusTracker / TokenTracker
  log/logger.ts            # 结构化日志（内存 + 文件）
config.yaml                # 配置文件（~/.llm-proxy/config.yaml）
```

## 关键入口

- **服务启动**: `src/cli/commands.ts` → `cmdStart()` → `ConfigStore.create()` → `createProxyServer()`
- **请求入口**: `src/api/server.ts` ROUTES 数组 → 正则匹配 → handler
- **代理请求**: `src/proxy/handlers.ts` → `handleProxyRequest()` → `routeModel()` → `transformInboundRequest()` → `forwardRequest()`
- **适配器请求**: `src/adapter/handlers.ts` → `handleAdapterRequest()` → 复用 proxy 层

## Git 约定

- 主分支: `main`
- 特性分支: `feature/<描述>`
- 提交格式: `type: 中文描述`（如 `feat:`, `fix:`, `chore:`）

## 配置文件

`~/.llm-proxy/config.yaml`:

```yaml
log_level: debug          # debug|info|warn|error
locale: zh                # 可选，zh|en，默认从 LANG 环境变量检测
proxy_key: sk-xxx         # 可选，设置后 /v1/* 需认证
providers:
  - name: deepseek
    type: openai          # anthropic|openai|openai-responses
    api_key: sk-xxx
    api_base: https://api.deepseek.com
    models:
      - id: deepseek-chat
adapters:
  - name: my-tool
    type: anthropic
    models:
      - sourceModelId: claude-sonnet-4
        provider: anthropic
        targetModelId: claude-sonnet-4-20250514
```

## 协议转换要点

### Anthropic ↔ OpenAI 消息格式

- **thinking block → reasoning_content**: `convertMessagesToOpenAI` 处理 assistant 消息中的 thinking 块
- **reasoning_content → thinking block**: `convertMessagesToAnthropic` 处理 OpenAI assistant 消息中的 reasoning_content
- **tool_use → tool_calls**: ID/name/input 映射
- **tool_result → tool role**: user 消息中的 tool_result 块转为 tool role 消息

### 流式 SSE 转换

4 个 converter，每个都有 `rawLines`（入站原始 SSE）+ `outLines`（出站 SSE），带 `[HH:MM:SS.mmm]` 时间戳：

| 函数 | 入站 | 出站 |
|------|------|------|
| `convertAnthropicStreamToOpenAI` | Anthropic SSE | OpenAI SSE |
| `convertOpenAIStreamToAnthropic` | OpenAI SSE | Anthropic SSE |
| `convertOpenAIResponsesStreamToAnthropic` | OpenAI Responses SSE | Anthropic SSE |
| `convertAnthropicStreamToOpenAIResponses` | Anthropic SSE | OpenAI Responses SSE |

### Anthropic content_block 索引规范

- index 0: thinking
- index 1: text
- index 2+: tool_use（递增）
- thinking 块在 message_start 后立即发出，在首条 text delta 前关闭（`content_block_stop`）

### Thinking 签名

跨协议转换时，thinking 签名优先使用上游原始值，否则用 SHA-256 生成确定性伪签名（`makeSignature(thinkingText)`，16 字符 hex），多轮对话回传一致。

## 管理端口

| 端口 | 用途 |
|------|------|
| 9000 | 代理 API（/v1/*）+ 管理 UI（/admin/*）|

### 抓包调试

打开 `/admin/#capture` → 点「开始抓包」→ 发请求 → 点击行查看左右对比（JSON 用 jsoneditor，SSE 用原始文本）+ 差异分析。

## 多语言支持 (i18n)

llm-proxy 支持中文和英文双语界面，使用 i18next 作为 i18n 库。

### 翻译文件

- `locales/{lang}/translation.json` — 前后端共享的翻译 JSON 文件
- 当前支持 `zh`（中文）和 `en`（英文），英文为默认 fallback
- 使用点分命名空间：`admin.dashboard.status`、`cli.start.configNotFound`

### 使用方式

- **前端 (Alpine.js)**: 模板中使用 `$t('key')`，组件中使用 `i18next.t()`
- **后端/CLI**: 导入 `t()` 函数：`import { t } from '../lib/i18n.js'`
- **类型安全**: `src/types/i18n.generated.ts` 在 `npm run build` 时自动生成

### 语言切换

- **Admin UI**: 侧栏底部语言按钮，或浏览器语言自动检测，选择存入 localStorage
- **CLI**: `LANG=zh llm-proxy start` 环境变量，或 `config.yaml` 中 `locale: zh`
- 默认语言：英文

### 添加新语言

1. 创建 `locales/{lang}/translation.json`，结构参考 `locales/zh/translation.json`
2. 在 `src/lib/i18n.ts` 的 `createI18n()` 中添加资源加载
3. 在 `src/api/admin/i18n.ts` 的 import 和 resources 中添加
4. 运行 `npm run generate:i18n-types` 更新类型

## 测试

```bash
# 全量（115 tests）
node --import tsx --test test/**/*.test.ts

# 单个文件
node --import tsx --test test/proxy/stream-converter.test.ts

# 构建
npm run build
```

## 常见问题

- **跨协议 thinking 丢失**: 检查 stream-converter 的 content_block 索引和思考块关闭时机
- **时间不对**: 全局使用本地时间，检查 `ts()`/`fmtLocal()` 调用
- **SIGTERM 重启失败**: server.close() 无法关闭 SSE 连接，用 process.exit(0) 直接退出
- **JSON 查看器不支持复制**: 标题栏 📋 按钮可复制原始内容
