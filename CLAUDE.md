# CLAUDE.md — llm-proxy

> 本文档描述 **P1 协议核心重写后**的新架构（Hono + Drizzle + PG）。旧的 Express 风格正则路由、
> `createProxyServer`、`src/proxy/translation.ts` / `stream-converter.ts`、`src/adapter/handlers.ts`、
> SQLite UsageStore、后端 i18n、`/admin` 管理 UI 路由均已不存在。**以 `src/` 实际代码为准**。

## 项目概览

本地统一 LLM 代理服务，单端口提供 AI API：多协议（Anthropic / OpenAI Chat / OpenAI Responses）
路由、跨协议互转、流式 SSE 双向转换、token 统计。P1 阶段把协议核心重写为 **canonical IR 中枢 +
三协议适配器**，并把配置/用量持久化迁到 PostgreSQL。P2 阶段在 P1 协议核心上加**编排核心**：
模型为中心的多渠道路由（模型组 + priority/failover + 能力档位）、adapter 稳定别名隐藏真实模型名、
声明式覆写引擎、reasoning 解析集中化（除多租户/鉴权/管理 UI）。

- **运行时**: Node.js >= 22，TypeScript ESM（`"type": "module"`，tsup target node22）
- **HTTP**: Hono + `@hono/node-server`（中间件链：req-id → request log → 路由）
- **CLI**: citty（`start` / `stop` / `restart` / `reload` / `migrate`）
- **数据**: Drizzle ORM + `postgres`（PG-only，见 `docs/adr/`）；迁移文件在 `drizzle/`
- **配置**: YAML（`~/.llm-proxy/config.yaml`）为读源 + PG best-effort 双写过渡（P1.16）
- **日志**: pino（开发环境 pino-pretty，生产结构化 JSON）
- **校验**: zod
- **测试**: Vitest（单测/黄金回归）+ Playwright（e2e）+ Testcontainers（PG 集成）
- **构建**: tsup（后端 → `dist/`）+ Vite（admin-ui，见下方说明）
- **Lint/格式化**: Biome
- **npm 包**: `@mutallip/llm-proxy`

> ⚠️ **admin-ui 现状**：`admin-ui/`（React 19 + Appica UI + Tailwind v4）目录仍存在，`npm run build:admin`
> 仍会构建单文件 HTML，但**新 Hono 服务没有任何 `/admin` 路由**，即当前运行时并不托管管理 UI。
> 抓包缓冲区（`CaptureBuffer`）仍在管线中记录请求/响应对，但**没有 HTTP 端点暴露**（旧 `/admin/#capture`
> 已死）。涉及 admin UI / 抓包可视化的需求需先补管理端点。

## 目录结构

