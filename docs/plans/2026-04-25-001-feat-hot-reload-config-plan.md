---
title: feat: 热加载配置管理模块
type: feat
status: active
date: 2026-04-25
origin: docs/brainstorms/2026-04-25-hot-reload-config-requirements.md
---

# 热加载配置管理模块

## Overview

在 LLM-Proxy 项目中实现核心配置管理模块。用户编辑 YAML 配置文件后调用 `POST /admin/config/reload`，配置以原子方式生效，零中断。管理 API 提供配置查询、健康检查、Provider 状态查询，CLI 支持启动/停止/状态/重载。

## Problem Frame

现有 LLM 代理（LiteLLM、LM-Proxy 等）每次修改配置都需要重启进程，中断进行中的 LLM 调用。本项目需要一套不重启的运行时配置管理方案。

项目状态：从零开始，TypeScript (Node.js)，单一二进制分发的 CLI 工具。

## Requirements Trace

- R1-R5. YAML 配置模型与存储（文件路径、Provider 包裹 Model、别名映射、env 插值、密封枚举类型）
- R6-R7. 管理 API 路径隔离（`/admin/`），默认 127.0.0.1:9000 绑定
- R8. `GET /admin/config` — 返回当前运行时配置（Key 脱敏）
- R9. `POST /admin/config/reload` — 触发配置重载
- R10. `GET /admin/health` — 存活探针
- R11. `GET /admin/status/providers` — 被动 Provider 状态统计
- R12. 统一 JSON 响应格式
- R13-R16. 热加载机制：仅 API 触发、校验后原子替换、旧请求继续使用旧配置、唯一性校验
- R17-R18. CLI：start/stop/status/reload，从默认路径读取配置
- R19-R21. Schema 协议桥集成（占位，推迟实现）

## Scope Boundaries

- 不包括 Web UI
- 不包括配置模板或同步
- 不包括 CRUD 管理端点
- 不包括主动 Provider 健康探测
- 不包括协议桥核心实现

## Context & Research

### Relevant Code and Patterns

- 项目从零开始，无现有代码
- 用户已熟悉 TypeScript 开发（有 kiro-gateway、lark-openapi-mcp 等 TS 项目）
- Dario（同类 TS LLM 代理）采用零依赖架构，约 10K 行代码，使用 Node 内置 http 模块

### External References

- YAML 解析：`yaml`（eemeli 维护，YAML 1.2 合规，内置 TS 类型，活跃维护） — 替代已停滞的 `js-yaml`
- Node 内置 `http` 模块 + `http.createServer` 足够
- CLI：手动 `process.argv` 解析（仅 4 个命令）
- 测试：`node:test`（Node 内置），通过 `tsx` 加载器运行 `.ts` 测试文件
- 构建：`esbuild` 生产构建，`tsc` 仅类型检查
- 并发：Promise 链式 Mutex 或 `async-mutex` 极简库（零依赖实现）

## Key Technical Decisions

- **TypeScript + Node.js**：原生 http 模块，运行时依赖仅 `yaml` 库（eemeli），Dario 已验证类似架构
- **无第三方 HTTP 框架**：管理 API 端点少（4 个），内置 http 模块足够，避免依赖膨胀
- **`yaml`（eemeli）解析 YAML**：YAML 1.2 合规、内置 TS 类型定义、活跃维护，优于已停滞的 `js-yaml`
- **`tsx` 开发 + `tsc` 构建**：开发时直接运行 TS，构建为 JS 产出，资源文件手动复制到 `dist/`
- **`node:test` 内置测试**：Node 20+ 内置测试运行器，零额外依赖，清晰标记测试（参照 Dario 的 `node --test`）
- **ESM + NodeNext 模块解析**：遵循 Dario 和 mcps 项目约定，源文件导入使用 `.js` 扩展名
- **CLI 命令派发采用 Record 映射**：参照 Dario 的 `Record<string, () => Promise<void>>` 模式，不引入 CLI 框架

## Open Questions

### Resolved During Planning

- [语言选择] TypeScript (Node.js)：与用户技术栈一致，接近 Dario 架构
- [HTTP 框架] 不引入 Express/Fastify，使用 Node 内置 `http` 模块
- [测试框架] 使用 Node 内置 `node:test` + `node:assert`

### Deferred to Implementation

