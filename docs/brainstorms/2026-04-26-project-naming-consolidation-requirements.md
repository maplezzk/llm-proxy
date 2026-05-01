---
date: 2026-04-26
topic: project-naming-consolidation
---

# 项目命名和概念全面梳理

## Problem Frame

整个项目的命名系统存在多处概念混淆、命名不统一、中英文混用问题。随着项目功能增加，这些问题导致：
- 使用者（配置 YAML、Admin UI、错误消息）困惑于同一次概念在不同位置叫法不同
- 开发者需要记忆多个同义词 (type/format, adapter/适配器)
- 配置字段设计冗余（Model.name === Model.model 始终相等，别名功能已废弃）

## 需求

### R1. Provider.type 和 AdapterConfig.format 统一
- 两字段含义相同（`'anthropic' | 'openai'`），统一使用 `type` 命名
- ProviderConfigFile.type（YAML）和 Provider.type（内部）保持 `type` 不变
- AdapterConfigFile.format → `type`（YAML 字段），AdapterConfig.format → `type`（内部字段）
- ProviderConfig.type 验证错误消息中的 format → type（validator.ts）

### R2. Model 对象简化
- YAML `models` 列表从 `{name, model}[]` 简化为 `{id}[]`
- Model 接口字段：`id: string`（既是路由匹配 key，也是上游 API 模型 ID）
- ProviderConfigFile.models → `{id: string}[]`（YAML 字段）
- 移除 `Model.name` 和 `Model.model` 区分逻辑
- 路由（routeModel）直接匹配 Model.id

### R2b. AdapterModelMapping 字段重命名
- `AdapterModelMapping.name` → `sourceModelId`（TS）/ `source_model_id`（YAML）：适配前客户端发来的模型 ID
- `AdapterModelMapping.model` → `targetModelId`（TS）/ `target_model_id`（YAML）：适配后发给上游的模型 ID
- 三字段：`{sourceModelId, provider, targetModelId}`，语义自明
- `RouterResult.upstreamModel` → `modelId`（统一命名：发给上游的模型 ID，不再区分"上游"概念）
- `routeModel()` 返回值字段同步改名
- adapter/router.ts 中 mapping.model 引用同步更新

### R3. 命名不一致修复
- 错误消息和 UI 文案中英文统一：
  - `Provider` → `模型供应商`（中文文案统一）
  - `Adapter` → `适配器`（中文文案统一）
  - `Mapping` → `映射`（中文文案统一）
  - `Model` → `模型`（中文文案统一）
- proxy/router.ts 错误消息 "未找到 model name" → 更新为 "模型 ID"
- validator.ts 所有 `Provider name`/`Adapter name`/`Model name` 等英文字段名 → 中文
- adapter/router.ts 错误消息中的 `Provider` → `模型供应商`

### R4. 文件名 - 功能匹配
- `proxy/provider.ts` → 实际功能是请求转发，考虑重命名
- `proxy/types.ts` → 只有一个 RouterResult 类型，考虑合并

### R5. 路径和方法名一致性
- `AdapterRouteResult.inboundFormat` → `inboundType`（与 type 统一）
- `Transformer.inboundFormat` 参数 → `inboundType`
- 验证 `proxy/handlers.ts` 和 `adapter/handlers.ts` 中对应方法参数

### R6. Admin UI 同步
- Provider 表单中模型标签：`模型名` → `模型 ID`，移除 placeholder
- 前端 addModelRow 函数：字段名从 `name/model` → `id`
- Adapter 映射表单标签：`客户端模型名` → `适配前模型 ID`，`模型名` → `适配后模型 ID`
- 前端 addMappingRow / collectMappingRows / updateMappingModels：`name`→`source_model_id`，`model`→`target_model_id`
- Adapter 映射表格展示：`${m.name} → ${m.provider}/${m.model}` → `${m.sourceModelId} → ${m.provider}/${m.targetModelId}`
- 映射表格表头同步调整
- addMappingRow 参数签名：`(name, provider, model, providers)` → `(sourceModelId, provider, targetModelId, providers)`
- handleGetAdapters API 响应字段同步（admin-ui 中引用的数据字段名，非 API 返回格式）

## 非范围（Scope Boundaries）

- **不改 YAML/JSON camelCase vs snake_case 转换逻辑**（保持现状）
- **不改 API 路由路径**（`/admin/providers`、`/admin/adapters` 等不变）
- **不改 CLI 命令接口**（`llm-proxy start/stop/status/reload`）
- **不改 http-utils.ts**（`readBody`/`getDefaultApiBase` 功能稳定）
- **不改 stream-converter.ts 和 translation.ts 的流/响应转换逻辑**（功能稳定）
- **不改 StatusTracker 和 Logger**（功能独立、稳定）

## Success Criteria

1. Provider.type 和 AdapterConfig.type 字段统一（代码 + YAML + API）
2. Model 字段从 `{name, model}` 简化为 `{id}`（代码 + YAML + API）
3. AdapterModelMapping 三字段清晰：sourceModelId / provider / targetModelId
4. RouterResult.modelId 统一命名
5. AdapterConfig.type 与 Provider.type 统一
4. admin-ui.html UI 标签、error messages、toast 等中英文统一
5. 改动后测试 83 项全通过
6. 代理启动正常运行
7. 全部改动在一个分支/PR 中完成

## 关键决策

| 决策 | 方案 | 理由 |
|------|------|------|
| adapter config format→type | 不兼容变更 | 概念统一优先于向后兼容 |
| Model {name, model} → {id} | 不兼容变更 | 别名已废弃，保持无冗余 |
| Adapter {name, model} → {source_model_id, target_model_id} | 不兼容变更 | source/target 语义清晰，来源去向一目了然 |
| YAML/Typescript 风格分离 | 保持 camelCase/snake_case | 标准惯例，减少无意义变更 |
| UI 文案 | 全中文 | 目标用户中文 |
| 迁移方式 | 一次性改动 | 配置简单无需迁移脚本 |

## 依赖/假设

- **假设**：用户只有 ~5 个 models 的本地配置，没有脚本依赖当前字段名
- **假设**：没有外部系统依赖当前 API 响应格式
- **依赖**：Admin UI 模型字段简化需要确认 handleGetConfig API 也会同步修改

## 待解决问题

### 规划中解决
- [Needs research] proxy/provider.ts 是否需要改名。**决定：** 不改文件名，仅更新顶部注释明确功能
- [Needs research] proxy/types.ts RouterResult 类型是否合并到 proxy/router.ts。**决定：** 该类型被多个文件引用（translation.ts, adapter/router.ts），独立文件合理，不改

## 下一步

→ `/ce:plan` for structured implementation planning
