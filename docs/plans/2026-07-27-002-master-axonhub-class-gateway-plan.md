---
title: llm-proxy → AxonHub 级本地网关（主计划）
date: 2026-07-27
seq: 2026-07-27-002
type: master-plan
status: accepted（地基与技术栈已定，P0 启动）
execution: code
supersedes:
  - docs/plans/2026-07-27-001-feat-reasoning-templates-and-model-capabilities-plan.md
  - docs/plans/2026-07-25-001-feat-web-only-dynamic-model-capabilities-plan.md
  - docs/plans/2026-07-25-002-feat-generic-browser-reasoning-mappings-plan.md
related:
  - docs/adr/0004-pg-only-best-in-class-stack.md
  - docs/research/axonhub-analysis.md
---

# llm-proxy → AxonHub 级本地网关（主计划）

> 本计划是**新需求的唯一主文档**，取代上述三个旧 plan。旧 plan 已标记 SUPERSEDED。
> 它定义方向、技术栈、能力范围与阶段路线图；每个阶段（P1–P7）另立独立实施计划。

## 1. 背景与新方向

通过对 AxonHub（Go 写的开源 AI 网关，4.8k stars）源码的深度扫描（见 `docs/research/axonhub-analysis.md`），确认其核心高级能力——**推理等级归一化**、**声明式请求参数注入（override 引擎）**、**多上游路由 + failover**、**可观测性与成本**、**模型管理**——都是经过验证的一等能力。

新方向：**把 llm-proxy 从"轻量本地代理"升级为"AxonHub 级本地网关"**，保留 AxonHub 的实用能力，剔除其多租户/团队设施与单用户用不上的规模化机制，并用 **TS 生态最佳实践**重新落地（AxonHub 是 Go，无法"迁移"，只能在 TS 里用合适工具重新实现其能力）。

**核心原则：迁"能力/行为"，不迁"实现/架构"。** 每个功能问一句：单用户、2–3 个 provider 场景下是否带来可感知差异？带来→做（轻量实现）；不带来→跳过。

## 2. 目标 / 非目标

### 目标
- G1. 推理等级 canonical 化：跨协议（Anthropic/OpenAI/OpenAI-Responses）无损传递推理等级，消除"两两直转丢等级"。
- G2. 声明式参数注入：per-provider/model 在转发请求里注入任意参数（含上游私有字段），支持条件与模板变量。
- G3. 多上游路由 + failover：同模型多 provider，优先级/权重，失败自动换道，429 强制换道。
- G4. 可观测性：TTFT/推理时长、每请求持久化日志、成本核算、usage 扩维。
- G5. 模型管理：`/v1/models`（含 capabilities）、正则映射、响应模型名还原、上游列表同步。
- G6. PG 持久化 + Docker 一键部署 + `.env` 配置。
- G7. day-1 端到端自动化测试（Vitest 单测/集成 + Playwright E2E + Testcontainers 真实 PG）。

### 非目标（永久跳过，见 §6 ❌）
- 多租户：登录注册、RBAC、project 隔离、配额、API Key 多类型。
- 单用户用不上的规模化机制：EWMA 延迟打分、防扎堆、per-(channel,model) 熔断状态机、6 种关联类型全套、4 套 LB × 8 策略。
- 换语言（Go 重写）、GraphQL admin、多 DB 方言。

## 3. 技术栈（best-in-class，待最终确认）

> 原则：TS 生态里选当下最成熟、最贴合"本地网关 + 重 SSE 流式 + PG"场景的工具。每项给推荐 + 备选。