```
src/
  index.ts                 # CLI 入口（citty）：start/stop/restart/reload/migrate + executeStart 编排
  server.ts                # Hono buildApp：req-id/request-log 中间件 + 顶层路由 + createProxyRoutes
  config/
    env.ts                 # loadEnv：统一读取环境变量（DATABASE_URL/PORT/PROXY_KEY/LOG_LEVEL/NODE_ENV）
    types.ts               # 运行时配置类型（camelCase）+ YAML 文件类型（snake_case）
    parser.ts              # YAML 加载/序列化（loadConfigFromYaml / serializeConfigToYaml）
    validator.ts           # 配置校验（含保留适配器名校验：admin/v1/messages/chat/completions）
    store.ts               # ConfigStore：YAML 读源 + 串行锁 + PG best-effort 双写/启动导入
    pg-mapper.ts           # Config ↔ PG 行束互转（过渡期 credential_ref 明文）
  db/
    client.ts              # getDb：postgres-js + Drizzle 单例（无 DATABASE_URL 抛错）
    migrate.ts             # runMigrations：drizzle 编程式迁移（读 drizzle/，幂等）
    config-repo.ts         # importConfigToPg：配置落库（真实外键重映射）
    schema/
      enums.ts             # 4 个 PG ENUM
      index.ts             # schema 聚合入口（drizzle 客户端 + drizzle-kit）
      providers.ts         # providers + provider_models
      adapters.ts          # adapters + adapter_model_mappings（P2 加 model_group_id 可空 FK）
      model-groups.ts      # P2 model_groups + model_group_channels（模型组 + 渠道绑定 + priority + 能力上限）
      settings.ts          # vision_settings + proxy_settings（单例）
      usage.ts             # usage_records
      requests.ts          # requests（P0 请求日志探针表）
  proxy/
    pipeline.ts            # 转发管线：parseAndAuth / applyRouteDecision（含 resolveReasoning + 钳制）/ forwardPipeline（failover 循环 + applyOverrides 接线）
    routes.ts              # Hono 代理路由（直连三协议 + 适配器虚拟端点）
    router.ts              # 模型路由：routeModel（直连）/ routeLogicalModel + selectRoute（模型组候选+选择，P2）/ resolveAdapterRoute（别名→模型组→候选）
    reasoning-resolver.ts  # P2 reasoning 集中解析：resolveReasoning（client/route/override 仲裁 + effort→budget 表 + explicit-off + source 标注）
    override-engine.ts     # P2 声明式覆写引擎：applyOverrides（序列化后/fetch 前；body set/set_if_absent/delete + header set/delete；模板条件；保护字段；失败开放）
    response-decode.ts     # 上游非流式响应 → CanonicalResponse（+ extractWireUsage）
    capture-store.ts       # CaptureBuffer：抓包环形缓冲（当前无 HTTP 端点消费）
    ir/
      types.ts             # canonical IR：CanonicalRequest/Response/Message/Block/ReasoningSpec/UsageRecord
      stream-events.ts     # CanonicalStreamEvent（流式 IR）
      canonicalize.ts      # normalizeRequest：IR 归一（tool→user/签名来源/合并相邻同 role/namespace 展平）
    adapters/
      index.ts             # 适配器契约：Inbound/Outbound/StreamInbound/StreamOutbound + RouteDecision
      inbound/             # 三协议入站：wire body → CanonicalRequest（anthropic/openai-chat/openai-responses）
      outbound/            # 三协议出站：CanonicalRequest → 上游 wire body
      response/            # converters.ts：6 向非流式响应转换（CanonicalResponse → wire）
      ccx/namespace.ts     # 工具命名空间（namespace__name 展平/还原）
    stream/
      inbound/             # 上游 SSE → CanonicalStreamEvent（三协议）
      outbound/            # CanonicalStreamEvent → 客户端 SSE（三协议；anthropic 在此分配 content_block 索引）
      abort.ts             # abortableIterator：客户端断连提前终止上游迭代（区分正常 EOF 与截断）
      capture.ts           # 流式抓包旁路
  routes/
    health.ts              # GET /health
    db-insert.ts           # GET /db/insert（Drizzle 探针插入，需 DATABASE_URL）
  status/
    usage-store.ts         # 内存用量：环形明细（1000 条）+ 今日聚合（重启清空；持久化在 PG usage_records）
  lib/
    logger.ts              # pino 单例
    http-utils.ts          # apiBase 规整 / URL 与请求头脱敏 / 默认 apiBase
admin-ui/                  # Admin UI 前端工程（存在但未接入 Hono 服务，见上方说明）
drizzle/                   # drizzle-kit 生成的迁移 SQL（合约产物，须提交）
e2e/                       # Playwright e2e（smoke.spec.ts）
test/                      # Vitest：golden/ + unit/ + 顶层 + 集成（db/config-pg，需 Docker）
```

## 关键入口

### 启动链路

`src/index.ts` `executeStart()`：

