---
title: 修复代理服务用户体验问题
type: fix
status: active
date: 2026-05-15
---

# 修复代理服务用户体验问题

## 概述

修复 llm-proxy 中三个影响用户体验的问题：适配器 URL 中重复 `/v1` 导致请求失败、模型供应商配置保存时错误信息不完整、模型测试功能缺乏可观测性。

---

## Problem Frame

用户在使用 llm-proxy 过程中遇到三个体验问题，分别涉及适配器请求正确性、配置异常反馈完整性、测试调试可观测性。这些问题降低了工具的可用性和排障效率。

---

## Requirements Trace

- R1. 适配器 URL 自动去除重复的 `/v1` 路径段，无论 `api_base` 是否已包含 `/v1`
- R2. 模型供应商配置保存校验失败时，前端 toast 中展示具体的错误详情（字段名 + 错误原因）
- R3. 模型测试结果中展示完整的请求信息：URL、Headers、请求 Body，以及详细的错误原因

---

## Scope Boundaries

- 不改变现有 URL 拼接逻辑的整体结构，只在关键路径添加去重
- 不改变模型测试的底层 HTTP 请求逻辑，只增强测试结果 UI 展示
- 不涉及适配器测试（adapter test）的改造，仅针对模型测试（test-model）
- 不添加新的 API 端点

---

## Context & Research

### Relevant Code and Patterns

- **适配器 URL 拼接**: `src/proxy/translation.ts` 的 `transformInboundRequest()` — `${route.apiBase}/v1/${upstreamEndpoint}`
- **适配器路由**: `src/adapter/router.ts` 的 `resolveAdapterRoute()` — 返回 `apiBase` 给 translation 层
- **适配器请求入口**: `src/adapter/handlers.ts` 的 `handleAdapterRequest()` — 经 `forwardPipeline` 调用 `transformInboundRequest`
- **代理请求入口**: `src/proxy/handlers.ts` 的 `handleAnthropicMessages`, `handleOpenAIChat`, `handleOpenAIResponses` — 同样经 `forwardPipeline` 调用 `transformInboundRequest`
- **模型测试后端**: `src/api/handlers/model-handlers.ts` 的 `handleTestModel()` — 返回 `{ reachable, latency, error }`
- **模型测试前端组件**: `src/api/admin/components/test-panel.ts` — 展示测试结果
- **模型测试 UI 模板**: `src/api/admin-ui.html` — 第 804-832 行，测试面板渲染
- **供应商保存后端**: `src/api/handlers/provider-crud.ts` 的 `handleCreateProvider()` / `handleUpdateProvider()` — 返回 `{ success: false, error: '校验失败', errors: [...] }`
- **供应商保存前端**: `src/api/admin/components/providers.ts` 的 `save()` 方法 — `toast(res.error, 'error')` 仅展示顶层 error
- **供应商保存 UI 模板**: `src/api/admin-ui.html` — 第 480-560 行
- **配置校验器**: `src/config/validator.ts` — 返回详细的 `ValidationError[]`

### External References

- 无。代码库内部模式已充分覆盖。

---

## Key Technical Decisions

- **URL 去重位置选择在 `http-utils.ts`**: 提供一个 `sanitizeApiBase()` 工具函数，在 `transformInboundRequest` 和 `handleTestModel` 等所有 URL 拼接入口调用，确保集中去重而不是分散在各处
- **前端错误展示**: 供应商保存失败时，将 `res.errors` 数组中的每条错误用换行列出来，叠加在 `res.error` 文本之后，既兼容现有逻辑又增加可读性
- **模型测试详情**: 在后端返回中增加 `requestUrl`, `requestHeaders`, `requestBody` 字段，前端用可折叠的详情面板展示

---

## Implementation Units

- [ ] U1. **核心工具：URL 去重函数**

**Goal:** 提供 `sanitizeApiBase()` 函数，自动移除 `api_base` 末尾多余的 `/v1` 和末尾斜杠

**Requirements:** R1

**Dependencies:** None

**Files:**
- Modify: `src/lib/http-utils.ts` — 添加 `sanitizeApiBase()` 函数
- Test: `test/lib/http-utils.test.ts` — 新增测试文件

**Approach:**
- 在 `http-utils.ts` 中添加 `export function sanitizeApiBase(base: string): string`
- 逻辑：`base.replace(/\/+v1\/?$/i, '').replace(/\/+$/, '')`
  - 先去掉末尾的 `/v1` 或 `/V1`（大小写不敏感），同时去掉 `/v1/` 末尾多余的斜杠
  - 再统一去掉末尾的 `/`
- 在 `getDefaultApiBase` 上方或下方添加，保持文件结构整洁

**Execution note:** 测试优先 — 先写测试覆盖各种边界情况再实现函数

**Patterns to follow:**
- `maskUrl()` 和 `maskHeaders()` 工具函数的命名和导出风格（`src/proxy/provider.ts`）

