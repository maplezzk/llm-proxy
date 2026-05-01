---
date: 2026-04-25
topic: local-llm-proxy
focus: 通用代理核心 + 动态配置管理
---

# Ideation: 本地统一模型代理工具

## Codebase Context
全新项目，目录为空。用户目标：
1. **通用代理核心** — 原生支持 OpenAI + Anthropic 双格式，轻量本地运行
2. **动态配置管理** — 运行时热加载模型/Provider/Key 配置，无需重启
3. **AI 工具适配** — 适配 Claude Code、Cursor、Cline 等工具
4. **排除**：智能路由（按成本/延迟/能力自动路由）

## 外部调研摘要
- **Dario** (TypeScript, ~10K 行)：唯一原生双格式 + Claude 订阅复用，零依赖
- **LiteLLM** (Python)：最流行的生产级代理，100+ 供应商，OpenAI 格式统一
- **LM-Proxy** (Python)：可作为库引入，TOML 配置，双层级 Key 管理
- **Inference Gateway** (Go)：内置 MCP 中间件，开箱可观测性，~10K 行
- **nanollm** (TypeScript)：轻量，双格式支持，YAML 配置
- **ContextForge** (Python/IBM)：MCP/A2A/REST 联邦，大型方案

市场空白：没有任何工具同时满足 **轻量本地 + 原生双格式 + 动态配置 + 工具适配矩阵**。

## Ranked Ideas

### 1. 热加载配置 API（已选为 brainstorm 目标）
**Description:** 通过 HTTP API + CLI 命令运行时增删模型、切换 Provider、管理 API Key，不需要重启 proxy 进程。配置变更立即生效，不中断正在进行的 LLM 调用。
**Rationale:** 现有工具（LiteLLM、LM-Proxy）修改 config 文件后必须重启，中断正在进行的调用。这是 "动态配置管理" 焦点的核心功能。
**Downsides:** 需要处理配置变更的并发安全；部分 Provider SDK 可能不支持运行时重新初始化客户端。
**Confidence:** 100%
**Complexity:** Low
**Status:** Explored

### 2. Schema 感知协议桥
**Description:** 原生理解 OpenAI Chat Completions 和 Anthropic Messages API 两种 schema。路由到同族 provider 时保持原生 schema 不变（Anthropic→Anthropic 不走 OpenAI 转换层）。只有跨族路由时才做薄映射，仅映射核心参数（model、messages、temperature、max_tokens），其余透传。保留格式特有功能（thinking、tool_use 格式、system prompt 结构）。
**Rationale:** 现有方案将所有请求统一转成 OpenAI 格式，导致 Anthropic 特有功能丢失或畸变。本方案架构清晰：全保真 vs 翻译。
**Downsides:** 跨族薄映射仍有丢失功能的场景需要告警；需要维护两种协议的 schema 映射表和能力差异表。
**Confidence:** 100%
**Complexity:** Medium
**Status:** Unexplored

### 3. Multi-Tool 自动发现与配置注入
**Description:** 自动检测本地运行的 AI 工具进程（Claude Code、Cursor、Cline VS Code 扩展、Continue、Aider 等），自动生成/注入对应的 proxy 配置。为每个工具维护独立的配置沙箱（路由表、成本预算、模型 ACL），session 持久化，代理重启后恢复。
**Rationale:** 用户要为每个工具单独配置 base_url，且切工具就得重新配置。自动发现消除手动配置摩擦。会话隔离保证流量隔离。
**Downsides:** 需要维护每个工具的配置文件路径和格式映射；工具版本升级可能破坏自动配置；检测机制可能被安全软件拦截。
**Confidence:** 95%
**Complexity:** Medium
**Status:** Unexplored