1. `runStartupMigration()` — 仅当 `DATABASE_URL` 已配置时跑 `runMigrations()`（`--skip-migrate` 可跳过）。
2. `buildPipelineDeps(configPath)` — 配置文件存在则 `ConfigStore.create()`（加载 + 校验 + PG 启动导入），
   否则 `ConfigStore.fromMemory({providers:[]})` 空配置启动（所有模型 404）；再装配内存 `UsageStore` +
   `CaptureBuffer`（`captureMaxSize` 默认 100）。
3. `startServer()` → `buildApp()`（Hono）→ `@hono/node-server` `serve()`，写 PID 文件（默认 `/tmp/llm-proxy.pid`）。
4. SIGTERM/SIGINT 用 `process.exit(0)` 退出（SSE 长连接会阻塞 `server.close()`）。

### 请求链路（直连）

`server.ts` `buildApp()` 注册中间件 + 顶层路由，`createProxyRoutes()` 挂代理子应用：

```
POST /v1/{messages|chat/completions|responses}
  → routes.ts proxyHandler(clientProtocol)
  → pipeline.parseAndAuth         # JSON 解析 + 代理 Key 校验 + 提取 model
  → router.routeModel             # 按 providers 声明顺序匹配 model.id → RouteDecision（未命中 404）
  → pipeline.forwardPipeline:
      inbound adapter.decode       # wire → CanonicalRequest
      ir.normalizeRequest          # IR 归一
      applyRouteDecision           # 注入 resolvedModel / stream 策略 / maxTokens 规整
      outbound adapter.encode      # CanonicalRequest → 上游 wire body
      fetch 上游
      ├─ 非流式同协议：原文透传
      ├─ 非流式跨协议：response-decode.decodeUpstreamResponse → response converter（6 向）
      └─ 流式：stream inbound（上游 SSE → IR 事件）→ stream outbound（→ 客户端 SSE）
      → capture / usage 记录 / done 日志
```

### 适配器请求链路

`POST /{name}/v1/{messages|chat/completions|responses}` + `GET /{name}/v1/models`：

- 入站协议**由请求路径决定**（`adapter.type` 仅用于配置校验）。
- `router.resolveAdapterRoute(adapterName, sourceModelId)`（P2 模型为中心）：别名 → `model` 引用 → 模型组 →
  候选渠道；钉死 `channel` 得单个候选，自动别名得全候选集；legacy `provider`+`targetModelId` 保留为单候选；
  携带 `onFailure` / `isPinnedChannel` / `overrides`（adapter-alias 作用域）。
- `selectRoute(candidates, ctx)`：priority 序选首 + alternatives（策略缝，v1 仅 priority）。
- 错误映射：`ADAPTER_NOT_FOUND` / `MODEL_MAPPING_NOT_FOUND` / `ROUTE_GROUP_NOT_FOUND` /
  `ROUTE_NO_ELIGIBLE_CHANNEL` / `CHANNEL_NOT_FOUND` → 404，`ROUTE_ALL_FAILED` 及其余适配器错误 → 502。
- 复用同一条 `forwardPipeline`（含 failover 循环 + 覆写接线）。

## 配置

### YAML（读源）

默认路径 `~/.llm-proxy/config.yaml`，可用 `$LLM_PROXY_CONFIG` 或 `start --config` 覆盖。
YAML 为 snake_case，运行时为 camelCase（`config/parser.ts` 互转）。

