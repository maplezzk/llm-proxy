---
date: 2026-04-25
topic: admin-ui-crud-and-model-test
---

# 管理 UI 配置 CRUD 与模型测试功能

## Problem Frame

当前配置管理需要手动编辑 YAML 文件后触发热重载，操作门槛较高。管理后台仅有只读展示，无法增删改 Provider 和 Adapter。同时，配置完成后缺乏快速验证模型连通性的能力——用户需要改配置后开启一个独立客户端才能确认模型可用。

## Requirements

### Admin API CRUD (R1-R8)
- R1. 新增 `POST /admin/providers` — 添加 Provider，body 包含 name, type, apiKey, apiBase（可选）, models[]
- R2. 新增 `PUT /admin/providers/:name` — 更新指定 Provider
- R3. 新增 `DELETE /admin/providers/:name` — 删除指定 Provider
- R4. 新增 `POST /admin/adapters` — 添加 Adapter
- R5. 新增 `PUT /admin/adapters/:name` — 更新指定 Adapter
- R6. 新增 `DELETE /admin/adapters/:name` — 删除指定 Adapter
- R7. 每次 CRUD 操作写入 config.yaml 并自动触发热重载（写后即 reload）
- R8. CRUD 操作校验规则与现有 validator 一致，失败时返回 400 及错误列表

### 模型直连测试 (R9-R12)
- R9. 新增 `POST /admin/test-model` — 直接向上游 API 发送测试请求，验证 API Key 和模型可用性
- R10. 请求体参数：type（openai | anthropic）、apiKey、apiBase（可选，默认官方地址）、model（上游模型名）、providerName（用于日志标记）
- R11. 发送最小化的聊天请求（1 条 user 消息），超时时间 15 秒
- R12. 响应格式：`{ success: true, data: { reachable: boolean, latency: number, model: string, error?: string } }`

### Web UI 配置编辑 (R13-R17)
- R13. Provider 列表页每行增加「编辑」和「删除」按钮
- R14. 新增 Provider/Adapter 的添加表单（模态框或内联表单）
- R15. 编辑时预填现有数据，表单字段与 API 对应
- R16. 删除前需要确认提示
- R17. 操作后自动刷新列表（无需手动重载页面）

### Web UI 模型测试 (R18-R19)
- R18. Provider 列表页每行增加「测试」按钮
- R19. 测试结果显示在行内或浮动提示中，展示连通性、延迟时间

## Config 示例（CRUD 后的 YAML 结构不变）

```yaml
providers:
  - name: qwen-local
    type: openai
    api_key: sk-1234
    api_base: http://127.0.0.1:19999
    models:
      - name: Qwen3.5-4B-MLX-4bit
        model: Qwen3.5-4B-MLX-4bit

adapters:
  - name: my-tool
    format: openai
    models:
      - name: default
        provider: qwen-local
        model: Qwen3.5-4B-MLX-4bit
```

## Success Criteria
- 通过 UI 可以完整创建、编辑、删除一个 Provider 或 Adapter，无需手动编辑 YAML
- 配置变更后自动重载，立即生效
- 点击「测试」按钮能在 15 秒内返回上游连通性结果
- 所有 CRUD 操作有正确的数据完整性校验（如删除被 adapter 引用的 provider 应被阻止或警告）

## Scope Boundaries
- CRUD 不涉及 API Key 的加密存储（明文写入 YAML，与现有模式一致）
- 不涉及用户认证（Admin API 无认证，与现有模式一致）
- 模型测试仅做连通性验证，不测试并发、限流、错误重试等场景
- 不修改已有的 YAML 编辑器——两种方式并存

## Key Decisions
- **自动写回**：CRUD 操作直接写 config.yaml + 触发热重载，无需手动保存。表单提交即生效
- **直连上游测试**：不经过代理路由，直接调用上游 API 验证连通性——路由配置问题不影响测试结果，更快速定位问题
- **复用 `yaml` 包的 stringify**：用已有的 `yaml` 依赖将修改后的 Config 序列化为 YAML 写回文件，保持格式一致
- **序列化时使用 ConfigFile（snake_case）结构**：内存 Config 使用 camelCase（apiKey、apiBase），写回文件前需转换为 ConfigFile 格式（api_key、api_base），防止下次读取时字段不匹配
- **CORS 更新**：在 server.ts 的 CORS 头部中增加 PUT 和 DELETE 方法，确保浏览器端 CRUD 操作不被拦截
- **设计 ConfigStore 新增 writeConfig 方法**：将 Config 写回文件，与 reload 解耦——先写文件再 reload，两步保证一致性

## Dependencies / Assumptions
- 依赖已有的 `yaml` 包（eemeli/yaml）的 `stringify` 功能，无需新增依赖
- ConfigStore 需要新增 `writeConfig(path)` 方法或现有 `reload` 的变体
- YAML 编辑器的「保存」功能与 CRUD API 的自动写回到同一文件（R7），可能存在竞态——需要简单互斥或先读后写的原子操作
- 环境变量插值（如 `${OPENAI_API_KEY}`）在 CRUD 写回后会被解析为明文值，丢失模板。这与 Scope Boundaries 中"API Key 明文写入 YAML"一致——接受此行为

## Outstanding Questions

### Deferred to Planning
- [Affects R13-R17][Needs design] Web UI 中 CRUD 表单的具体布局（模态框 vs 内联编辑 vs 侧边面板）
- [Affects R18-R19][Needs design] 测试结果的展示方式（行内状态标记 vs toast 通知 vs 详情弹窗）
- [Affects R1-R6][Technical] Provider 名称和 Adapter 名称作为路由参数（:name），URL 编码处理
- [Affects R7][Technical] YAML 写回时是否需要保留注释和格式（使用 yaml stringify 会丢失注释）
