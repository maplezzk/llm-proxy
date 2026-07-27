# ADR 0004: PG-only + TS best-in-class 栈 + greenfield 移植

- 状态：accepted（地基决策已定；具体框架选型见主计划 §11 待最终确认）
- 日期：2026-07-27
- 相关：`docs/plans/2026-07-27-002-master-axonhub-class-gateway-plan.md`、`docs/research/axonhub-analysis.md`
- 重审：ADR 0002（模型能力归属）、ADR 0003（适配器有效描述）在 PG + AxonHub 式模型管理下的假设

## 背景

通过对 AxonHub 源码的深度扫描，决定把 llm-proxy 升级为 AxonHub 级本地网关（除多租户）。需要锁定底层技术决策，避免后续阶段"抄着抄着跑偏"。

## 决策

1. **语言：TypeScript / Node 22 LTS。** 不做 Go 重写——Go 重写会丢 npm 分发、现有用户、329 测试，且 Go 的并发/单二进制优势对单用户本地代理无感。
2. **数据库：PostgreSQL-only。** 移除 `better-sqlite3`。所有持久化落 PG。
   - **环境隔离 = 独立数据库（复用现有 PG 实例）**：复用本机 Docker 已有的 `postgres` 容器（postgres:16-alpine，网络 `shared-net`，用户 `dev`），建专用 database `llmproxy_dev`/`llmproxy_prod`，由 `DATABASE_URL` 指向；不自带 PG、不用 SQLite fallback、不用多 DB 方言。部署时 compose 只定义 app 服务，经 external 网络 `shared-net` 以 DNS 名 `postgres` 访问。
   - ORM 用 Drizzle（TS-first、SQL 风格、迁移完善），迁移用 drizzle-kit，应用启动自动 migrate。
3. **配置：`.env` 管基建**（`DATABASE_URL`/`PORT`/`PROXY_KEY`/`LOG_LEVEL`），提交 `.env.example`；**领域配置（providers/adapters/models/override）落 PG，admin 可编辑**。
4. **部署：Docker 一键**（compose：postgres:16-alpine + app，healthcheck + 启动 migrate）。`npm i -g` 保留但需外部 PG，定位转向 Docker 为主。
5. **技术栈 best-in-class（推荐，待 §11 确认）**：Hono（HTTP）/ Drizzle（ORM）/ postgres-js（驱动）/ Zod（校验）/ pino（日志）/ tsup（构建）/ Vitest（单测集成）/ Playwright（E2E）/ Testcontainers（测试 DB）/ Biome（lint）/ citty（CLI）。Admin UI 沿用 React 19 + Appica + 单文件。
6. **测试 day-1**：Vitest + Testcontainers（真实 PG）+ Playwright（admin 浏览器 E2E + API E2E）从 P0 进 CI。
7. **迁移策略：greenfield 架构 + 移植协议核心。** 新架构/新栈/新 schema 不受旧代码束缚；但 `translation.ts`/`stream-converter.ts` + 329 测试作为协议正确性资产**移植保留**，不重写。npm 包名不变，**1.0.0 主版本 bump** 标记破坏性变更（PG 必需）。
8. **UI 组件框架：沿用 Appica UI**（Base UI 无头 + Tailwind v4）。不引入 Element（Vue 框架，与 React admin 不兼容）/ Ant Design（重型 + 自带设计语言 + CSS-in-JS，与 Tailwind v4 + 单文件打包冲突）。唯一备选 shadcn/ui（同哲学：Radix+Tailwind；AxonHub 前端即 shadcn-admin）；迁移触发条件：Appica 停更 / 缺关键组件 / 严重 bug。保持 `lib/` 共享封装薄而集中以便未来机械迁移。

## 永久跳过（非团队功能也不做）

- 多租户全家桶：登录注册/RBAC/project 隔离/配额/API Key 四类型。
- 单用户用不上的规模化机制：EWMA 延迟打分/防扎堆/per-(channel,model) 熔断状态机/6 关联类型全套/4 套 LB × 8 策略。
- 换语言（Go）、GraphQL admin、多 DB 方言、对象存储卸载。
- hub-and-spoke 转换层重构（N=3 协议时两两转换更简单，触发式，真要加 gemini 再评估）。

## 理由

- **PG-only 而非 SQLite fallback**：用户明确要 PG、要"无历史包袱"；每请求日志/成本是写多场景，PG 更稳；JSONB 适合半结构化数据；self-host 标配。环境用独立 database 隔离即可，无需 SQLite 兜底。
- **TS 而非 Go**：分发（npm）、现有用户、329 测试、TS 全栈一致是真实护城河；AxonHub 选 Go 的理由全绑在多租户平台上，剥离后不成立。
- **迁能力不迁架构**：AxonHub 约一半复杂度是"有状态平台地基"（ent/27 实体/GraphQL/fx），非多租户本身；砍多租户后这些不会变轻。80% 实用价值来自高 ROI 子集。
- **greenfield + 移植**：既"无历史包袱"（新架构/栈/DB），又不丢弃血泪协议正确性（移植 + 保留测试）。

## 后果

- 产品形态从"npm 零依赖本地代理"变为"Docker 一键（或 npm+外部 PG）的本地网关"，README/定位/安装文档同步改。
- 新增迁移体系（drizzle-kit）与配置迁移 CLI（旧 YAML → PG）。
- 旧 0.x 保留 npm dist-tag；1.0.0 为 PG 版，破坏性变更。
- ADR 0002/0003 的能力归属/适配器描述假设需在 P5（模型管理）重审。