```yaml
log_level: debug            # debug|info|warn|error
port: 9000                  # 可选，默认 9000
proxy_key: sk-xxx           # 可选，设置后 /v1/* 与适配器端点需认证
capture_max_size: 100       # 可选，抓包缓冲条数
providers:
  - name: deepseek
    type: openai            # anthropic|openai|openai-responses
    api_key: sk-xxx
    api_base: https://api.deepseek.com   # 可选，缺省按 type 取默认
    models:
      - id: deepseek-chat
        input: [text, image]             # 可选，默认 [text]
        thinking:                         # 可选，三字段任选
          budget_tokens: 4096            #   anthropic thinking 预算
          reasoning_effort: high         #   low|medium|high|xhigh|max
          type: enabled                  #   enabled|disabled|adaptive|auto 透传
model_groups:                          # P2 模型组（逻辑模型 = 组，档位写进名字）
  - id: opus
    context_window: 200000             # 可选，组默认档位
    channels:
      - provider: kiro                 # 渠道 = provider + 其下模型
        model: claude-opus
        priority: 1                    # 可选，priority 序选择（小优先）
        context_window: 200000         # 可选，渠道级能力上限（覆盖组默认）
      - provider: cc
        model: claude-opus
        priority: 2
adapters:
  - name: my-tool
    type: anthropic
    max_tokens: 8192         # 可选，客户端未传时默认
    stream: true             # 可选；undefined=透传 / true=client 未传时默认开 / false=强制关
    on_failure: hard_fail    # 可选，P2 钉死渠道失败策略：hard_fail（默认）| fallback
    models:
      # P2 模型为中心：别名 → model（模型组）+ 可选 channel（钉死）+ overrides
      - source_model_id: deep
        model: opus                    # 逻辑模型（模型组）引用
        # channel: kiro               # 可选，钉死单渠道（不填=自动 priority+failover）
        overrides:                     # 可选，adapter-alias 作用域覆写
          - when: '{{model}} == "deep"'
            body: [{ op: set, path: reasoning_effort, value: high }]
      # legacy 一对一（保留，自动升级为单渠道组）
      - source_model_id: claude-sonnet-4
        provider: deepseek
        target_model_id: deepseek-chat
        thinking: { reasoning_effort: high }   # 可选，映射级优先
```

**代理认证**：`config.proxyKey` 优先，回退 env `PROXY_KEY`；均未设则不鉴权。请求头取
`authorization`（剥离 `Bearer `）或 `x-api-key` 比对。

### PG 双写过渡（P1.16）

- **YAML 仍是唯一读源**；PG 是过渡期 best-effort 镜像。
- `writeConfig()` 写盘成功后 best-effort 同步 PG（失败仅 warn，不影响 YAML 写入）。
- `ConfigStore.create()` 时若 PG 为空（无 providers）则从 YAML 导入（`syncToPg`）。
- `DATABASE_URL` 未配置 / PG 不可用时**静默降级**，保留 db-less 启动能力。
- **过渡期明文**：`Provider.apiKey` 明文写入 `providers.credential_ref`，`proxyKey` 明文写入
  `proxy_settings`（`pg-mapper.ts` 已标 `TODO(security)`，P2 引入加密/vault 后替换）。

## 协议转换

核心思想：**canonical IR 中枢**。任何入站协议先解码为 `CanonicalRequest`，归一后由出站适配器编码为
目标协议；响应逆向。三协议两两互转无需 N×N 直连逻辑。详见 `docs/architecture/protocol-layer.md`。

- **三协议**: `anthropic` / `openai`（Chat Completions）/ `openai-responses`（`ClientProtocol`）。
- **reasoning/thinking 归一**: `ReasoningSpec` 统一承载 effort（5 级 `low|medium|high|xhigh|max`）、
  anthropic `budgetTokens`、透传型 `type`、responses `summary`；决策来源 `source: client|route|override`。
  **P2 集中解析**：`reasoning-resolver.ts` `resolveReasoning` 在 `applyRouteDecision` 内统一仲裁
  （route>client，共享 effort→budget 表，尊重 client explicit-off）；三个 outbound 适配器降为 IR→wire 投影、
  无字段仲裁；`max_tokens` 与 `budget_tokens` 解耦（移除 Anthropic `Math.max(max,budget)` 反语义钳制，
  budget 钳到 `max_tokens-1`）。
- **流式 SSE**: stream inbound 把上游 SSE 解析为 `CanonicalStreamEvent`（块用稳定 `blockId`，签名独立
  `block_signature` 事件），stream outbound 再渲染为客户端协议 SSE。
- **content_block 索引**（Anthropic 出站分配）: index 0 = thinking，1 = text，2+ = tool_use 递增；
  thinking 块在首条 text delta 前关闭。