| 层 | 推荐 | 备选 | 理由 |
|----|------|------|------|
| 运行时 | **Node 22 LTS** | Node 20 | 原生 web streams / fetch，SSE 友好，LTS |
| HTTP 框架 | **Hono**（@hono/node-server） | Fastify | TS-first、极快、中间件模型贴合代理（auth→override→retry→forward）、SSE 一等支持 |
| ORM / 查询 | **Drizzle ORM** + drizzle-kit | Kysely / Prisma | TS-first、SQL 风格、迁移工具完善、PG 驱动成熟；比 Prisma 轻、比裸 SQL 省 |
| PG 驱动 | **postgres**（postgres-js） | pg | 现代、快、Drizzle 官方适配 |
| 校验 | **Zod**（+ @hono/zod-validator） | valibot | 事实标准，env/API/DB 共享 schema，推断 TS 类型 |
| 配置 | **Zod 校验的 env**（dotenv 加载） | — | `.env` 管基建（DB URL/端口/密钥），类型安全 |
| 日志 | **pino**（+ pino-pretty dev） | — | 最快的结构化日志 |
| 构建 | **tsup**（esbuild） | tsc | 快、可 bundle，产出 dist |
| 单测/集成 | **Vitest**（+ @vitest/coverage-v8） | node --test | TS 原生、watch、覆盖率、生态最好 |
| E2E | **Playwright** | — | 用户指定；admin UI 浏览器 E2E + API E2E |
| 测试 DB | **Testcontainers-node**（@testcontainers/postgresql） | — | 集成测试起真实 PG，不 mock DB |
| Lint/Format | **Biome** | eslint+prettier | 快、现代、单工具 |
| CLI | **citty** | commander | 轻、TS 友好（沿用现有 start/stop/restart/reload + 新增 migrate） |
| 容器 | **多阶段 Dockerfile**（node:22-alpine）+ postgres:16-alpine + compose | — | 一键部署 |
| Admin UI | **沿用 React 19 + Appica UI + Tailwind v4 + 单文件** | shadcn/ui（唯一备选） | 现有资产质量高，不重写，按需加页面（详 §3.1） |

### 3.1 UI 组件框架决策（已定）

- **沿用 Appica UI（`@appica/ui-react`，Base UI 无头 + Tailwind v4）**，不引入 Element / Ant Design。
  - 现状：6 个页面 + 共享层（`lib/form-helpers`/`toast`/`confirm`/`app-state`）已统一使用 Appica；ThemeProvider（light/dark）+ i18n 已集成；架构现代（无头+Tailwind，与 shadcn 同流派）。
  - **Element / Element Plus 是 Vue 框架**，与 React admin 不兼容（引入 = 把前端重写成 Vue）。
  - **Ant Design 流派冲突**：重型 + 自带设计语言 + v5 CSS-in-JS，与 Tailwind v4 + 单文件打包（vite-plugin-singlefile）冲突、包体暴涨；6 个 tab 用不上其 60+ 组件火力；需重写全部现有页面。
- **唯一备选：shadcn/ui**（Radix + Tailwind，同哲学；更主流、社区大、AI 熟；AxonHub 前端即用 shadcn-admin）。
- **迁移触发条件**（满足其一才迁 shadcn）：Appica 停止维护 / 缺关键组件无法绕过 / 出现严重且无法规避的 bug。
- **去风险**：保持 `lib/` 共享封装薄而集中，使未来迁 shadcn 为机械替换、不动业务页面。
- 新功能页（override 编辑器 / 模型管理 / 成本看板 / failover 配置）所需 Table/Form/Dialog/Select/Switch，Appica 均具备，用 Appica 实现。

### 3.2 选型理由（逐项）