- [校验规则] Provider type 的具体字符串范围、Model 名的合法字符集：在实现层次定义更灵活
- [Provider 状态窗口] 滑动窗口时间粒度（默认 5 分钟、1 分钟等）：配置文件或常量中定义
- [PID 文件路径] `/tmp/llm-proxy.pid` vs `~/.llm-proxy/llm-proxy.pid`：实现时可配置

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

### 数据流

```
用户编辑 ~/.llm-proxy/config.yaml
        │
        ▼
POST /admin/config/reload
        │
        ▼
读取 YAML ──→ 环境变量插值 ──→ 校验配置
                                    │
                           ┌────────┴────────┐
                           ▼                 ▼
                        通过              失败
                           │                 │
                   原子替换运行时配置    返回 400 + 错误信息
                           │
                   新请求使用新配置
                   旧请求继续旧配置
```

### 配置数据结构

```
Config {
  providers: Provider[]
}

Provider {
  name: string          // 唯一标识
  type: "anthropic" | "openai"
  apiKey: string        // 运行时可用，序列化时脱敏
  apiBase?: string      // 可选，默认值基于 type
  models: Model[]
}

Model {
  name: string          // 本地别名（工具请求时使用）
  model: string         // 上游模型名
}
```

### 运行时配置替换

```
请求 A ──→ 读旧配置 ──→ 处理中
请求 B ──→ 读旧配置 ──→ 处理中
                │
        ┌───────┴───────┐
        ▼               ▼
    reload()     请求 C (新)
        │               │
   原子替换         读新配置
        │               │
   旧配置引用计数归零  C 用新配置
```

使用引用计数或分代机制：reload 时创建新配置对象，原子替换全局引用指针。进行中的请求持有旧对象的引用，完成自然释放。Go 的指针原子交换在 JS 中可通过将 config 封装为不可变对象 + 版本号实现。

## Implementation Units

- [ ] **Unit 1: 项目脚手架搭建**

**Goal:** 初始化 TypeScript 项目结构、构建配置、测试框架

**Requirements:** (基础设施)

