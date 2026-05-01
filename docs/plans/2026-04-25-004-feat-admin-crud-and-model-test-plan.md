---
title: feat: Admin UI CRUD 与模型测试
type: feat
status: active
date: 2026-04-25
origin: docs/brainstorms/2026-04-25-admin-crud-and-model-test-requirements.md
---

# Admin UI CRUD 与模型测试

## Overview

在管理后台新增 Provider/Adapter 的 CRUD API 和 Web UI 表单，支持通过界面增删改配置并自动写回 config.yaml + 热重载。新增模型直连测试功能，快速验证 API Key 和模型连通性。

## Problem Frame

当前配置管理需要手动编辑 YAML 文件后触发热重载，操作门槛高。管理后台仅有只读展示。配置后缺乏快速验证模型连通性的能力。通过 CRUD API + UI 表单，用户无需手动编辑 YAML 即可管理配置；通过模型测试功能可即时确认上游可用。（见 origin）

## Requirements Trace

- R1-R8: Admin API CRUD（POST/PUT/DELETE providers 和 adapters，自动写回 + 重载）
- R9-R12: 模型直连测试（POST /admin/test-model，15s 超时，返回连通性+延迟）
- R13-R17: Web UI 配置编辑（增删改表单，删除确认，自动刷新）
- R18-R19: Web UI 模型测试（测试按钮，行内/浮动显示结果）

## Scope Boundaries

- API Key 明文写入 YAML（与现有保持一致）
- Admin API 无认证（与现有保持一致）
- 模型测试仅做连通性验证
- 不修改已有的 YAML 编辑器（两种方式并存）

## Context & Research

### Relevant Code and Patterns

- **ConfigStore**: `src/config/store.ts` — `getConfig()`, `reload()`, SimpleMutex。需要新增 `writeConfig()`
- **Admin handlers**: `src/api/handlers.ts` — 统一 `{ success, data }` 响应格式
- **Server routing**: `src/api/server.ts` — ROUTES 数组，正则匹配
- **YAML parsing**: `src/config/parser.ts` — 使用 `yaml` 包，`loadConfigFromYaml` + `parse`
- **Types**: `src/config/types.ts` — `Config`（camelCase）和 `ConfigFile`（snake_case）对偶结构
- **Web UI patterns**: `src/api/admin-ui.html` — Provider/Adapter 列表的 API 调用和表格渲染
- **Model test pattern**: `src/proxy/provider.ts` — `forwardRequest` 的 fetch 调用模式

## Key Technical Decisions

- **ConfigStore.writeConfig**: 新增 writeConfig 方法。从内存 Config 转换为 ConfigFile 结构（camelCase → snake_case），用 yaml.stringify 序列化，写回 configPath，然后调用 reload()
- **CRUD 自动写回**: PUT/DELETE/POST 操作均先修改内存中的 Config（通过 store.getConfig() 读取→修改→写回→重载），与 reload() 共享 SimpleMutex
- **删除引用检查**: DELETE provider 前检查是否有 adapter 的 mapping 引用了该 provider，引用存在时返回 400 + 错误信息
- **CORS 更新**: 将 `Access-Control-Allow-Methods` 扩展为 `GET, POST, PUT, DELETE, OPTIONS`
- **直连测试以 provider 为单位**: POST /admin/test-model 基于 Provider 配置（type + apiKey + apiBase + model），直接向 API Key 和上游接口发送最小化聊天请求验证连通性
- **序列化时 snake_case**: yaml.stringify() 之前将 Config 转换为 ConfigFile 格式（apiKey→api_key），确保下次 reload() 时字段匹配

## Implementation Units

### Unit 1: ConfigStore.writeConfig

**Goal:** 新增 Config 写回文件的能力，支持将内存 Config 序列化为 YAML 写到 configPath

**Requirements:** R7

**Dependencies:** None

**Files:**
- Modify: `src/config/store.ts`
- Test: `test/config/store.test.ts`

**Approach:**
- 新增 `writeConfig(config: Config): void` 方法
- 方法内部：
  1. 将 Config 转为 ConfigFile 结构（providers 中的 apiKey→api_key、apiBase→api_base；adapters 中的 format→format 不变）
  2. 用 `yaml.stringify()` 序列化
  3. 写入 `this.configPath`
  4. 更新 `this.current = config`
  5. 递增 `this.version`
- 使用 SimpleMutex 保证写操作的原子性

**Patterns to follow:**
- `src/config/parser.ts` 中 `loadConfigFromYaml` 的 Config→ConfigFile 反向映射模式
- `store.ts` 中的 SimpleMutex 使用模式

**Test scenarios:**
- Happy path: 写入合法 Config 后文件内容正确（api_key 而非 apiKey）
- Edge case: 写入包含 adapters 的 Config，确认 adapters 段正确序列化
- Integration: writeConfig 后立即 reload，确认读取结果与写入内容一致

**Verification:**
- writeConfig 后文件内容符合 YAML 规范，env var 占位符被解析为字面量
- 再次 reload 成功，不报校验错误

