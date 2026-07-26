# 上游 React Web-only 迁移与推理配置重建实施计划

> **For agentic workers:** 实施前必须先阅读本计划、`docs/plans/2026-07-25-001-feat-web-only-dynamic-model-capabilities-plan.md`、`docs/plans/2026-07-25-002-feat-generic-browser-reasoning-mappings-plan.md`，并使用 `subagent-driven-development` 或 `executing-plans` 逐单元执行。除非用户明确选择执行，否则本计划只作为设计和评审文档，不直接修改代码。

**Goal:** 在不覆盖当前 Alpine Fork 的前提下，以 `upstream/main` 的 React Admin 为新的 Web-only 基线，删除 Mac App 交付链，恢复开发环境隔离，并在第二批工作中重新实现 Provider 模型能力、Reasoning mappings、推理模板和 Adapter 推理等级。

**Architecture:** 第一批不把旧 Alpine Admin 与 React Admin 混合，而是从干净的 `upstream/main` 创建迁移分支，只选择性恢复开发隔离和必要的 Fork 运行能力，同时移除 Mac App。第二批以 React Admin 的页面、API 类型和状态模式为基础，重新接入配置模型、完整配置校验、推理模板 API、Provider 模型能力和 Adapter 推理策略；不直接搬运旧 Alpine UI。

**Tech Stack:** Node.js 20+、TypeScript ESM、React 19、Vite、Appica UI、YAML、原生 `node:test` + `tsx`、GitHub Actions、npm。

---

## 1. 问题背景与已确认事实

### 1.1 Git 基线

本计划基于 2026-07-26 的只读盘点：

- 当前 Fork 的 `origin/main` 指向 `fd7e653`，当前工作分支为 `feature/web-only-dynamic-model-capabilities`，HEAD 为 `03bbba4`。
- `upstream/main` 当前指向 `16ae55b`，包含 React Admin 迁移以及后续 Responses 协议修复；`665eafd` 的协议转换修复不能因前端迁移而丢失。
- Fork 相对上游保留了旧 Alpine Admin、开发环境隔离和推理配置定制；双方在 Admin 架构、构建脚本、配置模型和发布链上均有交叉修改。
- `llm-proxy-upstream-sync` worktree 当前处于冲突和未清理状态，不能继续作为实施目录。不得对其执行 `git clean`、无确认的 `reset --hard` 或删除操作。
- 当前主 worktree 存在未跟踪的 `CONTEXT.md`、`docs/adr/`、`docs/grills/`、计划文件以及临时草稿；这些内容不是本次迁移的实现输入，不得被清理、覆盖或纳入迁移提交。

### 1.2 架构差异

上游的新 Admin 位于：

- `admin-ui/src/App.tsx`
- `admin-ui/src/pages/ProvidersPage.tsx`
- `admin-ui/src/pages/AdaptersPage.tsx`
- `admin-ui/src/pages/DashboardPage.tsx`
- `admin-ui/src/pages/LogsPage.tsx`
- `admin-ui/src/pages/CapturePage.tsx`
- `admin-ui/src/pages/SettingsPage.tsx`
- `admin-ui/src/lib/api.ts`
- `admin-ui/src/lib/api-types.ts`

当前 Fork 的旧 Admin 使用 Alpine 和静态 HTML。直接执行 `git merge upstream/main` 会把已删除的旧 Admin、React 构建体系、旧 Mac 发布链和 Fork 的旧配置实现混在一起，冲突范围大且难以长期同步。因此本计划采用“新上游基线 + 选择性迁移”的策略，而不是普通 Merge。

### 1.3 既有设计文档的关系

以下文件保留为既有需求和设计参考，不被本计划覆盖：

- `docs/plans/2026-07-25-001-feat-web-only-dynamic-model-capabilities-plan.md`
- `docs/plans/2026-07-25-002-feat-generic-browser-reasoning-mappings-plan.md`

其中第一份偏向 Web-only、模型能力和推理模板的完整行为，第二份补充了浏览器可维护的通用 `set` 参数、自动清理冲突字段和兼容旧模板的规则。本计划负责把这些能力重新落到上游 React 基线上，并明确迁移顺序和 PR 边界。

---