| 工具 | 选它的理由 | 诚实代价 / 备选 |
|------|-----------|----------------|
| **Hono** | 基于 Web Standards（Request/Response/ReadableStream/fetch），与“收 Request→fetch 转发→流回 Response”的代理工作 1:1 贴合，上游 fetch body 可近乎零拷贝管道给客户端；TS-first 推断类型；极快；中间件模型适合 auth→override→retry→forward | 生态比 Express 小。**Express** 成熟、生态最大，但用 Node req/res 流，代理时需 web↔node stream 转换、SSE 缓冲 bug 更易出，Express 4 吞异步错误，性能/TS 不及 Hono；传统 CRUD 场景 Express 仍佳。备选 **Fastify**（更成熟、插件多，但 Node 流模型，代理贴合度略低） |
| **Drizzle** | TS-first、SQL 风格（不被 ORM 黑盒）、drizzle-kit 迁移完善、PG 适配成熟、轻、推断类型 | 无 Prisma Studio 类 GUI。备选 **Prisma**（更省心但更重、生成 client、SQL 控制弱）/ **Kysely**（纯查询构建器，迁移要自配） |
| **postgres-js** | 现代 PG 驱动，快，Drizzle 官方适配（drizzle-orm/postgres-js） | 备选 **pg**（更老牌、生态大、API 旧） |
| **Zod** | 事实标准 schema 校验；env/API 请求/DB 共享一套 schema 并推断 TS 类型；@hono/zod-validator 集成 | 运行时校验微小开销。备选 **valibot**（更小）/ **arktype** |
| **pino** | 最快的结构化 JSON 日志，低开销（高吞吐代理不能被日志拖慢）；pino-pretty 开发可读 | 备选 **winston**（更重更慢） |
| **tsup** | esbuild 驱动构建极快，零配置产出干净 ESM dist，适合 npm 发布的 CLI 包 | **esbuild 不做类型检查**，仍需 `tsc --noEmit` 把关（放 CI）。备选 **tsc**（更简单、零额外工具、对 Node 服务完全够，只是慢、产物散）——推荐但非必需 |
| **Vitest** | TS 原生、与 Vite 生态一致、watch/快照/覆盖率好；**Browser Mode 一套工具覆盖单测 + 组件级真实浏览器测试** | 备选 **node --test**（零依赖但无 Browser Mode、功能少） |
| **Playwright** | 跨浏览器、自动等待、trace viewer、codegen；**同时测 API + 内置视觉快照**（toHaveScreenshot）；E2E 事实标准 | 装浏览器有体积。备选 **Cypress**（DX 好但更慢、新项目已被反超） |
| **Testcontainers** | 集成测试起**真实 PG**（不 mock DB），测到真实 SQL/迁移/约束，最接近生产 | 需 Docker、测试稍慢。备选 CI `services: postgres` |
| **Biome** | Rust 写的 lint+format 单工具，极快，替代 eslint+prettier 两个 | 插件生态比 eslint 少。备选 **eslint+prettier**（更成熟、规则多） |
| **citty** | 轻、TS 友好的 CLI（沿用 start/stop/restart/reload + 新 migrate） | 备选 **commander**（更老牌、文档多） |

## 4. 架构决策（已定）

- **D1 数据库 PG-only**：移除 `better-sqlite3`。所有持久化（providers/adapters/models/requests/usage/cost/override 配置）落 PG。
- **D2 环境隔离 = 独立数据库（复用现有 PG 实例）**：复用本机 Docker 已有的 `postgres` 容器（postgres:16-alpine，自定义 bridge 网络 `shared-net`，用户 `dev`），在其中建**专用 database** `llmproxy_dev`（开发）/ `llmproxy_prod`（生产），由 `DATABASE_URL` 指向；不复用其默认 `dev` 库，真隔离。不自带 PG、不用 SQLite fallback、不用多 DB 方言抽象。
- **D3 迁移体系**：drizzle-kit `generate`/`migrate`，**应用启动时自动 migrate**（AxonHub auto-migration 的 TS 轻量版）。
- **D4 配置分层**：`.env`（基建：`DATABASE_URL`/`PORT`/`PROXY_KEY`/`LOG_LEVEL`，提交 `.env.example`，`.env` 进 gitignore）；领域配置（providers/adapters/models/override）**落 PG，admin 可编辑**（不再以 YAML 为主存储；YAML 仅作可选导入/种子）。
- **D5 部署（复用现有 PG，不自带数据库）**：`docker-compose.yml` **只定义 app 服务**，通过 external 网络 `shared-net` 接入现有 `postgres` 容器，容器内以 DNS 名 `postgres` 访问（`postgres://dev:***@postgres:5432/llmproxy_dev`）；宿主机本地运行则用 `127.0.0.1:5432`。启动时自动 migrate。一次性 bootstrap 建库：`docker exec postgres psql -U dev -c 'CREATE DATABASE llmproxy_dev'`（`scripts/init-db.sh` 幂等封装）。保留 `npm i -g`（需外部 PG）。
- **D6 测试 day-1**：Vitest（单测/集成，Testcontainers 起 PG）+ Playwright（admin 浏览器 E2E + API E2E）进 CI，从第一个 phase 就建好骨架。

## 5. 迁移策略：greenfield 架构 + 移植协议核心

