---
date: 2026-04-25
topic: hot-reload-config-api
---

# 热加载配置 API

## Problem Frame

现有 LLM 代理工具（LiteLLM、LM-Proxy 等）的配置管理方式停留在"编辑配置文件 → 重启进程"的阶段。每次增删模型、切换 Provider、更新 API Key 都需要中断正在运行的 LLM 调用。对于日常使用多个模型和工具的开发者来说，这种摩擦是核心痛点。

本需求文档定义 LLM-Proxy 配置管理的运行时 API 和数据模型，实现**不重启的热加载配置管理**。

用户工作流：编辑 YAML 配置文件 → 调用 `POST /admin/config/reload` → 配置原子生效，零中断。

## Requirements

### 配置模型与存储
- R1. 配置文件使用 YAML 格式，默认路径为 `~/.llm-proxy/config.yaml`，支持 `--config` 参数覆盖
- R2. 配置结构采用 **Provider 包裹 Model** 模式：Provider 是顶层实体，Model 嵌套在 Provider 下
- R3. 支持环境变量插值 `${VAR_NAME}` 注入 API Key 等敏感字段。引用未定义的环境变量导致配置校验失败
- R4. 配置结构中 Model 使用**本地别名映射**：`name` 是工具请求时使用的本地标识，`model` 是实际发送给上游的模型名
- R5. Provider 类型只有两种：`anthropic`（原生 Anthropic Messages API）和 `openai`（OpenAI Chat Completions 及其兼容协议）

### 管理 API
- R6. 管理 API 路径统一以 `/admin/` 为前缀，与 AI 请求路径（`/v1/`）完全隔离
- R7. 管理 API 默认绑定 `127.0.0.1`，不设独立认证（本地安全模型），支持 `--admin-host` 和 `--admin-port` 覆盖
- R8. 提供配置查询端点：`GET /admin/config` — 返回当前运行时完整配置（脱敏 API Key）
- R9. 提供配置重载端点：`POST /admin/config/reload` — 重新读取 YAML 配置文件，校验后原子生效
- R10. 提供健康检查端点：`GET /admin/health` — 简单存活探针，返回 200
- R11. 提供 Provider 状态查询端点：`GET /admin/status/providers` — 基于请求统计被动返回各 Provider 的可用性概览（不主动探测）
- R12. 所有管理 API 端点返回一致的 JSON 响应结构：`{ "success": bool, "data": ..., "error": ... }`

### 热加载机制
- R13. 热加载**仅通过 API 触发**（`POST /admin/config/reload`），不监听文件系统变更
- R14. 重载时先校验新配置的合法性，校验通过后原子替换运行时配置，不中断进行中的请求
- R15. 正在进行中的请求使用切换前的旧配置继续完成，新请求使用新配置
- R16. 配置校验包括：Provider 名称唯一性、Model 名称唯一性、API Key 非空、Provider type 合法性

### CLI
- R17. 提供基础 CLI 命令：`llm-proxy start`（启动代理）、`llm-proxy stop`（停止）、`llm-proxy status`（查看状态）、`llm-proxy reload`（触发配置重载）
- R18. CLI 默认从 `~/.llm-proxy/config.yaml` 读取配置

### 与 Schema 协议桥的集成（占位，推迟到协议桥模块定义后）
- R19. 配置重载时，路由表（Provider → Model → 协议类型）同步更新，无需重启协议桥
- R20. Provider 的 `type` 字段直接决定协议桥使用 OpenAI 还是 Anthropic 格式处理请求
- R21. 配置移除某个 Provider 时，对应进行中的请求优雅完成后再关闭连接

## Success Criteria
1. 编辑 YAML 配置文件 → 调用 `POST /admin/config/reload` → 新请求使用新配置，零中断
2. 更新 API Key 后调用 `POST /admin/config/reload` → 新认证凭据立即生效
3. 删除 Provider 后调用 `POST /admin/config/reload` → 进行中请求正常完成，新请求不再路由到已删除 Provider
4. 配置校验失败 → 返回明确错误信息，运行时配置保持不变，不崩溃
5. `GET /admin/config` 返回的运行时配置与 YAML 文件内容一致（Key 脱敏）

## Scope Boundaries
- 不包括 Web UI 界面（后续可加）
- 不包括配置模板或配置同步功能
- 不包括 Provider CRUD 管理端点（配置变更通过 YAML 编辑 + reload 完成）
- 不包括主动 Provider 健康探测（仅被动统计）
- 不包括按内容的路由规则（如 prompt 关键词路由）

## Key Decisions
- **YAML 编辑 + reload 为唯一配置变更路径**：无 CRUD API，避免运行时状态与文件的分歧
- **管理 API 无认证**：默认本地绑定 + 后续可通过反向代理加认证，保持简洁
- **Provider 包裹 Model**：结构紧凑，符合"一个 Provider 下一组模型"的自然认知
- **Provider 类型为密封枚举**：仅 anthropic 和 openai 两种，不加未来扩展抽象

## Dependencies / Assumptions
- 假设配置文件始终可读。若文件不存在或权限不足，启动时报错退出
- 假设配置变更不频繁（秒级，无需微秒级热交换）

## Outstanding Questions

### Resolve Before Planning
暂无 — 所有产品决策已明确。

### Deferred to Planning
- [Affects R8-R12][Technical] Go vs Rust 实现选择，影响 HTTP 框架和序列化库选择
- [Affects R14][Technical] 运行时配置的并发安全实现：`sync.RWMutex` vs `atomic.Value` vs 版本号机制
- [Affects R16][Technical] 配置校验规则详情：Provider type 支持范围、Model 名合法字符、Key 格式验证
- [Affects R11][Technical] Provider 状态统计：滑动窗口时间粒度、可用性判定阈值

## Next Steps
→ `/ce:plan` for structured implementation planning