### 4. 全局凭据保险箱
**Description:** 中央密钥存储，支持系统钥匙串、加密文件、环境变量三种后端。工具配置中只需写代理地址，代理自动注入对应 Provider 的 API Key。支持多 Key 轮转和用量配额。
**Rationale:** 用户要在 6-7 个工具里重复设 ANTHROPIC_API_KEY、OPENAI_API_KEY，一种常见的做法是把 key 写进 shell 配置文件不小心提交到 git。
**Downsides:** 系统钥匙串跨平台不一致（macOS Keychain vs Windows Credential Manager vs Linux secret-service）；需要代理有能力读取钥匙串；多 Key 轮转增加复杂度。
**Confidence:** 90%
**Complexity:** Medium
**Status:** Unexplored

### 5. 优雅降级与回退链
**Description:** 为一个"逻辑模型"配置多级静态 fallback：`claude-sonnet → gpt-4o → claude-haiku`。当首选模型不可用（超时、429、500）时，自动按链回退，并标记每个请求实际使用的模型。
**Rationale:** 用户在 Cursor 里写代码到一半，Claude API 突然 429，现有方案直接抛错。回退链可做到无缝降级。
**Downsides:** 回退链中的模型能力可能不一致（tool use vs 不支持）；请求可能切换到明显更弱的模型导致用户困惑。
**Confidence:** 85%
**Complexity:** Low
**Status:** Unexplored

### 6. 基于 Host 头的协议嗅探路由器（V2 可选）
**Description:** 单端口（如 8080），根据 HTTP Host 头自动判断协议：`api.openai.com` → OpenAI 格式，`api.anthropic.com` → Anthropic 格式。工具以为自己在直连原生 API，无需客户端适配。
**Rationale:** 打破"一个代理一个端口对应一种协议"的假设，让体验上更接近"透明代理"。
**Downsides:** 增加了配置复杂度（用户仍需设置 Host 头或用 DNS 劫持）；对标准 SDK 用户来说直接设 base_url 更简单。
**Confidence:** 70%
**Complexity:** Low
**Status:** Unexplored

### 7. 用量配额与预算护栏（V2 可选）
**Description:** 为每个模型/工具/用户维度设置 token 配额和金额预算，达到阈值后自动拒绝或降级到低成本模型。支持按天/周/月周期重置。
**Rationale:** 开发者调 prompt 时一个死循环耗尽 $100 额度并不罕见。现有 proxy 只做路由不管钱。
**Downsides:** 需要准确的 token 计数（不同模型的 tokenizer 不同）；预算超限后的降级策略复杂。
**Confidence:** 65%
**Complexity:** Medium
**Status:** Unexplored

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | 透明请求录制与重放引擎 | 调试器功能，非代理核心，流式录制极复杂 |
| 2 | 模型原生协议适配层(NAT) | 合并到 Schema 协议桥，不独立保留 |
| 3 | 离线 Mock 与故障注入 | 测试工具，非核心，用户可用 wiremock 替代 |
| 4 | 流式恢复与断点续传 | 极高成本，LLM 请求秒级完成，中断概率低 |
| 5 | Unix Socket 原生代理 | 传输层选择，HTTP 已足够，多数工具不支持 UDS |
| 6 | 请求优先级队列与背压控制 | 接近 smart routing，单用户场景价值为零 |
| 7 | 跨 Provider 语义缓存 | 需要 embedding 推理，正确性隐患，成本高风险大 |
| 8 | FUSE 文件系统即配置 | 过度工程，macFUSE 需额外安装 |
| 9 | 团队协同代理网络 | 偏离"本地代理"定位，分布式复杂度高 |
| 10 | 语义探知预取器 | 投机执行，浪费 token，可能负价值 |
| 11 | 动态模型元数据注册表 | 合并到热加载配置 API |
| 12 | 多工具会话隔离 | 合并到 Multi-Tool 自动发现 |

## Session Log
- 2026-04-25: 初始构思 — 19 个候选方案生成，7 个幸存，12 个拒绝。方案 #1 (热加载配置 API) 选为 brainstorm 目标。
- 2026-04-25: Brainstorm 完成。需求文档写入 `docs/brainstorms/2026-04-25-hot-reload-config-requirements.md`。关键决策：YAML + reload 为唯一配置变更路径（无 CRUD API）、密封 Provider 类型、保留协议桥占位。
