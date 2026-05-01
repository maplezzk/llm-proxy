---
date: 2026-04-26
status: active
type: feat
---

# Feat: 项目命名和概念全面梳理

## 问题

项目命名系统多处概念混淆、同义命名不统一、中英文混用。核心问题：

| 问题 | 影响范围 |
|------|----------|
| `AdapterConfig.format` ↔ `Provider.type` 同义不同名 | config, api, admin-ui |
| `Model {name, model}` 别名冗余，始终相等 | config, proxy, api, admin-ui |
| `AdapterModelMapping.name` 叫 name 实为适配前模型 ID | config, validator, api, admin-ui |
| `AdapterModelMapping.model` 引用 Model.name 却叫 model | config, validator, proxy, api, admin-ui |
| `RouterResult.upstreamModel` 概念名冗余 | proxy, translation, adapter |
| `inboundFormat` 与 type 概念不一致 | proxy, translation, adapter, provider |

## 依赖关系

```
config/types.ts + config/parser.ts + config/validator.ts (类型定义层)
  └─ proxy/types.ts + proxy/router.ts + proxy/translation.ts + proxy/provider.ts + proxy/handlers.ts (代理层)
    └─ adapter/router.ts + adapter/handlers.ts (适配器层)
      └─ api/handlers.ts (API 层)
        └─ api/admin-ui.html (UI 层)
          └─ test/**/*.test.ts (测试层)
```

## 实施单元

### 单元 1：类型定义层 — config/types.ts, parser.ts, validator.ts

**Goal**: 更新类型接口和 YAML 解析，不破坏编译

**Files**:
- `src/config/types.ts` — 修改 Model/AdapterConfig/AdapterModelMapping 接口
- `src/config/parser.ts` — 同步 loadConfigFromYaml/serializeConfigToYaml 映射
- `src/config/validator.ts` — 字段名和错误消息同步

**Changes**:

`types.ts`:
```typescript
// Model: {name, model} → {id}
export interface Model {
  id: string
}

// AdapterConfig: format → type
export interface AdapterConfig {
  name: string
  type: 'anthropic' | 'openai'
  models: AdapterModelMapping[]
}

// AdapterModelMapping: name→sourceModelId, model→targetModelId
export interface AdapterModelMapping {
  name: string
  provider: string
  model: string
}
// ↓ 改为：
export interface AdapterModelMapping {
  sourceModelId: string
  provider: string
  targetModelId: string
}
```

`parser.ts`:
- `loadConfigFromYaml`: `p.models.map(m => ({ id: m.id }))` — 从 `{name, model}` 读 → 写 `{id}`
- `serializeConfigToYaml`: `config.providers.map(p => ({ id: p.id }))` — 从 `Model.id` 写 → YAML `{id}`
- `serializeConfigToYaml`: Adapter models `{source_model_id, provider, target_model_id}`

`validator.ts`:
- 校验 `Model.id` 代替 `Model.name`/`Model.model`
- `AdapterConfig.format` → `type` 校验
- `AdapterModelMapping.sourceModelId`/`targetModelId` 校验（替代 `name`/`model`）
- 错误消息中英文统一：`Provider name` → `模型供应商名称`, `Model name` → `模型 ID`, `Adapter name` → `适配器名称`, `Mapping model` → `适配后模型 ID`

**Execution note**: YAML 配置字段从 `{name, model}` 直接改为 `{id}` — 用户需手动更新 ~/.llm-proxy/config.yaml

### 单元 2：代理层 — proxy/types.ts, router.ts, translation.ts, provider.ts, handlers.ts

**Goal**: RouterResult, inboundFormat 重命名，routeModel 适配新类型

**Files**:
- `src/proxy/types.ts` — `upstreamModel` → `modelId`
- `src/proxy/router.ts` — routeModel 实现和错误消息
- `src/proxy/translation.ts` — `inboundFormat` → `inboundType`, `route.upstreamModel` → `route.modelId`
- `src/proxy/provider.ts` — `inboundFormat` → `inboundType`
- `src/proxy/handlers.ts` — `inboundFormat` → `inboundType`

**Changes**:

`types.ts`:
```typescript
// upstreamModel → modelId
export interface RouterResult {
  providerName: string
  providerType: 'anthropic' | 'openai'
  apiKey: string
  apiBase: string
  modelId: string   // was: upstreamModel
}
```

`router.ts`:
- `model.name === modelName` → `model.id === modelName`
- `upstreamModel: model.model` → `modelId: model.id`
- 错误消息 `"未找到 model name"` → `"未找到模型 ID"`

`translation.ts`:
- `inboundFormat` → `inboundType`（参数名和 TransformResult 接口）
- `route.upstreamModel` → `route.modelId`（line 194, 201）
- `inboundFormat === route.providerType` → `inboundType === route.providerType`

`provider.ts`:
- `inboundFormat` → `inboundType`

`handlers.ts`:
- `inboundFormat` → `inboundType`
- log 中的 `format: inboundFormat` → `type: inboundType`
- `route.upstreamModel` → `route.modelId`

### 单元 3：适配器层 — adapter/router.ts, handlers.ts

**Goal**: 适配新类型系统

**Files**:
- `src/adapter/router.ts` — format→type, upstreamModel→modelId, inboundFormat→inboundType, mapping.model→targetModelId
- `src/adapter/handlers.ts` — inboundFormat→inboundType, upstreamModel→modelId

**Changes**:

`router.ts`:
- `inboundFormat` → `inboundType`（接口字段、返回 building）
- `resolveAdapterRoute`:
  - `mapping.model` → `mapping.targetModelId`（查找 provider.models）
  - `model.name === mapping.targetModelId` → `model.id === mapping.targetModelId`
  - `upstreamModel: model.model` → `modelId: model.id`
  - `inboundFormat: adapter.format` → `inboundType: adapter.type`
  - 错误消息 `${mapping.model}` → `${mapping.targetModelId}`
- `AdapterRouteResult.inboundFormat` → `inboundType`

`handlers.ts`:
- `adapterResult.inboundFormat` → `adapterResult.inboundType`
- `adapterResult.route.upstreamModel` → `adapterResult.route.modelId`
- log `format: adapterResult.inboundFormat` → `type: adapterResult.inboundType`

### 单元 4：API 层 — api/handlers.ts

**Goal**: 同步 handleGetConfig/handleGetAdapters/CRUD 响应和请求字段

**Files**:
- `src/api/handlers.ts`

**Changes**:
- `handleGetConfig`: Provider models `p.models`（不 map 直接引用），Adapter `format: a.format` → `type: a.type`
- `handleGetAdapters`: `m.model` → `m.targetModelId`, `m.name` → `m.sourceModelId`, 校验 `.find(pm => pm.name === m.model)` → `.find(pm => pm.id === m.targetModelId)`
- `handleCreateAdapter`: `format` 校验 → `type` 校验
- `handleUpdateAdapter`: `format` → `type`
- `handleUpdateProvider`: `models` 直接传（简化后无 name/model 转换）
- `handleCreateProvider`: `models` 直接传
- `handleListModels`: `model.name` → `model.id`（line 373）
- `handleTestModel`: 错误消息 `'format 必须为 anthropic 或 openai'` → `'type 必须为 anthropic 或 openai'`（line 217）
- `handleCreateAdapter`: `format` 校验 → `type` 校验，错误消息同步
- `handleDeleteProvider`: 引用检查中 `m.model` → `m.targetModelId`
- `handlePullModels`: 全面覆盖 — `existingSet.add(m.name)` → `existingSet.add(m.id)`, `filter((m) => m.name)` → `filter((m) => m.id)`, `existingSet.has(m.name)` → `existingSet.has(m.id)`（line 422, 429, 434）

### 单元 5：前端 UI — admin-ui.html

**Goal**: UI 标签和 JS 函数同步新命名

**Files**:
- `src/api/admin-ui.html`

**Changes**:
- Provider 模型行标签：`模型名` → `模型 ID`
- `addModelRow(model, providerType)` → 字段引用用 `id`：
  ```javascript
  function addModelRow(model, providerType) {
    // 模型标签改为"模型 ID"
    div.innerHTML = `<span class="pm-label">模型 ID</span>...`
  }
  ```