**不做纯增量补丁，也不做"连协议正确性一起扔掉"的蛮干重写。** 采用 hybrid：

- **Greenfield**：新架构、新栈（Hono/Drizzle/PG/pino）、新 DB schema、新目录结构——不受旧代码组织束缚（"不要历史包袱"落在这里）。
- **移植而非重写**：现有 `translation.ts`（2109 行）+ `stream-converter.ts`（1555 行）+ **329 个测试**是血泪换来的协议正确性（thinking 签名、content_block 索引、SSE 时序）。把这块**作为模块移植进新架构并保留其测试**，不重新发明。
- **npm 包延续**：包名 `@mutallip/llm-proxy` 不变，**主版本号 bump（1.0.0）** 标记破坏性变更（PG 必需、配置迁移）。提供 `migrate` CLI 把旧 YAML 配置导入 PG。
- **过渡**：旧版 0.x 保留可安装（npm dist-tag），新版 1.x 为 PG 版。

> "不要历史包袱" = 不被旧架构/栈/DB 束缚；**不等于**丢弃协议正确性与测试资产。

## 6. 能力范围（三桶）

### ✅ 迁——高价值，轻量实现
canonical reasoning 字段；模型名后缀解析（`gpt-5-high`）；per-provider reasoning 值映射；effort↔budget 默认表；**override 引擎**（set/set_if_absent/delete + 模板变量 + 条件）；多上游 failover（priority+weight+429 换道）；可重试错误三层判定；流首事件超时/空响应检测；EnsureUsage 自动注入 `include_usage`；TTFT/推理时长打点；每请求日志（PG requests 表）；成本核算；正则模型映射 + 响应模型名还原；`/v1/models` + include 参数 + 模型 card；上游模型列表拉取同步；TransformerMetadata sidecar（同协议透传保真）；签名前缀启发式（`gAAAA*`→OpenAI / `Eq*`→Anthropic）。

### 🔶 迁能力，简化实现
| 能力 | 要 | 不要 |
|------|----|----|
| 路由 | 同 model 多 provider + priority + weight + failover | 6 种关联类型 + when 条件全套 |
| 负载均衡 | weight + round-robin + ErrorAware 衰减 | 4 套 LB × 8 打分策略 + EWMA + 防扎堆 + top-k |
| 熔断 | 连续 N 失败冷却 M 分钟（纯内存 Map） | 半开/全开/探测租约/CAS 单飞/指数退避状态机 |
| usage | 扩 reasoning_tokens / cache write | audio / prediction / 5m-1h TTL 等 15+ 维全套 |
| trace | session header 提取 + requests 表一列分组 | Trace/Thread 实体 + tool_call_id 重建时间线树 |

### ❌ 永久跳过（非团队功能也不做，理由全是"不合适"）
- **平台地基**：ent/多 DB 方言/GraphQL admin/对象存储卸载 → 用 Drizzle+PG+REST+单文件 admin。
- **单用户用不上的规模化机制**：EWMA/防扎堆/熔断状态机/6 关联类型全套。
- **广度与维护负担**：hub-and-spoke 重构（N=3 不做，触发式）；gemini/embedding/image/audio/rerank/realtime + 60 种出站 channel + Bedrock/Vertex 签名 + OAuth 刷新（按需扩展，不对标清单）；API Key Profile 多套 + 热切换。
- **多租户全家桶**：登录注册/RBAC/project 隔离/配额/API Key 四类型/多租户分析。

## 7. 测试策略（day-1，分层）

现状痛点：admin UI（React）几乎零测试，329 个测试全是后端协议层，**UI 问题单测看不出来**。故采用分层金字塔，从 P0 就建好骨架并进 CI：

```
        /\        Playwright E2E：3-5 条关键流 + API E2E + 视觉快照 + a11y
       /  \       （少而精，不堆量）
      /----\
     /      \     Vitest Browser Mode：admin 组件真实浏览器测试（UI 验证主力）
    /--------\
   /          \   Vitest 单测/集成：协议/逻辑/DB（移植旧 329 测试）
  /____________\
```