**Dependencies:** None

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/index.ts` (入口)
- Create: `src/config/types.ts`
- Create: `src/config/parser.ts`
- Create: `src/config/validator.ts`
- Create: `src/config/store.ts`
- Create: `src/api/server.ts`
- Create: `src/api/handlers.ts`
- Create: `src/cli/commands.ts`
- Create: `src/status/tracker.ts`
- Create: `test/config/parser.test.ts`
- Create: `test/config/validator.test.ts`
- Create: `test/config/store.test.ts`
- Create: `test/api/handlers.test.ts`
- Create: `test/cli/commands.test.ts`
- Create: `samples/config.yaml`

**Approach:**
- 使用 `npm init` 或手动创建 `package.json`
- 依赖：`yaml`（eemeli，YAML 解析）、`typescript`、`@types/node`、`tsx`（开发）
- 测试：`node:test`（Node 20+ 内置），通过 `--experimental-loader tsx` 或 `--import tsx` 运行 `.ts` 测试
- 构建：`esbuild` 打包生产构建，`tsc --noEmit` 仅类型检查
- `tsconfig.json` 设置 `strict: true`、`target: "ES2022"`、`module: "NodeNext"`

**Patterns to follow:**
- Dario 的扁平目录 + 零依赖原则
- Dario 的 `tsconfig.json` 配置：`"type": "module"`（ESM）、`target: ES2022`、`module: NodeNext`、`moduleResolution: NodeNext`、`strict: true`
- Dario 的构建模式：`tsc` 编译后手动复制非 TS 资源文件到 `dist/`
- 源文件中使用 `.js` 扩展名导入（`import { ... } from './module.js'`）

**Test scenarios:**
- [Smoke] 项目能通过 `tsc --noEmit` 类型检查
- [Happy path] 测试运行器能发现并执行所有测试文件（`node --import tsx --test test/**/*.test.ts`）

**Verification:**
- `npm run build` 成功
- `npm test` 输出测试结果
- `npx tsx src/index.ts --help` 显示帮助信息

---

- [ ] **Unit 2: 配置类型定义与 YAML 解析**

**Goal:** 定义 Config、Provider、Model 等 TypeScript 类型，实现 YAML 文件读取和环境变量插值

**Requirements:** R1, R2, R3, R4, R5

**Dependencies:** Unit 1

**Files:**
- Create: `src/config/types.ts` — 类型定义
- Create: `src/config/parser.ts` — YAML 解析与 env 插值
- Create: `test/config/parser.test.ts` — 解析测试
- Create: `samples/config.yaml` — 示例配置

**Approach:**
- 类型定义使用原生 TS 类型 + `validator.ts` 运行时检查（不引入 zod 以保持最小依赖）
- YAML 解析使用 `yaml`（eemeli）
- 环境变量插值：正则匹配 `${VAR_NAME}` 模式，替换为 `process.env[VAR_NAME]`
- 未定义变量直接抛错
- 示例配置提供 anthropic 和 openai 两个 Provider 的完整示例

**Patterns to follow:**
- Dario 的后端配置使用 JSON 文件 (`~/.dario/backends/<name>.json`)
- 本项目使用 YAML，类似 LiteLLM 的配置风格

**Test scenarios:**
- [Happy path] 有效 YAML 配置正确解析为 Config 对象
- [Happy path] `${ANTHROPIC_API_KEY}` 被环境变量替换
- [Edge case] 未定义环境变量的插值抛错
- [Edge case] 空 YAML 文件 / 缺失必要字段
- [Edge case] YAML 语法错误（缩进、未闭合引号等）
- [Integration] 从文件读取 → 解析 → 生成结构正确的 Config 对象

**Verification:**
- 示例 config.yaml 可正确解析
- 环境变量插值生效
- 所有错误场景抛出明确错误消息

---

- [ ] **Unit 3: 配置校验器**

**Goal:** 实现完整的配置校验逻辑，确保配置在加载时正确

**Requirements:** R16

**Dependencies:** Unit 2

**Files:**
- Modify: `src/config/validator.ts`
- Create: `test/config/validator.test.ts`

**Approach:**
- 校验规则：
  - Provider name 在顶级唯一
  - Model name 在 Provider 内唯一
  - API Key 非空字符串
  - Provider type 为 `"anthropic"` 或 `"openai"`
  - Model 必须有 `name` 和 `model` 字段
- 返回校验错误列表（不抛出一个错误就停，而是收集所有错误）
- 校验通过返回空列表，校验失败返回人类可读的错误消息数组
- Provider name 合法字符：字母、数字、下划线、连字符
- Model name 合法字符：字母、数字、下划线、连字符、点、斜杠、冒号

**Test scenarios:**
- [Happy path] 有效配置通过校验
- [Error path] 重复 Provider name → 错误
- [Error path] 重复 Model name → 错误
- [Error path] 空 API Key → 错误
- [Error path] 无效 Provider type → 错误
- [Error path] 同时多个错误 → 返回所有错误
- [Edge case] Provider name 含非法字符 → 错误
- [Edge case] 特殊字符在 model name 中（OpenAI 微调模型如 `ft:gpt-4o:org:custom-id`）→ 通过

**Verification:**
- 校验函数对所有规则返回正确的 pass/fail
- 错误消息清晰指出具体问题和位置

---

- [ ] **Unit 4: 运行时配置存储与热加载**

**Goal:** 实现运行时配置的线程安全存储、原子替换、优雅配置切换

**Requirements:** R13, R14, R15

**Dependencies:** Unit 2, Unit 3

**Files:**
- Create: `src/config/store.ts`
- Create: `test/config/store.test.ts`

**Approach:**
- `ConfigStore` 单例封装运行时配置，启动时传入初始配置文件路径并记忆
- 内部使用不可变对象 + 原子引用替换（JS 赋值天然原子）
- 提供一个 `getConfig()` 方法获取当前配置快照
- 提供一个 `reload()` **同步**方法（无参数，使用记忆的路径）：读取文件 → 解析 → 校验 → 原子替换
- 使用 Promise 链式 Mutex 确保 reload 与其他调用不冲突（极简实现，零依赖）

```typescript
// 极简 Promise 链式 Mutex（零依赖）
class SimpleMutex {
  private last = Promise.resolve();
  run<T>(fn: () => T): Promise<T> {
    const next = this.last.then(fn, fn);
    this.last = next.catch(() => {});
    return next;
  }
}

class ConfigStore {
  private current: Config
  private version = 0
  private configPath: string
  private mutex = new SimpleMutex()

  constructor(configPath: string) { this.configPath = configPath; }

  getConfig(): { config: Config, version: number }