---

### Unit 2: CRUD API handlers

**Goal:** 实现 Provider 和 Adapter 的 POST/PUT/DELETE 管理端点

**Requirements:** R1-R8

**Dependencies:** Unit 1

**Files:**
- Modify: `src/api/handlers.ts`
- Modify: `src/api/server.ts`
- Test: `test/api/handlers.test.ts`

**Approach:**
- 新增 handler 函数：
  - `handleCreateProvider`: 从 body 读取 name/type/apiKey/apiBase/models，校验后添加到 config.providers，writeConfig
  - `handleUpdateProvider`: 按 URL 中的 name 查找 provider，合并更新字段，writeConfig
  - `handleDeleteProvider`: 按 name 删除，先检查是否被任何 adapter 引用，writeConfig
  - `handleCreateAdapter`, `handleUpdateAdapter`, `handleDeleteAdapter`: 同理
- 所有 CRUD handler 遵循统一模式：
  1. 从 ctx.store.getConfig() 获取当前 config（浅拷贝 providers/adapters 数组）
  2. 校验请求数据（复用 validator.ts 的 validateConfig，或单独校验）
  3. 修改 config
  4. ctx.store.writeConfig(modifiedConfig)
- 删除 provider 时的引用检查：遍历 config.adapters，检查任一 mapping 的 provider 是否指向被删除的 provider
- 校验失败时返回 400 + 错误列表

**Patterns to follow:**
- `handlers.ts` 中 `handleReload` 的 json() 响应模式
- `validator.ts` 中的错误收集模式

**Test scenarios:**
- Happy path: 创建 provider → 确认 config.yaml 包含新 provider
- Happy path: 更新 provider 的 apiKey → 确认写回文件中的 api_key 已更新
- Happy path: 删除 provider → 确认从 config 中移除
- Edge case: 删除被 adapter 引用的 provider → 返回 400 + 引用警告
- Error: 创建重复 name 的 provider → 返回 400
- Error: 更新不存在的 provider → 返回 404
- Integration: CRUD 操作后 config 仍可通过 reload 正确加载

**Verification:**
- 所有 CRUD 端点通过 HTTP 测试
- 写回文件格式正确

---

### Unit 3: Model test API

**Goal:** 实现 POST /admin/test-model 端点，直连上游 API 验证模型连通性

**Requirements:** R9-R12

**Dependencies:** None

**Files:**
- Modify: `src/api/handlers.ts`
- Modify: `src/api/server.ts`
- Test: `test/api/handlers.test.ts`

**Approach:**
- 新增 `handleTestModel` handler
- 请求体：`{ provider: { type, apiKey, apiBase?, model }, providerName? }`
- 逻辑：
  1. 构造最小请求——OpenAI 格式：`{ model, messages: [{role:'user', content:'hi'}] }`；Anthropic 格式：`{ model, messages: [{role:'user', content:'hi'}], max_tokens: 10 }`
  2. 设置请求头（Authorization / x-api-key + anthropic-version）
  3. 用原生 fetch 向上游 API 发送请求，timeout 15 秒（AbortSignal.timeout）
  4. 检查响应状态
  5. 响应格式：`{ success: true, data: { reachable: true/false, latency: number, model: string, error?: string } }`
- 失败处理：网络错误、超时、HTTP 错误都要返回 reachable=false + 错误消息

**Patterns to follow:**
- `src/proxy/provider.ts` 中 `forwardRequest` 的 fetch 调用模式
- `handlers.ts` 的统一 json() 响应

**Test scenarios:**
- Happy path: 模拟上游返回 200 → 响应 reachable=true
- Error: 上游返回 401/403 → 响应 reachable=false + 错误消息
- Error: 网络超时 → 响应 reachable=false
- Error: 请求体缺少必要字段 → 400

**Verification:**
- 通过 mock upstream 测试所有场景
- 响应格式正确

---

### Unit 4: Web UI — CRUD 表单和操作按钮

**Goal:** 在 Provider 和 Adapter 列表页增加增删改功能

**Requirements:** R13-R17

**Dependencies:** Unit 2

**Files:**
- Modify: `src/api/admin-ui.html`

**Approach:**
- Provider 列表每行增加「编辑」和「删除」按钮
- 编辑：点击后弹出模态框或行内表单，预填当前数据（name, type, apiKey, apiBase, models）。提交后 PUT /admin/providers/:name
- 删除：弹出确认对话框，确认后 DELETE /admin/providers/:name
- 新增：列表上方「+ 添加 Provider」按钮 → 弹出空表单 → POST /admin/providers
- Adapter 同样处理
- 操作成功后自动调用 loadProviders() / loadAdapters() 刷新列表
- 删除被引用 provider 时显示后端返回的错误消息

**Patterns to follow:**
- 现有的 `loadProviders()` / `loadAdapters()` API 调用模式
- 现有的表格渲染模式