| 层 | 工具 | 覆盖 |
|----|------|------|
| 单元 | Vitest | 协议转换、reasoning 归一、override 引擎、路由选择、成本计算（移植旧 329 测试到这层） |
| 集成 | Vitest + **Testcontainers（真实 PG）** | DB schema/迁移、CRUD API、配置加载、usage/cost 落库 |
| **组件级真实浏览器**（UI 验证主力） | **Vitest Browser Mode**（底层 Playwright 驱动）+ Testing Library | admin 组件在真实浏览器渲染/交互：表单、列表、弹窗、状态、暗色模式——抓 80% “UI 坏了” |
| 端到端 | **Playwright** | ① 3-5 条关键流（配 provider/adapter/override → 发请求 → 看 dashboard/cost）；② API E2E：起真实服务 + mock 上游，跑三协议真实请求（含流式），断言推理注入/override/failover |
| **视觉回归** | Playwright `toHaveScreenshot()` | 关键页（dashboard/providers/adapters/capture）截图比对，管样式/布局/暗色回归（零额外依赖） |
| **无障碍** | @axe-core/playwright | 关键页 a11y 烟雾检查 |
| 上游模拟 | 内置 mock upstream server | Playwright/集成测试共用，模拟三协议上游（含 SSE、错误码、429） |

**原则**：不用一堆 E2E 抓 UI 问题——组件级 UI 问题交给 Vitest Browser Mode（快、稳），Playwright 只跑少数关键流 + 视觉快照。Storybook/Chromatic/Percy 暂不引入（单用户 OSS 偏重）。

CI（GitHub Actions）：`services: postgres` 或 Testcontainers → Vitest（单测/集成）→ Vitest Browser Mode（装浏览器）→ Playwright（E2E + 视觉 + a11y）→ build。

### 7.1 E2E 实施流程（具体）

**框架组合**：Playwright（浏览器 E2E + API E2E + 视觉 + a11y）+ Vitest Browser Mode（组件级）+ Testcontainers（真实 PG）+ 内置 mock upstream（模拟三协议上游，含 SSE/错误码/429/延迟）。

**运行流程**（Playwright `globalSetup` 统一管生命周期）：

```
1. Testcontainers 起 PG（postgres:16-alpine）→ 拿动态 DATABASE_URL
2. drizzle migrate 建表
3. 启动 app（Hono）于测试端口，连该 PG
4. 启动 mock upstream（模拟 Anthropic/OpenAI/Responses，可配 SSE/429/延迟）
5. 种子配置：建 provider 指向 mock upstream
6. 跑测试
7. globalTeardown：关 app / mock、停容器
```

**配置示例**（`playwright.config.ts`）：

```ts
import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: 'e2e',
  globalSetup: 'e2e/global-setup.ts',     // 起 PG + migrate + app + mock upstream
  globalTeardown: 'e2e/global-teardown.ts',
  use: { baseURL: 'http://127.0.0.1:9100', trace: 'on-first-retry' },
})
```

**用例示例**：

```ts
// API E2E：真实请求 → 断言推理注入 + SSE + 落库
import { test, expect } from '@playwright/test'
test('Anthropic 流式：推理注入 + 落库', async ({ request }) => {
  const res = await request.post('/v1/messages', {
    headers: { 'x-api-key': 'test', 'content-type': 'application/json' },
    data: { model: 'claude-x', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] },
  })
  expect(res.ok()).toBeTruthy()
  expect(await res.text()).toContain('data:')   // SSE 流
  // 断言 mock upstream 收到注入的 reasoning 参数；断言 PG requests 表有这条
})

// 浏览器 E2E：admin 配置流 + 视觉快照
test('配置 provider 并可见', async ({ page }) => {
  await page.goto('/admin/#providers')
  await page.getByRole('button', { name: /新增/ }).click()
  await page.getByLabel('名称').fill('test-provider')
  await page.getByRole('button', { name: /保存/ }).click()
  await expect(page.getByText('test-provider')).toBeVisible()
  await expect(page).toHaveScreenshot('providers.png')
})

// a11y：import AxeBuilder from '@axe-core/playwright'
const { violations } = await new AxeBuilder({ page }).analyze()
expect(violations).toEqual([])
```