## 2. 已定决策与边界

1. 保留当前 `origin/main` 和 Alpine 版本作为备份、回滚和行为参考；不删除远程 `main`，不强制推送，不直接覆盖主分支。
2. 实施前创建并推送备份分支，例如 `backup/main-alpine-2026-07-26`。
3. 第一批从干净的 `upstream/main` 创建迁移分支，目标是 React Web-only 基线。
4. 第一批删除 Mac App、DMG/Homebrew/自动更新发布链及其专属文档和资源。
5. 第一批恢复并验证开发环境隔离：开发配置、端口、数据目录、PID、日志和 SQLite 用量库均与正式服务分离。
6. 第一批不迁移旧 Alpine Admin 的推理映射 UI，不在 React 页面中临时嵌入 Alpine 代码。
7. 第二批重新实现推理模型配置、Reasoning mappings、推理模板和 Adapter 推理等级；后端能力可以选择性迁移已有实现，但 UI、API 类型和交互必须适配 React。
8. 不修改 Pi 配置、`.pi/**`、`CONTEXT.md`、`docs/adr/**`、`docs/grills/**` 和已有计划文件。
9. 所有破坏性配置变更必须显式报错或提供兼容读取，不得静默丢字段、静默降级推理等级或静默跳过无效模型映射。
10. 每一批通过独立分支和 PR 合入自己的仓库；第一批合入后才开始第二批。

---

## 3. 目标分支和 PR 结构

```text
origin/main
├── backup/main-alpine-2026-07-26
└── feature/react-web-only-migration
        └── PR 1 → origin/main

origin/main（PR 1 合入后）
└── feature/react-reasoning-config
        └── PR 2 → origin/main
```

禁止采用以下方式：

```text
upstream/main → 直接推送 origin/main
旧 Fork + upstream/main → 在冲突 worktree 中继续强行合并
```

### PR 1：React Web-only 基线

交付内容：

- 上游 React Admin 成为唯一 Admin 前端；
- Mac App 和发布链下线；
- 开发环境隔离恢复；
- Node CLI、Admin 静态资源和后端代理能力通过测试；
- 不包含新的推理配置 UI。

### PR 2：React 推理配置与 Reasoning mappings

交付内容：

- Provider Model 能力字段和推理模板；
- Adapter Mapping 的统一推理等级；
- 浏览器可维护的通用推理参数；
- 完整配置图校验和原子写入；
- Adapter `/v1/models` 能力描述；
- React Provider、Adapter 和独立 Reasoning mappings 页面；
- 相关后端、协议转换、测试和文档。

---

## 4. 实施单元

## PR 0：安全基线和迁移准备

**目标：** 在任何代码迁移前固定回滚点，处理脏 worktree 风险，确保用户草稿不受影响。

**Files:**

- Git-only：`origin/main`、`upstream/main`、备份分支和新 worktree
- Read-only：`CONTEXT.md`、`docs/adr/`、`docs/grills/`、现有 `docs/plans/`
- Read-only：`llm-proxy-upstream-sync` worktree 的冲突状态

**Steps:**

- [ ] 记录当前主 worktree 的 `git status --short`、当前分支、HEAD、远程和 worktree 列表，保存为迁移前基线。
- [ ] 检查 `llm-proxy-upstream-sync` 中所有 `M/A/D/UU/??` 文件，确认是否存在需要保留的未提交内容；在未确认前不删除该 worktree。
- [ ] 从 `origin/main` 创建 `backup/main-alpine-2026-07-26`，确认备份分支内容与当前 Fork 基线一致后再推送到 `origin`。
- [ ] 创建新的干净 worktree，基于 `upstream/main` 创建 `feature/react-web-only-migration`；禁止在冲突 worktree 上继续实施。
- [ ] 在新 worktree 中只安装依赖和读取代码，不复制主 worktree 的未跟踪草稿。
- [ ] 记录上游关键提交（React Admin 迁移、Responses 修复、`.pi` 忽略）和 Fork 关键提交（Web-only/能力、推理弹窗、开发隔离），后续用功能行为而不是提交顺序选择性迁移。