**Test scenarios:**
- Happy path: `sanitizeApiBase('https://api.example.com/v1')` → `'https://api.example.com'`
- Happy path: `sanitizeApiBase('https://api.example.com/v1/')` → `'https://api.example.com'`
- Happy path: `sanitizeApiBase('https://api.example.com/V1')` → `'https://api.example.com'`（大小写不敏感）
- Edge case: `sanitizeApiBase('https://api.example.com')` → `'https://api.example.com'`（不含 /v1 时不变）
- Edge case: `sanitizeApiBase('https://api.example.com/')` → `'https://api.example.com'`（仅去末尾斜杠）
- Edge case: `sanitizeApiBase('https://api.example.com/v1/models')` → `'https://api.example.com/v1/models'`（v1 不在末尾不触发）
- Edge case: `sanitizeApiBase('https://api.example.com/v1/extra')` → `'https://api.example.com/v1/extra'`
- Edge case: `sanitizeApiBase('')` → `''`
- Edge case: `sanitizeApiBase('/v1')` → `''`

**Verification:**
- 所有测试用例通过

---

- [ ] U2. **后端 URL 去重集成**

**Goal:** 在 `transformInboundRequest()` 和 `handleTestModel()` 中使用 `sanitizeApiBase()` 确保所有 URL 拼接路径都去除了重复 `/v1`

**Requirements:** R1

**Dependencies:** U1

**Files:**
- Modify: `src/proxy/translation.ts` — 在 `transformInboundRequest()` 中对 `route.apiBase` 调用 `sanitizeApiBase()`
- Modify: `src/api/handlers/model-handlers.ts` — 在 `handleTestModel()` 和 `handleTestAdapter()` 中对 `baseUrl` 调用 `sanitizeApiBase()`
- Test: `test/proxy/translation.test.ts` 或新增测试

**Approach:**
- `translation.ts` 中导入 `sanitizeApiBase`，在 `transformInboundRequest` 函数中对收到的 `route.apiBase` 做去重：
  ```ts
  const apiBase = sanitizeApiBase(route.apiBase)
  const url = `${apiBase}/v1/${upstreamEndpoint}`
  ```
- `model-handlers.ts` 中导入 `sanitizeApiBase`，在 `handleTestModel` 和 `handleTestAdapter` 中对 `baseUrl` 做去重
- 无需改动 adapter/router.ts，因为 adapter 路由返回的 apiBase 会被 translation 层消费

**Patterns to follow:**
- 现有 `maskUrl`、`maskHeaders` 工具的导入使用模式

**Test scenarios:**
- 集成场景：当 route.apiBase = `'https://api.example.com/v1'` 时，transformInboundRequest 生成 `'https://api.example.com/v1/messages'` 而不是 `'https://api.example.com/v1/v1/messages'`
- 集成场景：当 route.apiBase = `'https://api.openai.com'` 时，行为不变
- E2E：handleTestModel 中 repeat 同样逻辑

**Verification:**
- 现有测试全部通过
- URL 拼接结果不再包含重复 `/v1`
- 单元测试覆盖正常 apiBase 和含 `/v1` 的 apiBase

---

- [ ] U3. **供应商保存错误信息展示**

**Goal:** 模型供应商配置保存失败时，前端 toast 展示后端返回的具体校验错误信息

**Requirements:** R2

**Dependencies:** None

**Files:**
- Modify: `src/api/admin/components/providers.ts` — 在 `save()` 方法的失败分支中合并展示 `errors` 详情

**Approach:**
- 后端 `handleCreateProvider` 和 `handleUpdateProvider` 已经返回 `{ success: false, error: '校验失败', errors: [...] }`，前端无需改后端
- 在 `providers.ts` 的 `save()` 方法中，当 `!res.success` 时，修改 toast 消息：

```ts
if (!res.success) {
  const detail = res.errors?.length
    ? res.error + '\n' + res.errors.map((e: any) => '• ' + (e.field || '') + ': ' + e.message).join('\n')
    : res.error || t('admin.providers.saveFailed')
  toast(detail, 'error')
  return
}
```

- 由于 toast 目前只支持简单文本，用 `'\n'` 换行显示（toast 容器已支持多行文本）

**Patterns to follow:**
- 现有 `toast()` 调用模式

**Test scenarios:**
- 功能验证：提交缺少必填字段的供应商表单，toast 显示 "校验失败\n• providers.xxx.api_key: API Key 不能为空"
- 功能验证：提交重复名称的供应商，只显示 error 字段（没有 errors 数组时保持原样）
- 功能验证：提交类型无效的供应商，显示具体字段路径和错误

**Verification:**
- 保存校验失败时 toast 显示完整的详细错误信息

---

- [ ] U4. **模型测试可观测性增强 — 后端**

**Goal:** 模型测试后端返回请求 URL、Headers 和 Body 信息，前端可以展示详细的调试信息

**Requirements:** R3

**Dependencies:** None

**Files:**
- Modify: `src/api/handlers/model-handlers.ts` — 在 `handleTestModel()` 和 `handleTestAdapter()` 的返回数据中增加调试字段
- Modify: `src/api/admin/components/test-panel.ts` — 更新 `run()` 方法解析新的返回字段