  reload(): ReloadResult  // 同步解析 + 校验 + 原子替换
}
```

**Test scenarios:**
- [Happy path] 初始加载有效配置成功
- [Happy path] reload 新配置 → getConfig 返回新配置
- [Happy path] reload 成功后版本号递增
- [Error path] reload 无效配置 → 配置不变，版本号不变
- [Error path] 配置文件不存在 → 抛出文件不可读错误
- [Edge case] 并发 getConfig 调用始终返回一致的配置（JS 单线程天然保证）
- [Integration] 解析 → 校验 → 存储 → 读取的全流程

**Verification:**
- 多次 reload 后 getConfig 始终返回最新的有效配置
- 无效配置不会影响当前运行

---

- [ ] **Unit 5: 管理 HTTP API**

**Goal:** 实现 HTTP 服务器和 4 个管理端点

**Requirements:** R6, R7, R8, R9, R10, R12

**Dependencies:** Unit 4

**Files:**
- Create: `src/api/server.ts` — HTTP 服务器
- Create: `src/api/handlers.ts` — 请求处理函数
- Create: `test/api/handlers.test.ts` — 处理函数测试

**Approach:**
- 使用 Node 内置 `http.createServer`
- 路由手动实现（精简 URL 匹配，无需框架）
- 统一响应格式 `{ success, data, error }`
- CORS：本地开发需要支持 `localhost` 来源
- `/admin/config` — GET，返回当前配置，API Key 替换为 `"***"`
- `/admin/config/reload` — POST，调用 Store.reload()，成功返回 200 + 新版本号，失败返回 400 + 错误列表
- `/admin/health` — GET，固定返回 `{ success: true, data: { status: "ok" } }`
- `/admin/status/providers` — GET，返回 Provider 状态（先返回基础结构，状态数据由 Unit 6 填充）
- 所有非 `/admin/` 路径的请求返回 404
- `adminHost` 和 `adminPort` 可通过 CLI 参数配置（Unit 7 传入）

```
Route 映射:
  GET  /admin/config          → handleGetConfig
  POST /admin/config/reload   → handleReload
  GET  /admin/health          → handleHealth
  GET  /admin/status/providers → handleStatus
  *    (任何非 admin 路径)     → 404