**Acceptance:** 旧 Fork 有可推送的回滚分支；新迁移 worktree 从干净的 `upstream/main` 开始；用户未跟踪文件没有被删除、移动、修改或暂存。

**Verification:**

```bash
git status --short
git branch --list 'backup/main-alpine-2026-07-26' 'feature/react-web-only-migration'
git worktree list
git diff --stat origin/main backup/main-alpine-2026-07-26
```

---

## PR 1 / U1：建立 React Admin 和 Node 构建基线

**目标：** 确认上游 React Admin 是唯一前端，并让 Node 构建可以稳定产出 Admin 静态资源。

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Read/Modify if required: `tsconfig.json`、`admin-ui/vite.config.ts`
- Read/Modify if required: `src/api/server.ts`、`src/api/admin-assets.ts`、`src/index.ts`
- Read: `admin-ui/src/App.tsx`、`admin-ui/src/lib/api.ts`、`admin-ui/src/lib/api-types.ts`
- Test: `test/api/admin-assets.test.ts`、`test/api/integration.test.ts`

**Steps:**

- [ ] 以 `upstream/main` 的 React 依赖和 Vite 构建配置为基准，不把旧 Alpine Admin 文件恢复到迁移分支。
- [ ] 确认 `npm run build` 的顺序为 TypeScript 编译、React Admin Vite 构建和 Admin HTML 复制；构建产物能被 `src/api/server.ts` 的 `/admin/` 和 `/admin-app.js` 路由读取。
- [ ] 保留 `npm run typecheck`、`npm test`、`npm run generate:i18n-types`、`npm run dev:admin` 和 Node CLI 的发布入口。
- [ ] 清理由旧 Alpine Admin 引入、但 React Admin 不再使用的构建脚本、静态 Admin 资源复制逻辑和未引用依赖；只有通过引用搜索确认无调用后才删除。
- [ ] 保留上游 `665eafd` 的 Responses 协议转换和用量统计修复，不在前端迁移中重写或回退协议转换代码。
- [ ] 为 Admin HTML、Admin bundle 和核心静态资源保留回归测试；测试必须区分“构建产物不存在”和“开发环境未构建”两类错误。

**Acceptance:** React Admin 可以通过 Node 服务访问；构建产物与源码页面一致；旧 Alpine Admin 不再被构建或路由加载；Responses 修复仍在当前分支。

**Verification:**

```bash
npm install
npm run generate:i18n-types
npm run typecheck
npm run build
node --import tsx --test test/api/admin-assets.test.ts test/api/integration.test.ts
```

---

## PR 1 / U2：删除 Mac App 和原生发布链

**目标：** 将产品交付收敛为 Node CLI + 浏览器 Admin，不留下可误触发的 Mac 构建入口。

**Files:**