**Approach:**
- 在 `handleTestModel()` 中，在发送请求前记录请求参数：

```ts
const debugInfo = {
  requestUrl: url,
  requestHeaders: maskHeaders(headers),   // 用现有 maskHeaders 脱敏
  requestBody: requestBody,               // 包含 model、messages 等
}
```

- 在成功和失败分支的返回数据中附带：
  ```ts
  data: { reachable, latency, model, error, ...debugInfo }
  ```

- `handleTestAdapter()` 同理

- 使用已有的 `maskHeaders()`（`provider.ts` 中的）对 Headers 脱敏，避免 API Key 泄露
- `maskHeaders()` 目前在 `provider.ts` 中是模块内函数，需要导出或复制到 model-handlers

**Patterns to follow:**
- 现有的 `sanitizeError()` 函数模式，保护敏感信息

**Test scenarios:**
- 功能验证：测试成功时返回数据包含 `requestUrl`、`requestHeaders`、`requestBody`
- 功能验证：测试失败时也同样包含
- 安全验证：`requestHeaders` 中的 Authorization 和 x-api-key 被正确脱敏
- 安全验证：`requestBody` 中不包含 API Key（仅 model 和 messages 等字段）

**Verification:**
- 所有测试通过，手动验证返回结构正确

---

- [ ] U5. **模型测试可观测性增强 — 前端 UI**

**Goal:** 在测试结果面板中展示详细的请求信息，包括 URL、Headers、Body 和错误详情，支持折叠展开

**Requirements:** R3

**Dependencies:** U4

**Files:**
- Modify: `src/api/admin/components/test-panel.ts` — 更新 `run()` 方法保存 `result` 中的调试字段
- Modify: `src/api/admin-ui.html` — 更新测试面板模板，添加详情展示区域

**Approach:**
- `test-panel.ts` 中 `run()` 方法保存调试信息到结果对象：

```ts
this.results.unshift({
  model: this.selectedModel,
  ok: d.reachable === true,
  latency: d.latency,
  error: d.error,
  time: new Date().toLocaleTimeString(),
  // 新增字段
  requestUrl: d.requestUrl,
  requestHeaders: d.requestHeaders,
  requestBody: d.requestBody,
})
```

- `admin-ui.html` 中测试结果卡片增加可折叠详情面板：

```html
<template x-for="(r, i) in results" :key="i">
  <div>
    <div style="...当前结果行的样式...">
      ...
    </div>
    <!-- 新增可折叠详情 -->
    <div x-show="r.requestUrl" style="...">
      <div @click="r._showDetails = !r._showDetails"
           style="cursor:pointer;font-size:11px;padding:4px 12px;color:var(--accent)">
        <span x-text="r._showDetails ? '收起详情 ▲' : '展开详情 ▼'"></span>
      </div>
      <div x-show="r._showDetails" style="padding:8px 12px;font-size:11px;background:var(--surface-bg);border-radius:var(--radius)">
        <div><strong>URL:</strong> <span class="mono" x-text="r.requestUrl"></span></div>
        <div><strong>Headers:</strong> <pre style="..." x-text="JSON.stringify(r.requestHeaders, null, 2)"></pre></div>
        <div><strong>Body:</strong> <pre style="..." x-text="JSON.stringify(r.requestBody, null, 2)"></pre></div>
        <div x-show="r.error"><strong>错误:</strong> <span x-text="r.error" style="color:var(--danger)"></span></div>
      </div>
    </div>
  </div>
</template>
```

**Patterns to follow:**
- 现有测试结果卡片样式
- 折叠交互模式参考 adapter test modal 的设计

**Test scenarios:**
- 功能验证：测试运行后，结果卡片下方显示"展开详情"按钮
- 功能验证：点击展开后显示 URL、Headers、Body、错误信息
- 功能验证：再次点击收起
- 样式验证：Headers 中 API Key 被正确脱敏（由后端保证）

**Verification:**
- 手工测试：执行模型测试，展开详情，确认 URL/Headers/Body 正确显示

---

## System-Wide Impact

- **API 表面**: `handleTestModel` 和 `handleTestAdapter` 的响应结构变化（新增字段），前端消费方需要同步更新（本计划已包含）
- **错误传播**: 无影响
- **不变契约**: `maskHeaders` 导出后不影响现有行为，`sanitizeApiBase` 不改变正常 apiBase 的处理结果

---

## Risks & Dependencies

| 风险 | 缓解 |
|------|------|
| maskHeaders 从 provider.ts 导出可能引入循环依赖 | 如果出现循环依赖，将 maskHeaders 提取到 http-utils.ts 中 |
| sanitizeApiBase 过于激进，误删正常路径中的 /v1 | 通过正则 `\/+v1\/?$` 限定仅匹配末尾的 /v1 段，测试覆盖所有边界 |
| 前端 toast 多行文本展示效果 | 确认 toast 容器使用 `white-space: pre-line` 或不截断换行符 |

---

## Documentation / Operational Notes

- 无。这些修复对用户操作流程无影响，仅改善错误信息和调试体验。