```

**Test scenarios:**
- [Happy path] GET /admin/config 返回配置 JSON（Key 脱敏）
- [Happy path] POST /admin/config/reload 成功时返回 200 + 版本号
- [Error path] POST /admin/config/reload 失败时返回 400 + 错误列表
- [Happy path] GET /admin/health 返回 200
- [Edge case] 请求体不是有效 JSON → 400
- [Edge case] GET 请求发送到 POST 端点 → 405
- [Happy path] 未知路径返回 404
- [Integration] 调用 reload → getConfig 确认配置已更新

**Verification:**
- 4 个端点按预期响应
- 所有响应符合统一的 JSON 格式
- 服务器在 localhost 上启动和关闭正常

---

- [ ] **Unit 6: Provider 被动状态统计**

**Goal:** 基于请求统计被动追踪 Provider 的延迟和可用性

**Requirements:** R11

**Dependencies:** Unit 5

**Files:**
- Create: `src/status/tracker.ts` — 状态追踪器
- Test: (集成在 handler 测试中)

**Approach:**
- `StatusTracker` 类维护每个 Provider 的滑动窗口统计
- 记录每次请求的：耗时、是否成功、错误类型
- 滑动窗口默认 5 分钟（可配置）
- 状态包括：
  - `avgLatency`: 平均延迟 (ms)
  - `errorRate`: 最近窗口的错误率 (%)
  - `totalRequests`: 窗口内总请求数
  - `available`: 基于错误率阈值（默认 < 50%）判断是否可用
- 数据收集由协议桥层调用（当前阶段返回空/默认值，等协议桥实现后接入）
- GET /admin/status/providers 响应包含所有 Provider 的当前状态

**Test scenarios:**
- [Happy path] 记录请求后查询返回正确的统计数据
- [Happy path] 可用性阈值判断正确
- [Edge case] 无请求数据时返回默认状态（0 延迟、0 错误率、可用）
- [Edge case] 滑动窗口过期后数据正确清除
- [Edge case] 大量请求不影响性能

**Verification:**
- 统计数据准确反映窗口内的请求情况
- 端点返回结构正确的响应

---

- [ ] **Unit 7: CLI 命令实现**

**Goal:** 实现 CLI 入口：start/stop/status/reload

**Requirements:** R17, R18

**Dependencies:** Unit 5, Unit 4

**Files:**
- Create: `src/cli/commands.ts` — CLI 命令实现
- Create: `test/cli/commands.test.ts`
- Modify: `src/index.ts` — CLI 入口

**Approach:**
- 使用 `process.argv[2]` 作为命令映射的键，`Record<string, () => Promise<void>>` 模式分发（参照 Dario 的 CLI 架构）
- `llm-proxy start --port 9000` — 启动 HTTP 服务器 + 初始加载配置，写入 PID 文件。默认端口 9000
- `llm-proxy stop` — 读取 PID 文件，发送 SIGTERM，等待进行中请求（最多 10s）优雅关闭，清理 PID 文件
- HTTP 服务器注册 `process.on('SIGTERM')` 处理程序，调用 `server.close()` 并设置关闭超时
- `llm-proxy status` — 检查代理是否运行，连接健康检查端点
- `llm-proxy reload` — 发送 POST /admin/config/reload
- 支持 `--config <path>` 参数覆盖默认配置路径
- 支持 `--admin-host` 和 `--admin-port` 参数覆盖管理 API 绑定地址
- 默认 PID 文件路径：`/tmp/llm-proxy.pid`
- `llm-proxy --help` 打印命令列表（内置帮助，无第三方库依赖）

**Test scenarios:**
- [Happy path] `start` 后可通过 `status` 确认运行
- [Happy path] `reload` 触发配置重载
- [Happy path] `stop` 正常停止进程
- [Error path] 进程未运行时 `stop` 输出提示
- [Edge case] `--config` 指定不存在的文件报错
- [Edge case] 重复 `start` 检测到已有进程并提示
- [Edge case] PID 文件损坏的处理

**Verification:**
- CLI 四个命令按预期工作
- start/reload/stop 生命周期完整

---

- [ ] **Unit 8: 集成与示例**

**Goal:** 提供示例配置、命令行帮助、README 说明

**Requirements:** (文档)

**Dependencies:** All units

**Files:**
- Modify: `samples/config.yaml` — 完整示例
- Create: `README.md` — 项目说明

**Approach:**
- 示例配置包含 anthropic 和 openai 两个 Provider 的完整样例
- 示例配置添加详细的注释说明每个字段的用途
- README 包含：安装、配置、CLI 使用、API 文档

**Verification:**
- 示例配置可通过验收测试
- README 描述的工作流可复现

## System-Wide Impact

- **Process lifecycle:** CLI start 启动 HTTP 服务器，stop 发送 SIGTERM 优雅关闭
- **Config file write safety:** 重载时读取文件，解析后校验再替换。如有外部编辑器未完成写入的风险，建议用户使用原子写入（write to temp → rename）
- **Error propagation:** reload 失败返回 HTTP 400 + 错误列表，不影响运行中配置
- **Key security:** API Key 在内存中明文保存，`GET /admin/config` 响应中脱敏显示。配置文件权限建议 `600`
- **PID file:** 多实例冲突检测通过 PID 文件实现

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| YAML 文件在读取时被部分写入 | 文档建议用户使用原子写入，reload 过程有校验保护 |
| 管理 API 绑定到 0.0.0.0 时无认证 | 文档警告风险，建议反向代理加认证 |
| 协议桥集成（R19-R21）推迟导致接口变动 | 当前设计保持 config store 作为单点接口，协议桥接入时只需读取 config store |
| 重载过程中大量并发请求 | JavaScript 单线程模型天然避免竞态，reload 同步执行不阻塞事件循环 |

## Documentation / Operational Notes

- 配置文件权限建议设为 `600`（仅当前用户可读）
- 管理 API 绑定 `0.0.0.0` 时必须配置反向代理认证
- 建议 CI/CD 中通过 `curl -X POST http://localhost:<port>/admin/config/reload` 触发配置更新

## Sources & References

- **Origin document:** [docs/brainstorms/2026-04-25-hot-reload-config-requirements.md](../brainstorms/2026-04-25-hot-reload-config-requirements.md)
- **Related code:** [github.com/askalf/dario](https://github.com/askalf/dario) — 参考零依赖 TS 代理架构
- **Related code:** `kiro-gateway` — 用户已知的 TS 项目