**Test scenarios:**
- 点击添加 → 填写表单 → 提交 → 列表中显示新条目
- 点击编辑 → 修改字段 → 提交 → 列表更新
- 点击删除 → 确认 → 列表移除
- 删除被引用的 provider → 显示错误提示

**Verification:**
- 手动测试所有 CRUD 操作流程
- 操作后列表自动刷新

---

### Unit 5: Web UI — 模型测试按钮

**Goal:** 在 Provider 列表每行增加测试按钮，展示连通性结果

**Requirements:** R18-R19

**Dependencies:** Unit 3

**Files:**
- Modify: `src/api/admin-ui.html`

**Approach:**
- Provider 列表每行增加「测试」按钮
- 点击后调用 POST /admin/test-model，传入该 provider 的 type、apiKey、apiBase、models[0].model
- 请求过程中按钮显示 loading 状态
- 结果显示在行内（状态标记或 toast）：
  - 成功：绿色标记 + 延迟时间
  - 失败：红色标记 + 错误消息
- 测试不修改任何配置，只读操作

**Patterns to follow:**
- 行内渲染状态标记的 badge 模式（badge-ok、badge-err）

**Test scenarios:**
- 点击测试 → 上游可达 → 显示绿色标记 + 延迟
- 点击测试 → 上游不可达 → 显示红色标记 + 错误
- 测试中按钮禁用，防止重复请求

**Verification:**
- 手动测试连接成功和失败的场景
- 按钮状态正确切换

---

### Unit 6: Route registration + CORS update

**Goal:** 注册所有新端点，更新 CORS 头部

**Requirements:** R1-R6, R9

**Dependencies:** Units 2, 3

**Files:**
- Modify: `src/api/server.ts`

**Approach:**
- 在 ROUTES 数组中新增：
  - POST /admin/providers → handleCreateProvider
  - PUT /admin/providers/:name → handleUpdateProvider  
  - DELETE /admin/providers/:name → handleDeleteProvider
  - POST /admin/adapters → handleCreateAdapter
  - PUT /admin/adapters/:name → handleUpdateAdapter
  - DELETE /admin/adapters/:name → handleDeleteAdapter
  - POST /admin/test-model → handleTestModel
- 更新 CORS 头部 `Access-Control-Allow-Methods` 为 `GET, POST, PUT, DELETE, OPTIONS`
- PUT 和 DELETE 路由使用正则捕获 provider/adapter name

**Patterns to follow:**
- 现有的 ROUTES 正则匹配模式
- 通配：`/^\/admin\/providers\/([a-zA-Z0-9_-]+)$/` 捕获 name

**Verification:**
- 所有新端点通过 HTTP 调用可用
- 浏览器端 PUT/DELETE 请求不被 CORS 拦截

---

## System-Wide Impact

- **Interaction graph:** CRUD 操作会直接修改 config.yaml 并触发热重载。热重载后所有新的 HTTP 请求（包括正在进行的流式请求）会立即使用新配置。由于 Node.js 的引用交换（this.current = newConfig），正在执行的请求不受影响
- **Error propagation:** CRUD 操作的校验错误返回 400，删除引用中的 provider 返回 400，写文件失败返回 500。模型测试的网络错误返回 reachable=false 而非 HTTP 错误
- **State lifecycle risks:** writeConfig + reload 的序列化写回存在竞态——如果两个 CRUD 操作几乎同时发生，后一个可能基于前一个修改前的配置。使用 SimpleMutex 序列化 writeConfig 调用可缓解此问题
- **API surface parity:** 新增 7 个端点、更新 1 个端点（CORS）。所有现有端点保持不变

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| writeConfig + reload 导致配置滚动丢失 | writeConfig 内部使用 SimpleMutex 序列化 |
| 环境变量 `${VAR}` 模板在写回后丢失 | 接受——API Key 存明文与 Scope 一致 |
| YAML 注释被 stringify 清除 | 接受——注释在 UI CRUD 场景下不适用 |
| 并发 CRUD 和手动 YAML 编辑冲突 | YAML 编辑器的保存与 CRUD 写到同一文件，建议用户二选一操作 |

## Open Questions

### Resolved During Planning
- **snake_case ↔ camelCase**: 写回前转为 ConfigFile 结构，防止 reload 时字段不匹配
- **CORS 阻止 PUT/DELETE**: 更新 Allow-Methods 头部
- **删除检查**: 只检查 adapter 引用，不检查更复杂的依赖链

### Deferred to Implementation
- 环境变量模板在 UI CRUD 场景下的处理策略（保留原始 env var 引用 vs 写明文）
- Web UI 中 CRUD 表单的交互细节（模态框 vs 行内编辑 vs 侧边面板）

## Sources & References

- **Origin document:** [docs/brainstorms/2026-04-25-admin-crud-and-model-test-requirements.md](../brainstorms/2026-04-25-admin-crud-and-model-test-requirements.md)
- Related code: `src/config/store.ts` (ConfigStore pattern), `src/api/server.ts` (ROUTES pattern), `src/api/handlers.ts` (admin handler pattern), `src/api/admin-ui.html` (UI pattern)