- Delete: `app/`
- Delete: `scripts/mock-update-server.js`
- Delete: `.github/workflows/release-app.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `package.json`、`package-lock.json`、`.gitignore`
- Modify/Delete after tracked-file audit: `docs/images/macos-cn.png`、`docs/images/macos-cn2.png`、`docs/images/macos-en.png`、`docs/images/macos-en2.png`
- Modify: `README.md`、`README.zh.md`、`DEVELOPMENT.md`、`docs/api-spec.md`

**Steps:**

- [ ] 删除 Swift package、Mac 资源、Mac 测试、`app/scripts/build.sh` 和 mock update server；不得留下空壳入口或替代菜单栏实现。
- [ ] 从 `package.json` 删除 `build:app` 及仅服务 Mac 的脚本；保留 Node `build`、`build:prod`、`test`、`typecheck`、`prepublishOnly` 和 CLI `bin`。
- [ ] 从发布 workflow 删除 Bun/Swift/DMG/Homebrew/update 任务和相关 secret 使用；保留 Node/npm 发布流程。对外部 Homebrew tap 或历史 Release 的停用只在发布清单中记录，不在本地伪称已完成。
- [ ] 删除文档中的 DMG、Homebrew、桌面自动更新、quarantine 和 Swift 构建说明；保留 Node CLI、浏览器 Admin 和 API 使用说明。
- [ ] 用 `git grep` 检查 `build:app`、`release-app`、`mock-update-server`、`DMG`、`Homebrew`、`UpdateChecker` 等引用；历史 CHANGELOG 是否保留要按“历史记录还是活跃入口”区分，不能盲删。

**Acceptance:** 仓库不再提供 Mac App 构建、发布或自动更新入口；Node CLI/npm 发布和 React Admin 交付链仍完整。

**Verification:**

```bash
test ! -d app
test ! -e scripts/mock-update-server.js
test ! -e .github/workflows/release-app.yml
node -e "const p=require('./package.json'); if (p.scripts['build:app']) process.exit(1)"
git grep -n -E 'build:app|release-app|mock-update-server|UpdateChecker' -- ':!CHANGELOG.md' || true
```

---

## PR 1 / U3：恢复并验证开发环境隔离

**目标：** 让开发服务独立于正式服务，不修改正式配置、端口、PID、日志或用量库。

**Files:**

- Create/Restore: `scripts/dev.ts`
- Modify: `package.json`
- Read/Modify if required: `src/index.ts`、`src/cli/commands.ts`
- Test/Verification: `test/cli/commands.test.ts`、开发脚本 smoke 测试材料
- Preserve outside Git: `~/.llm-proxy/dev/`

**Required behavior:**

- 正式服务默认端口 `9000`，正式目录 `~/.llm-proxy/`，正式 PID `/tmp/llm-proxy.pid`。
- 开发服务默认端口 `9004`，开发目录 `~/.llm-proxy/dev/`，开发 PID `/tmp/llm-proxy-dev.pid`。
- 开发配置默认 `~/.llm-proxy/dev/config.yaml`；首次初始化时按既有优先级选择 `config.mirror.yaml`、`config.yaml.migrated`、`config.yaml`，后续不自动覆盖开发配置。
- 开发服务的日志、SQLite 用量库和视觉缓存必须位于开发数据目录或开发专属位置。
- `npm run dev -- init|start|stop|restart|status` 支持 `--config`、`--data-dir`、`--port`、`--host`、`--foreground` 等既有参数。

**Steps:**

- [ ] 将 Fork 的 `scripts/dev.ts` 恢复到 React 基线，并适配上游 `src/index.ts`/`src/cli/commands.ts` 的实际参数解析，不复制旧 Admin 代码。
- [ ] 确认开发脚本只通过参数或显式环境传递开发配置，不修改 `~/.llm-proxy/config.yaml`，不停止端口 `9000` 的正式服务。
- [ ] 保留 `/admin/health` 启动检查、启动超时、PID 所有权检查、SIGTERM 优雅停止和必要时的超时退出。
- [ ] 若上游 CLI 缺少 `--data-dir`、独立 PID 或日志覆盖能力，在 `src/cli/commands.ts` 增加最小兼容改动；不为开发脚本重新设计 CLI。
- [ ] 增加命令行为测试或可重复 smoke：`init` 不启动服务，`start` 使用 9004，`status` 显示开发实例，`stop` 不影响正式 PID，`restart` 只重启开发实例。

**Acceptance:** 开发服务可以独立启动、查询、重启和停止；正式服务配置和 9000 进程不被修改或停止；开发数据不会写入正式目录。

**Verification:**

```bash
npm run dev -- init
npm run dev -- start
npm run dev -- status
curl -fsS http://127.0.0.1:9004/admin/health
npm run dev -- stop
```

真实 API smoke 使用 `~/.llm-proxy/dev/config.yaml`，至少验证一次 OpenAI Adapter 或 Anthropic Adapter；不得使用正式配置作为测试配置。

---

## PR 1 / U4：第一批回归、PR 评审和合入

**Files:**

- Test scope: `test/cli/commands.test.ts`、`test/api/admin-assets.test.ts`、`test/api/integration.test.ts`、现有全量测试
- Package scope: `package.json`、`package-lock.json`、发布 workflow

**Steps:**

- [ ] 运行全量测试、类型检查和生产构建；记录每个失败属于代码、迁移冲突、依赖安装、环境还是外部服务，不用重复运行掩盖原因。
- [ ] 执行 Node 服务 smoke：`/admin/health`、`/admin/`、`/admin-app.js`、`/v1/models` 和至少一个真实上游请求。
- [ ] 使用 `npm pack --dry-run --json` 检查 npm 包包含 `dist`、Admin 资源、`bin/llm-proxy.js` 和 `locales`，不包含 `app/` 或 updater。
- [ ] 检查 `git diff --check`、`git status --short` 和变更文件清单，确认没有 `.pi/**`、用户草稿或冲突标记。
- [ ] 以 PR 形式提交 `feature/react-web-only-migration`，在 PR 合入前不开始 PR 2。

**PR 1 验收矩阵：**

| 范围 | 验证 | 通过条件 |
| --- | --- | --- |
| 前端构建 | `npm run build` | React bundle 和 HTML 产物存在 |
| 类型 | `npm run typecheck` | 退出码为 0 |
| 单元/集成 | `npm test` | 全量测试通过 |
| Admin 静态资源 | `/admin/`、`/admin-app.js` | 页面和 bundle 可访问 |
| 开发隔离 | 9004 health/status/stop | 不触碰 9000 正式服务 |
| 包内容 | `npm pack --dry-run --json` | Node/Web 资产存在，Mac 资产不存在 |
| 发布链 | workflow 和 package 审查 | 无 Swift/DMG/Homebrew/update 构建入口 |

---

## PR 2 / U5：迁移并收敛推理配置后端模型

**目标：** 将 Fork 已有的模型能力和推理映射设计，适配干净 React 基线上的配置、路由和 API；不复制旧 Alpine 页面。

**Files:**

- Modify: `src/config/types.ts`
- Modify: `src/config/parser.ts`
- Modify: `src/config/validator.ts`
- Modify: `src/config/store.ts`
- Modify: `src/api/handlers/base.ts`
- Modify: `src/api/handlers/provider-crud.ts`
- Modify: `src/api/handlers/adapter-crud.ts`
- Create/Modify: `src/api/handlers/reasoning-template-crud.ts`
- Modify: `src/api/handlers/index.ts`、`src/api/server.ts`
- Modify: `src/proxy/types.ts`、`src/proxy/router.ts`、`src/proxy/translation.ts`
- Modify: `src/adapter/router.ts`、`src/adapter/handlers.ts`
- Test: `test/config/parser.test.ts`、`test/config/store.test.ts`、`test/config/validator.test.ts`
- Test: `test/api/handlers.test.ts`、`test/api/integration.test.ts`
- Test: `test/adapter/router.test.ts`、`test/adapter/handlers.test.ts`
- Test: `test/proxy/router.test.ts`、`test/proxy/translation.test.ts`

**Target contract:**

- Provider Model 声明 `contextWindow`、`maxTokens`、`input`、`reasoning` 和 `reasoningTemplate`。
- Adapter Mapping 声明稳定的 `sourceModelId`、目标 Provider、目标模型和 `reasoningLevel`。
- 统一等级为 `off | minimal | low | medium | high | xhigh | max`。
- 推理模板每个等级最终采用 `{ set: JsonObject } | null`；`null` 表示显式关闭，缺少等级表示不可用。普通 UI 不暴露 `clear`。
- 模板只能修改推理参数顶层键；禁止覆盖 `model`、`messages`、`input`、`stream`、`tools`、`system`、`instructions`、`max_tokens`、`max_output_tokens` 等请求主体字段。
- 旧模板的直接字段可以兼容读取，并在下一次写入时规范化为 `set`；旧 Adapter `max_tokens` 和旧 mapping raw thinking 字段不能被静默丢弃，若无法无歧义迁移则返回字段路径明确的迁移错误。

**Steps:**

- [ ] 先对比 `upstream/main` 当前 `ThinkingConfig`/`Model`/`AdapterModelMapping` 与既有计划中的目标模型，形成字段迁移表；以实际上游代码为基准，不假设 Fork 提交可以直接 cherry-pick。
- [ ] 更新 TypeScript 类型和 YAML parser/serializer，确保配置 load → serialize → reload 不丢模板、模型能力、引用和统一等级。
- [ ] 在 `validateConfig()` 中校验完整配置图：模板名、等级键、模型能力、模板引用、Provider/Model 引用、Adapter source ID 唯一性、目标模型存在性和 level 可用性。
- [ ] 所有 Admin 写入路径均复制完整 Config、应用候选修改、执行完整校验后原子写入；失败不得写盘、更新内存或增加版本号。
- [ ] 增加模板 CRUD API，至少支持列表、创建、更新和删除保护；被引用模板不可删除，更新导致已有 Adapter level 失效时必须整体拒绝。
- [ ] 将 Adapter route 解析为明确的 policy：直连请求没有 Adapter policy，`off` 是显式关闭，非 `off` 是已解析的模板 set；不得把 `undefined` 当作 `off`。
- [ ] 清理客户端传入的旧/新推理字段，再应用 Adapter 固定 policy；`off` 不能被客户端重新打开，不能使用最近档位或固定默认值静默降级。
- [ ] 保留上游 Responses 协议修复和既有多轮 thinking 签名兼容；新增逻辑只能消费已解析 policy。
- [ ] `GET /{adapter}/v1/models` 返回来自本地目标 Model 的 `capabilities`：`contextWindow`、`maxTokens`、`input`、`reasoning`、`reasoningLevel`；直连 `GET /v1/models` 的 JSON shape 保持不变，不泄露模板名或供应商低层字段。

**Acceptance:** 后端可以从本地配置生成可靠的模型能力和 Adapter 推理策略；配置写入具有完整图校验和原子失败语义；跨 Anthropic/OpenAI/OpenAI Responses 的推理参数转换和 `off` 关闭行为有回归测试。

**Verification:**

```bash
node --import tsx --test test/config/parser.test.ts test/config/store.test.ts test/config/validator.test.ts
node --import tsx --test test/api/handlers.test.ts test/api/integration.test.ts
node --import tsx --test test/adapter/router.test.ts test/adapter/handlers.test.ts test/proxy/router.test.ts test/proxy/translation.test.ts
npm run typecheck
```

---

## PR 2 / U6：React Provider 和 Adapter 配置页面

**目标：** 在 React Admin 中重新实现模型能力、模板引用和 Adapter 推理等级选择，不搬运旧 Alpine 组件。

**Files:**

- Modify: `admin-ui/src/pages/ProvidersPage.tsx`
- Modify: `admin-ui/src/pages/AdaptersPage.tsx`
- Create: `admin-ui/src/pages/ReasoningMappingsPage.tsx`
- Modify: `admin-ui/src/App.tsx`
- Modify: `admin-ui/src/components/Sidebar.tsx`
- Modify: `admin-ui/src/lib/api.ts`
- Modify: `admin-ui/src/lib/api-types.ts`
- Modify: `admin-ui/src/lib/app-state.tsx`、`admin-ui/src/lib/form-helpers.tsx` if current state pattern需要
- Modify: `admin-ui/src/i18n.ts`
- Modify: `locales/zh/translation.json`、`locales/en/translation.json`
- Generated: `src/types/i18n.generated.ts`
- Test/Verification: `test/api/integration.test.ts`、React build/typecheck、浏览器 smoke

**Steps:**

- [ ] 扩展 `admin-ui/src/lib/api-types.ts`，让 Provider Model、Adapter Mapping、Reasoning Template、Capabilities 和 API 错误结构与后端契约一致；禁止在前端类型中继续保留无来源的旧 raw 字段。
- [ ] 在 `ProvidersPage.tsx` 的模型表单中增加 ID、context window、最大输出、输入模态、是否支持 reasoning、模板引用；不在 Provider 页面直接编辑供应商低层参数。
- [ ] 在 `AdaptersPage.tsx` 中只展示 source ID、目标 Provider、目标模型和可用 `reasoningLevel`；切换目标模型时重新计算等级候选并清空失效选择；非推理模型只允许 `off`。
- [ ] 新增独立 `ReasoningMappingsPage.tsx`，支持模板列表、新增、复制、编辑、引用影响查看和删除保护。
- [ ] 模板编辑器按统一等级展示启用状态和 JSON object `set` 编辑区；`off` 使用 null；JSON 解析失败、受保护键、缺少 medium、未知等级和引用冲突必须显示可见错误，不得在 `filter()` 中静默丢行。
- [ ] 在 `App.tsx` 和 `Sidebar.tsx` 注册新页面和 hash tab；非法 hash 继续回退到 dashboard，既有 Dashboard/Logs/Capture/Settings 页面不做无关重构。
- [ ] 复用 React Admin 现有 `fetchJson`、toast、confirm、Appica UI 和表单状态模式；不要重新引入 Alpine、静态 HTML 组件或第二套 API 客户端。
- [ ] 增加中英文翻译并运行 i18n 类型生成；检查页面没有 missing key、未处理 API 错误或 console 中的 undefined expression。

**Acceptance:** 管理员可以在浏览器中完成“创建模板 → 绑定 Provider Model → 创建 Adapter Mapping → 选择合法推理等级 → 修改模板并立即影响后续请求”；旧 raw thinking/budget/effort 控件不再出现。

**Verification:**

```bash
npm run generate:i18n-types
npm run typecheck
npm run build
node --import tsx --test test/api/integration.test.ts
```

浏览器 smoke 必须覆盖：

1. 中英文切换；
2. 新建、复制、编辑和删除未引用模板；
3. 尝试删除已引用模板并确认后端拒绝；
4. Provider Model 绑定模板并填写能力；
5. Adapter 切换目标模型，确认无效等级被清除且不可提交；
6. 非推理模型只出现 `off`；
7. 非法 JSON、受保护键和缺少必填能力时，错误可见且数据不落盘；
8. 修改模板后刷新 Adapter 模型列表，确认 `capabilities` 即时反映当前配置；
9. 浏览器 Console 无 React warning，Network 请求没有把 API key、模板低层字段泄露到模型列表。

---

## PR 2 / U7：样例、API 文档和迁移说明

**Files:**

- Modify: `samples/config.yaml`
- Modify: `README.md`、`README.zh.md`
- Modify: `DEVELOPMENT.md`
- Modify: `docs/api-spec.md`
- Preserve: `docs/plans/2026-07-25-001-feat-web-only-dynamic-model-capabilities-plan.md`
- Preserve: `docs/plans/2026-07-25-002-feat-generic-browser-reasoning-mappings-plan.md`

**Steps:**

- [ ] 将 sample 配置更新为可解析、可校验的完整模板/Provider/Adapter 示例，明确 `off`、`medium`、模型能力和统一等级。
- [ ] 文档说明 React Admin 中的配置入口、Adapter 模型能力响应、通用推理参数、受保护字段、旧字段兼容和无静默降级规则。
- [ ] 明确直连 `/v1/models` 与 Adapter `/{name}/v1/models` 的响应差异；文档不暴露 API key、模板内部字段或供应商低层实现细节。
- [ ] 写出手工迁移顺序：创建模板 → 补充 Provider Model 能力 → 绑定模板 → 为 Adapter Mapping 选择等级 → 删除旧字段；无法安全迁移的字段必须按错误信息处理。
- [ ] 不修改 Pi 配置、`.pi/**` 或用户未跟踪草稿，不把本计划或既有计划伪装成已完成实现。

**Acceptance:** 新用户可以依据 sample 和文档完成配置；旧配置遇到不安全迁移时能看到明确错误；文档和 React UI 使用同一套术语。

**Verification:**

```bash
node --import tsx --test test/config/parser.test.ts test/config/validator.test.ts
rg -n "reasoningLevel|reasoning_template|contextWindow|maxTokens|pull-models|build:app" README.md README.zh.md DEVELOPMENT.md docs/api-spec.md samples/config.yaml
```

---

## PR 2 / U8：第二批完整回归和合入

**Files:**

- Test scope: `test/config/**`、`test/api/**`、`test/adapter/**`、`test/proxy/**`、`test/status/**`
- Build scope: `package.json`、`admin-ui/**`、`dist/`（生成物，不直接提交）

**Steps:**

- [ ] 先运行推理配置相关的定向测试，再运行全量测试、类型检查和 React/Node 构建。
- [ ] 用临时开发目录启动服务，验证 `/admin/health`、React `/admin/`、`/{adapter}/v1/models`、直连 `/v1/models` 和至少一个真实 Adapter 请求。
- [ ] 检查 OpenAI Chat、OpenAI Responses、Anthropic 三种 policy 映射；至少覆盖 `off`、`medium`、未映射等级、模板未知字段、目标模型切换和输出 token 默认值。
- [ ] 执行 `npm pack --dry-run --json`，确认包中只有 Node/Web 交付资产。
- [ ] 检查 `git diff --check`、冲突标记、`.pi/**`、草稿文件和旧 Alpine 文件引用；确认第二批没有重新引入 Mac App 或旧 Admin。
- [ ] 通过 PR 评审后再合入 `origin/main`；保留 PR 1 和 PR 2 的独立回滚边界。

**Verification matrix:**

| 范围 | 命令/观察 | 通过条件 |
| --- | --- | --- |
| 配置 | `node --import tsx --test test/config/*.test.ts` | round-trip、兼容读取、危险字段拒绝和完整图校验通过 |
| 路由转换 | `node --import tsx --test test/adapter/router.test.ts test/proxy/router.test.ts test/proxy/translation.test.ts` | 三协议、policy、off 和无静默降级通过 |
| API | `node --import tsx --test test/api/handlers.test.ts test/api/integration.test.ts test/adapter/handlers.test.ts` | CRUD、能力列表、无泄露和错误原子性通过 |
| React 构建 | `npm run typecheck && npm run build` | 类型和 Vite bundle 通过 |
| 全量回归 | `npm test` | 全部测试退出码为 0 |
| 真实服务 | 开发端口 health/API/Adapter smoke | 不使用正式配置，真实链路至少成功一次 |
| 包内容 | `npm pack --dry-run --json` | 包含 Node/Web，不包含 Mac App/updater |

---

## 5. 长期同步策略

PR 2 合入后，上游同步不再采用“每次把 `upstream/main` 直接合入 `main`”的做法，而是：

1. 定期 `git fetch upstream`，先查看双方提交和文件影响范围；
2. 上游小范围后端修复可以在独立同步分支中合并，并通过现有测试；
3. 上游再次变更 Admin 架构时，继续以新的上游 Admin 为基线，选择性迁移本仓库功能；
4. 尽量把本仓库定制集中在明确的配置模型、React 页面和测试文件中，减少对上游核心页面的交叉修改；
5. 每次同步都保留 PR，避免无审查地直接推动 `main`；
6. 发现上游行为与本计划的 settled decisions 冲突时，先记录冲突和影响，再决定是否更新计划，不在实现中静默改变产品边界。

---

## 6. 回滚策略

- PR 1 合入前：删除迁移分支即可，当前 `origin/main` 和备份分支不受影响。
- PR 1 合入后、PR 2 开始前：通过回滚 PR 1 或恢复 `backup/main-alpine-2026-07-26` 进行对比和恢复；不强推 `main`。
- PR 2 失败：优先回滚 PR 2，保留已经验证的 React Web-only 基线；不要为了恢复推理 UI 把旧 Alpine Admin 重新合入。
- 配置迁移失败：保留原配置文件，ConfigStore 不更新内存和版本；管理员依据字段路径错误手工迁移。
- 发现用户草稿被意外触碰：立即停止实施，使用 Git 状态和文件 diff 恢复证据；禁止用 `git clean` 或 reset 掩盖问题。

---

## 7. 计划自检结果

- **范围覆盖：** 已覆盖上游基线、备份、React Admin、Mac App 清理、开发隔离、后端推理模型、React 推理页面、测试、文档、PR、持续同步和回滚。
- **关键边界：** 已明确第一批不迁移旧 Alpine 推理 UI，第二批不混入 Mac App 清理，也不修改 Pi 和用户草稿。
- **路径可执行：** 实施单元均给出仓库相对路径；上游当前确实存在的 React 页面、API、配置、路由和测试路径已纳入。
- **已知执行风险：** 当前冲突 worktree 不能复用；上游 CLI 与 Fork 开发脚本的参数契约需要在 U3 实施时以源码和 smoke 结果确认；外部 Homebrew tap、GitHub Release 和真实供应商请求不属于本地测试可以伪称完成的范围。
- **未解决产品问题：** 没有阻塞第一批的产品选择；推理通用 `set` 的具体供应商字段仍必须遵守模板受保护键和协议转换边界，不能在实施时扩大为任意请求体覆盖。