**CI 流程**（`.github/workflows/ci.yml`）：

```
checkout → setup node 22 + cache → npm ci
→ npx playwright install --with-deps chromium
→ npx vitest run            # 单测 + 集成（Testcontainers 起 PG，需 Docker）
→ npx playwright test       # E2E + 视觉 + a11y
→ 失败时上传 playwright-report / test-results / trace
```

**原则**：E2E 少而精（只盖关键流），UI 问题主力交给 Vitest Browser Mode；视觉快照管样式回归；mock upstream 让 E2E 不依赖真实上游、可重复、可注入错误测 failover。

## 8. 阶段路线图

> 每阶段另立独立实施计划（含 Implementation Units / Verification Contract）。工作量 S/M/L/XL。

| 阶段 | 目标 | 范围要点 | 量 | 依赖 |
|------|------|----------|----|------|
| **P0 地基与脚手架** | 新栈骨架 + 一键部署 + 测试骨架 | Hono/Drizzle/PG/pino/Zod/Biome/tsup 脚手架；Dockerfile + compose + `.env.example`；drizzle 迁移体系；Vitest+Testcontainers+Playwright 骨架 + CI；目录结构 ADR | M | 无 |
| **P1 协议核心移植** | 新架构跑通基础代理 | 移植 translation/stream-converter + 329 测试；Hono 路由 + 三协议端点；配置加载（PG）；认证；抓包 | L | P0 |
| **P2 推理 canonical + override** | G1 + G2 | canonical reasoning 字段 + 三协议归一/渲染；xhigh 哨兵；后缀解析；值映射；effort↔budget 表；override 引擎（3 操作+模板+条件） | L | P1 |
| **P3 路由 + failover** | G3 | 同 model 多 provider；候选列表预排序 + 执行器重试；三层可重试判定；429 换道；ErrorAware 衰减 + 熔断 lite；流首事件超时/空响应 | L | P1 |
| **P4 可观测性 + 成本** | G4 | TTFT/推理时长打点；EnsureUsage；requests 表每请求日志；usage 扩维；成本核算；dashboard 成本列 | M | P1 |
| **P5 模型管理 + capabilities** | G5 | `/v1/models` + include；模型 card 落库；正则映射 + 模型名还原；上游列表同步 | M | P1 |
| **P6 Admin UI + E2E 全覆盖** | 管理面收尾 | provider/adapter/override/model/cost 页面重建；Playwright admin E2E 全流；i18n | M | P2–P5 |
| **P7（触发式）协议扩展** | 按需 | gemini/embedding/image 等；届时评估 hub-and-spoke 重构（N=4 才有收益） | XL | P2 |

## 9. 风险与取舍

- **重写风险**：greenfield 有过渡期回归风险。缓解：移植协议核心 + 保留 329 测试作安全网；旧 0.x 保留 dist-tag；1.0.0 明确破坏性变更。
- **PG 必需 = 产品形态变化**：从"npm 零依赖"变为"Docker（或 npm+外部 PG）"。README/定位/安装文档要同步改。这是"往前走"的既定代价。
- **配置迁移**：旧 YAML → PG 需 `migrate` CLI；旧格式硬报错 + 迁移指引（沿用旧计划 KD8/R18 思路）。
- **范围膨胀**：P1–P6 是数周工作量。按阶段独立计划推进，每阶段可单独验收/发布，避免大爆炸。
- **技术栈未最终验证**：Hono/Drizzle 组合需在 P0 用真实 SSE 流式 + PG 做 spike 验证后再全面铺开。

## 10. 取代关系

本计划取代：
- `2026-07-27-001-feat-reasoning-templates-and-model-capabilities-plan.md`（推理模板 + capabilities，其 R1 模板/R10 thinkingLevelMap 暂不做，R2/R5/R13 思路并入 P2/P5）
- `2026-07-25-001-feat-web-only-dynamic-model-capabilities-plan.md`
- `2026-07-25-002-feat-generic-browser-reasoning-mappings-plan.md`

ADR 0002/0003 的"能力归属/适配器描述"假设在 PG + AxonHub 式模型管理下需重审，见 ADR 0004。

## 11. 决策记录（已定，2026-07-27）

