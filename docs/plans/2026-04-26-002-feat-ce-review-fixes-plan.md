---
date: 2026-04-26
status: active
type: fix
origin: ce-review on feat/admin-ui-ux
---

# Feat: 修复 ce-review 发现的代码问题

## Overview

基于 ce-review 报告，处理 3 个残留问题：

1. **UI 测试按钮不可用** — handleTestModel 配合 `***` api_key 脱敏方案
2. **writeConfig 并发丢失更新** — SimpleMutex 保护写路径
3. **handlers.ts 拆分** — 480 行，14 handler，先补测试再按域拆

SSRF 问题暂不处理（需要需求讨论）。

## 依赖关系

```
问题 1（handler 改 key 查找） ── 独立
问题 2（writeConfig 加锁） ── 独立
问题 3（拆分）── 依赖问题 2（因为拆分时会动 handler 文件）
              └── 需要新建测试文件
```

## Implementation Units

### Unit 1: 修复 UI 测试按钮 — handleTestModel 服务端查 key

**Goal:** handleTestModel 识别 `***` 脱敏值，从 config 中按 providerName 查找真实 api key

**Files:**
- Modify: `src/api/handlers.ts`

**Changes:**
```typescript
// 替换 apiKey 解析逻辑
const _apiKey = body.api_key ?? body.apiKey
const rawApiKey = typeof _apiKey === 'string' ? _apiKey : undefined
let apiKey = rawApiKey
if (apiKey === '***' || !apiKey) {
  // 尝试从 config 查找真实 key
  const providerName = body.providerName as string | undefined
  if (providerName) {
    const { config } = ctx.store.getConfig()
    const provider = config.providers.find(p => p.name === providerName)
    if (provider?.apiKey) apiKey = provider.apiKey
  }
}
```

**Test scenarios:**
- api_key=`***` + providerName 存在 → 使用 config 中真实 key
- api_key=真实值 → 直接使用（不受影响）
- api_key=`***` + providerName 不存在 → 保持 `***`，上游 401
- 新建 provider（无 providerName）→ 保持原值

**Verification:**
- 编辑模式下点击测试按钮 → 使用已保存 key 成功测试

---

### Unit 2: writeConfig SimpleMutex 保护

**Goal:** ConfigStore.writeConfig 通过 SimpleMutex.run 加锁，防止并发 CRUD 丢失更新

**Files:**
- Modify: `src/config/store.ts` — writeConfig 改为 async + mutex 保护
- Modify: `src/api/handlers.ts` — 6 处 `ctx.store.writeConfig(...)` 加 `await`
- Verify: `src/adapter/handlers.ts` — 不涉及（adapter handler 不写 config）

**Changes:**

`store.ts`：
```typescript
async writeConfig(config: Config): Promise<void> {
  await this.mutex.run(async () => {
    this.current = config
    const yaml = serializeConfigToYaml(config)
    writeFileSync(this.configPath, yaml, 'utf-8')
  })
}
```

`handlers.ts` —— 6 个调用处加 `await`：
- handleCreateProvider: `await ctx.store.writeConfig(newConfig)`
- handleUpdateProvider: `await ctx.store.writeConfig(newConfig)`
- handleDeleteProvider: `await ctx.store.writeConfig(newConfig)`
- handleCreateAdapter: `await ctx.store.writeConfig(newConfig)`
- handleUpdateAdapter: `await ctx.store.writeConfig(newConfig)`
- handleDeleteAdapter: `await ctx.store.writeConfig(newConfig)`

**Test scenarios:**
- 单线程 CRUD 正常写入（回归测试）
- 并发 CRUD → 按序执行，不丢修改（集成测试需 mock 时序）

**风险：** SimpleMutex.run 当前是异步锁队列。writeConfig 改为 async 后，所有调用者必须 await。如果某处没 await，异常不会传播。

**Verification:**
- 83 回归测试全通过
- 手动验证：create → update → delete 序列正常

---

### Unit 3: handlers.ts 拆分

**Goal:** 将 480 行 14 handler 按域拆为 5 个文件

**Files:**
- Create: `src/api/handlers/base.ts` — handleGetConfig, handleReload, handleHealth, handleStatus, handleGetLogs
- Create: `src/api/handlers/provider-crud.ts` — handleCreateProvider, handleUpdateProvider, handleDeleteProvider
  - 含相关辅助函数: configFromProvider, PROVIDER_PATH_RE