- **thinking 签名**: 跨协议回传时优先用上游原始签名（`signatureSource: 'original'`）；Chat 等无签名协议
  标 `'generated'`，由 anthropic 出站用 SHA-256 生成 16 字符 hex 确定性伪签名（`makeSignature`），多轮一致。
- **6 向非流式响应转换**: `adapters/response/converters.ts`（`convertAnthropicResponseToOpenAI` 等）。
- **usage 口径**: 计费输入 = 总输入 − 缓存读 − 缓存创建；Anthropic/Responses 的 `input_tokens` 本身即计费
  部分，Chat 的 `prompt_tokens` 含缓存需扣减（见 `response-decode.ts`）。

## 编排核心（P2）

P2 在 P1 协议核心（IR 中枢 + 三协议适配器）上加路由编排，**不改协议转换**。设计权威：
`docs/plans/2026-07-28-001-feat-axonhub-parity-orchestration-plan.md`。

### 模型为中心路由

- **逻辑模型 = 模型组**：档位写进名字（`gpt-5.6-1m` / `gpt-5.6-fast` 是两个不同模型），聚合提供它的渠道。
- **ModelChannel 边**：每个模型-渠道绑定带渠道专属真实模型 ID + `priority` + 能力上限
  （`context_window` / `max_output_tokens`，结构化列，非开放 JSON）。
- **路由 API**（`router.ts`）：`routeLogicalModel(store, model) → RouteDecision[]`（解析模型组、按档位过滤
  候选——丢弃低于组档位的渠道，R5）；`selectRoute(decisions, ctx) → { selected, alternatives }`（priority 序 +
  策略缝，v1 仅 priority，weight/round-robin/latency 后续插件化）；`resolveAdapterRoute` 把别名解析到模型组
  再到候选（钉死 `channel` 单候选 / 自动全候选，R8）。
- **adapter facade**：别名隐藏真实模型 ID + 服务渠道（KD1/KD4）；换渠道客户端零改动（R9）。

### 钳制 + Failover

- **钳制**（R10）：`applyRouteDecision` 把 `generation.maxTokens` 钳到选中渠道 `maxOutputTokens`（`Math.min`）。
- **Failover**（`forwardPipeline`，KTD2/KTD3）：encode/override/fetch 包成 `forwardOnce → {success|fatal|retryable}`，
  顶层按 `[route, ...alternatives]` 遍历。**仅首字节发给 client 之前重试**（retryable = 5xx/408/429/网络错误）；
  mid-stream 失败 surface 错误、不重发 `message_start`；钉死别名按 `on_failure`（`hard_fail` 默认 surface /
  `fallback` 跨候选）；全耗尽 `ROUTE_ALL_FAILED`。usage 仅成功路径记一次（failover 不改基数）。

### 声明式覆写引擎

- **应用点**（KTD8）：`override-engine.ts` `applyOverrides` 在 `outbound.encode` 后、`fetch` 前（pipeline 接在
  `buildUpstreamRequest` 与 `capture.updateRequest` 之间），抓包反映覆写后 body；请求侧、绝不碰响应流。
- **操作**（KTD1，可扩展注册表 `registerBodyOp`/`registerHeaderOp`）：body `set` / `set_if_absent` / `delete` +
  header `set` / `delete`；array/rename/copy 延后。
- **条件**：轻量模板（`{{var}}` + `==/!=/&&/||/()`），渲染结果 == `"true"` 才应用；白名单变量
  `model`/`logicalModel`/`provider`/`providerProtocol`/`resolvedModel`。
- **保护字段**（R12）：`model`/`messages`/`stream`/`system`/`tools` 命中拒整条 rule（配置校验 + 运行时双重）。
- **失败开放**：渲染/操作错误 → warn 日志 + 跳过，不阻断请求。
- **作用域**：adapter-alias（`AdapterModelMapping.overrides`）+ channel（`generation_overrides`），route 时解析携带于
  `RouteDecision.overrides`。