- `collectModelRows()` → `rows.push({ id: model })`（简化）
- Adapter 映射行标签：`供应商`（不变），`客户端模型名` → `适配前模型 ID`，`模型名` → `适配后模型 ID`
- `addMappingRow` 签名和字段引用：`name`→`sourceModelId`, `model`→`targetModelId`：
  ```javascript
  function addMappingRow(sourceModelId, provider, targetModelId, providers) {
    div.innerHTML = `<input class="am-source" placeholder="适配前模型 ID"...>
      <span class="pm-label">供应商</span>...
      <span class="pm-label">适配后模型 ID</span><select class="am-target"...>...`
  }
  ```
- `collectMappingRows`：`am-name`→`am-source`，`am-model`→`am-target`，字段 `name`→`sourceModelId`，`model`→`targetModelId`
- `updateMappingModels`：`am-model`→`am-target`
- 映射表格展示：`${m.sourceModelId} → ${m.provider}/${m.targetModelId}`
- 映射行 "添加" 按钮：签名同步
- `openProviderForm`：`addModelRow(m.model, ...)` → `addModelRow(m.id, ...)`
- `openAdapterForm`：`addMappingRow(m.name, ...)` → `addMappingRow(m.sourceModelId, ...)`
- `handlePullModels` 回调：`addModelRow(m.name, ...)` → `addModelRow(m.id, ...)`
- `pullModels` 回调显示：`m.name` → `m.id`

### 单元 6：测试文件同步

**Goal**: 所有测试通过新类型系统

**Files**（13 个测试文件）:

- `test/config/parser.test.ts` — Model `{id}` 代替 `{name, model}`
- `test/config/store.test.ts` — 同上
- `test/config/validator.test.ts` — 错误消息和字段同步
- `test/proxy/router.test.ts` — `upstreamModel` → `modelId`, `Model.name` → `Model.id`
- `test/proxy/translation.test.ts` — `upstreamModel` → `modelId`, `inboundFormat` → `inboundType`
- `test/proxy/stream-converter.test.ts` — 不改（功能独立）
- `test/adapter/router.test.ts` — mapping 字段重命名, `format` → `type`, `upstreamModel` → `modelId`, `inboundFormat` → `inboundType`
- `test/adapter/handlers.test.ts` — 配置 fixtures 字段同步
- `test/api/handlers.test.ts` — 配置 fixtures 字段同步
- `test/api/integration.test.ts` — 配置 fixtures 字段同步, API 响应字段校验

**Pattern**: 所有测试配置从 `{name: '...', model: '...'}` 改为 `{id: '...'}`。Adapter 格式从 `format: 'openai'` 改为 `type: 'openai'`。mapping 从 `{name, provider, model}` 改为 `{sourceModelId, provider, targetModelId}`。

## 迁移注意事项

1. **不兼容变更**：用户需手动更新 `~/.llm-proxy/config.yaml`：
   ```yaml
   # 改前
   models:
     - name: qwen-v3
       model: Qwen3.5-4B
   # 改后
   models:
     - id: Qwen3.5-4B
   ```
2. Adapter 需要同步：
   ```yaml
   # 改前
   models:
     - name: default
       provider: qwen-local
       model: qwen-v3
   # 改后
   models:
     - source_model_id: default
       provider: qwen-local
       target_model_id: Qwen3.5-4B
   ```
3. **没有迁移脚本**：直接告知用户手动改配置

## 验证

1. 编译通过：`tsc --noEmit`
2. 83 测试全通过
3. 代理启动正常（`llm-proxy start`）
4. Admin UI 正常显示 Provider 和 Adapter 配置
5. Proxy 请求正常转发
6. Adapter 正常路由

## 范围边界

- 不改 YAML/JSON camelCase vs snake_case 转换
- 不改 API 路由路径
- 不改 CLI 命令接口
- 不改 http-utils.ts
- 不改 stream-converter.ts 和 translation.ts 的流/响应转换逻辑（只改参数名）
- 不改 StatusTracker 和 Logger
- 不改 proxy/provider.ts 和 proxy/types.ts 文件名（内容改，名不改）