经讨论，以下选型全部敲定（用户“就按你来”授权）：

1. **HTTP 框架：Hono**。Web Standards 模型贴合流式代理（上游 fetch body 近乎零拷贝管道给客户端）；Express 成熟但 Node 流模型代理贴合度低、SSE 更易出缓冲 bug、Express 4 吞异步错误；Fastify 为中间选项。
2. **构建：tsup**（esbuild）。稳、零配置、干净 dist；Rust 的 tsdown/Rolldown 对本项目体量提速不可感知（build 已毫秒级，瓶颈在 tsc 类型检查，而 Rust 工具不查类型）；求稳选 tsup，类型检查由 `tsc --noEmit`（CI）把关。
3. **ORM：Drizzle**（+ postgres-js 驱动 + drizzle-kit 迁移）。
4. **迁移策略：greenfield 架构 + 移植协议核心 + 1.0.0 bump**（确认）。
5. **领域配置落 PG、admin 编辑**（确认；YAML 仅作可选导入/种子）。
6. **旧 plan：保留 SUPERSEDED 标记**，不 `git rm` 物理删除（git 历史已足够）。
7. **P0：先做技术栈 spike**（Hono + Drizzle + PG + SSE 透传 + Vitest/Playwright 空骨架），验证通过再全面脚手架。

其余技术栈按 §3 / §3.2：Node 22 / Zod / pino / Vitest / Playwright / Testcontainers / Biome / citty / Appica UI（§3.1）。

## 12. 并发开发协议（worktree + subagent 模式）

用户选定：**N 个独立 worktree + N 个 subagent 各领一个功能 + 其测试，并发实现**，集成者统一审查合并。用 worktree 隔离避免共享工作区冲突。

### 12.1 适用与顺序
- **顺序（地基）**：P0 脚手架 → P1 协议核心。后续都依赖 P1，必须先完成。
- **并发（功能）**：P1 完成后，P2/P3/P4/P5 互相独立，并发实现。
- **收尾（顺序）**：P6 Admin UI + E2E 全覆盖，在并发单元合并后统一做（避免并发单元各自改 UI）。

### 12.2 可并发单元
| 单元 | 内容 | worktree / 分支 |
|------|------|-----------------|
| P2 | 推理 canonical + override 引擎 | gateway-p2-override / muta/feat_gateway-p2-override |
| P3 | 多上游路由 + failover | gateway-p3-failover |
| P4 | 可观测性 + 成本 | gateway-p4-observability |
| P5 | 模型管理 + capabilities | gateway-p5-models |

每个 worktree 从 **P1 完成后的同一基线**切出（`gwt create ... -r <P1 合并点>`），保证起点一致。

### 12.3 启用干净并发的前提（关键）
为让 P2–P5 真并发、少冲突，**P1 地基里先定好公共接口**：
- canonical reasoning 字段 + 核心请求/路由类型（P2/P3/P4 都会引用）；
- PG schema 基线 + drizzle 迁移编号规则（预留各单元加表/列的命名约定）；
- 公共错误/可重试判定接口（P3 用）。
P2 因此只实现“模板/override”本身，不再独占 canonical 字段定义权。

### 12.4 subagent 任务契约（每个并发单元）
- 领一个功能单元 + 其分层测试（§7：单测/集成/E2E）。
- 在自己 worktree 内实现 + 跑通测试 + 自检（typecheck/test/build）。
- **只改本单元相关文件**；需改公共模块（schema/types/核心）时**标记上交**，不擅自改。
- 结构化汇报：实现内容、测试结果、改动文件清单、风险、对公共代码的诉求。

### 12.5 集成者（主 agent）职责
- 逐个代码审查。
- 按“改动面小/风险低优先”顺序合并回主分支。
- 解冲突高发区：drizzle 迁移编号、package.json 依赖、公共类型、核心请求对象。
- 每次合并后跑全量单测/集成 + Playwright E2E 回归。

### 12.6 编排机制
- 用 **workflow `parallel()`** 扇出 N 个 agent（各 cwd=其 worktree）再扇入综合；或直接派发 N 个 subagent。
- 失败的单元返回 null，集成时单独处理，不阻塞其他单元。