### Reasoning 集中化

见上方「协议转换 / reasoning/thinking 归一」。`resolveReasoning` 替换 P1 三协议散落的字段合并，
outbound 适配器无字段仲裁（KD6/KTD6）。

## PG schema

- **4 个 ENUM**（`src/db/schema/enums.ts`）: `protocol_type` / `reasoning_effort` / `thinking_type` / `stream_policy`。
- **9 张核心表**: `providers` / `provider_models` / `adapters` / `adapter_model_mappings` /
  `model_groups` / `model_group_channels`（P2 模型组 + 渠道绑定）/ `vision_settings` / `proxy_settings`（单例）/
  `usage_records`；另有 `requests`（P0 请求日志探针表）。`adapter_model_mappings` P2 加可空 `model_group_id` FK
  （`provider_model_id` 改可空，CHECK 至少一非空）。
- **迁移**: `drizzle/` 目录（合约产物，须提交）。

```bash
npm run db:generate    # drizzle-kit generate：由 schema 生成迁移 SQL
npm run db:migrate     # drizzle-kit migrate：应用迁移
npm run db:push        # drizzle-kit push：直接推 schema（开发用）
npm run init-db        # scripts/init-db.sh：幂等创建 llmproxy_dev 库（需本地 postgres 容器）
```

- 服务启动时（`start`，有 `DATABASE_URL`）自动跑编程式迁移（`db/migrate.ts`，幂等），`--skip-migrate` 跳过。
- 连接参数（`db/client.ts`）：`prepare:false, max:5, idle_timeout:5, connect_timeout:5`。

## HTTP 端点（实际）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | JSON 状态探针 |
| GET | `/db/insert` | Drizzle 探针插入（需 `DATABASE_URL`） |
| POST | `/v1/messages` | Anthropic 入站 |
| POST | `/v1/chat/completions` | OpenAI Chat 入站 |
| POST | `/v1/responses` | OpenAI Responses 入站 |
| POST | `/{name}/v1/messages\|chat/completions\|responses` | 适配器虚拟端点（入站协议由路径决定） |
| GET | `/{name}/v1/models` | 适配器模型列表 |

> 当前**没有** `/admin`、管理 CRUD API、日志查询、抓包查询等端点（旧架构有，重写后未迁回）。

## 测试

测试金字塔：黄金回归（`test/golden/`）+ 单元测试（`test/unit/`）+ 顶层集成（`test/pipeline.test.ts` /
`test/inbound-adapters.test.ts`）+ PG 集成（`test/db.test.ts` / `test/config-pg.test.ts`，Testcontainers）
+ e2e（`e2e/`，Playwright）。

```bash
# 单测 + 黄金回归（不含 Docker 测试）—— 实测 326 passed + 5 skipped（24 files，P2 后）
npx vitest run --exclude '**/db.test.ts' --exclude '**/config-pg.test.ts'

# 全量单测（等价 npm run test:unit；db/config-pg 需 Docker，否则跳过/失败）
npm run test:unit

# PG 集成测试（需本机 Docker，Testcontainers 起 postgres）—— 18 个（db 5 + config-pg 13，P2 后）
npx vitest run test/db.test.ts test/config-pg.test.ts

# e2e（Playwright；默认 webServer 自动起 npm run dev）
npm run test:e2e

# 类型检查 + 单测
npm test

# 构建
npm run build           # build:app（tsup）+ build:admin（vite）
```

- Vitest 配置：`pool: 'forks'`，test/hook 超时 90s（容忍 Testcontainers 冷启动）。
- 单文件：`npx vitest run test/unit/proxy/router.test.ts`。

## Git 约定

- 主分支: `main`
- 特性分支: `feature/<描述>`
- 提交格式: `type: 中文描述`（如 `feat:`, `fix:`, `chore:`）

## npm 发布