- Create: `src/api/handlers/adapter-crud.ts` — handleGetAdapters, handleCreateAdapter, handleUpdateAdapter, handleDeleteAdapter
  - 含 ADAPTER_PATH_RE
- Create: `src/api/handlers/model-handlers.ts` — handleTestModel, handleListModels, handlePullModels
  - 含 sanitizeError, API_KEY_PATTERN, PULL_MODELS_PATH_RE
- Create: `src/api/handlers/index.ts` — re-export 全部
- Modify: `src/api/server.ts` — import 路径 `./handlers.js` → `./handlers/index.js`
- Delete: `src/api/handlers.ts`（拆分后移除）

**依赖：** 要求 Unit 2 已完成（因为同时动 handlers.ts）

**当前 handlers.ts 导出的函数和常量（需确认每个在哪里定义和使用）：**

handlers.ts 导出:
- handleGetConfig → base.ts
- handleReload → base.ts
- handleHealth → base.ts
- handleStatus → base.ts
- handleGetLogs → base.ts
- handleGetAdapters → adapter-crud.ts
- handleCreateProvider → provider-crud.ts
- handleUpdateProvider → provider-crud.ts
- handleDeleteProvider → provider-crud.ts
- handleCreateAdapter → adapter-crud.ts
- handleUpdateAdapter → adapter-crud.ts
- handleDeleteAdapter → adapter-crud.ts
- handleTestModel → model-handlers.ts
- handleListModels → model-handlers.ts
- handlePullModels → model-handlers.ts

仅 handlers.ts 内部使用的（不导出）：
- HandlerContext → 各文件各自定义（或共用）
- json() → 各文件共用的工具函数，放 index.ts 或单独 utils.ts
- configFromProvider → provider-crud.ts
- PROVIDER_PATH_RE → provider-crud.ts
- ADAPTER_PATH_RE → adapter-crud.ts
- API_KEY_PATTERN → model-handlers.ts
- sanitizeError → model-handlers.ts
- DEFAULT_API_BASES → 已删除（Unit 2 之后）
- PULL_MODELS_PATH_RE → model-handlers.ts

**测试调整：**
- test/api/handlers.test.ts 的 import 路径 `../src/api/handlers.js` → `../src/api/handlers/index.js`
- 先拆分不改变行为，现有 4 个 handler 测试应继续通过

**Verification:**
- `npx tsc --noEmit` 0 错误
- 83 tests pass
- 14 handler 函数均可从 `./handlers/index.js` 导入

---

## 落地顺序

```
Unit 1（key 查找）→ 独立，5 行改动
  ↓
Unit 2（writeConfig 锁）→ 独立，1 个文件 + 6 个 await
  ↓
Unit 3（handler 拆分）→ 依赖 Unit 2，新建 5 文件 + 改 server.ts
```

## Test scenarios by unit

| Unit | 回归 | 新增 | 验证方式 |
|------|------|------|---------|
| 1 | test-model 原有行为不改变 | api_key=`***` → providerName 匹配时用真实 key | npm test + 手动 UI 测试 |
| 2 | 所有 CRUD 正常执行 | 并发 CRUD 按序执行 | npm test |
| 3 | 所有 14 handler 可导入、可调用 | 新文件结构正确 | npx tsc + npm test |

## Risks & Dependencies

| 风险 | 缓解 |
|------|------|
| SimpleMutex.run 不支持同步闭包，writeConfig 改 async | 所有调用处已确认在 async handler 中，加 await 兼容 |
| 拆分 handlers.ts 时可能漏导出或漏导入 | index.ts 显式 re-export，编译验证 |
| 拆分后 server.ts import 路径错 | 唯一 import 处，改一次即可 |
| HandlerContext 接口重复定义 | 从 server.ts import ServerContext 复用，或各文件独立定义 |

## Open Questions

- HandlerContext 与 ServerContext 结构相同（store, tracker, logger），拆分时是否统一为一个？
  - 建议：拆分时统一为 `import type { ServerContext } from '../server.js'`，在各 handler 文件中直接使用 ServerContext 代替 HandlerContext