- **包名**: `@mutallip/llm-proxy`（npm 公开包）
- **npm 账号**: `mutallip`（2FA: passkey/Touch ID）
- **GitHub 仓库**: `mutallipp/llm-proxy`
- **CI 自动发布**: `.github/workflows/publish.yml`，push tag `v*` 触发，OIDC Trusted Publishing（无需 token / 2FA）
- **Trusted Publisher 配置**: npm 包设置页已绑定 `mutallipp/llm-proxy` + `publish.yml`

### 发新版操作

```bash
npm version patch                    # 升版本号 + commit + 打 tag
git push origin main                 # push 代码
git push origin v0.xx.x              # push tag 触发 CI 自动发布
```

> ⚠️ 不要用 `git push --tags`，会把本地所有历史 tag 推上去。只推新 tag。

### 安装

```bash
npm install -g @mutallip/llm-proxy
llm-proxy start
```

## 已知限制（P2 残留，审查记录）

P2 编排核心经 4-persona 代码审查（correctness/reliability/security/data-migration），P0/P1/P2 可修项均已修（见提交历史）；以下为非阻塞已知项，留待后续：

- **配置导入清旧插新**：`importConfigToPg` 事务先删 adapter_model_mappings/adapters/model_groups/providers 再重建；若 `usage_records` 已引用旧 provider/model/adapter ID（ON DELETE NO ACTION），清旧触发外键违规、事务回滚。P1.16 已知限制，P2 新表（model_group_channels 级联清理）未加重。后续改 upsert-by-name（保留被引用旧行）。
- **PG round-trip 语义归一**：`rowsToConfig` 把 `Provider.priority=0`/`enabled=true` 归一为 undefined（默认值不保留显式形式），语义等价但非结构无损。
- **组/渠道 enabled 暂未暴露**：`model_groups`/`model_group_channels` 有 `enabled` 列（schema 预留），但 Config 类型与运行时暂未暴露——PG 中禁用的组/渠道 loadConfigFromPg 后会恢复启用。启用/禁用管理属后续管理 UI 范畴（KD7 排除）。
- **pinned 成员关系无 DB 约束**：`adapter_model_mappings` 的 `model_group_id` 与 `provider_model_id` 只有独立 FK，理论上可落库「pinned provider_model 不在该 group 渠道集」的无效行；应用层（validator/router）已拦截，单用户部署足够，DB 复合约束延后。

## 常见问题

- **跨协议 thinking/reasoning 丢失**：检查 inbound 解码是否产出 `thinking` 块、`normalizeRequest` 的签名来源
  显式化、以及 anthropic 出站 `makeSignature` 伪签名是否生成；流式注意 `block_signature` 在 `block_stop` 之前发出。
- **流式被客户端中断后上游还在跑**：`stream/abort.ts` `abortableIterator` 透传 `c.req.raw.signal`，abort 时
  提前终止上游 SSE 迭代且**不补发** `message_stop`（供上层区分正常 EOF 与截断）。
- **PG 连接失败 / 启动报 DATABASE_URL**：无 `DATABASE_URL` 时服务走 db-less（迁移跳过、PG 双写降级为 warn）；
  需要 PG 时用 `npm run init-db` 建库并设置 `DATABASE_URL`（容器内用 DNS 名 `postgres`，宿主机直连用 `127.0.0.1`）。
- **Testcontainers 测试失败**：`test/db.test.ts` / `test/config-pg.test.ts` 需要本机 Docker 运行，否则起容器失败。
- **所有模型都 404**：配置文件缺失会以空配置启动（日志 `starting with empty config`）；确认 `~/.llm-proxy/config.yaml`
  或 `--config` / `$LLM_PROXY_CONFIG` 指向正确，且 `providers[].models[].id` 与请求 `model` 一致。
- **SIGTERM 重启失败**：SSE 长连接阻塞 `server.close()`，故 shutdown 用 `process.exit(0)` 直接退出（`index.ts`）。
