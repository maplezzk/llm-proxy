# AxonHub 源码深度分析（llm-proxy 对标）

- 日期：2026-07-27
- 方法：6 个 subagent 并行深扫 AxonHub 源码（`~/Desktop/project/agents/axonhub`，Go 项目）+ 1 架构师综合。每条结论带 `文件:行号` 证据。
- 用途：主计划 `docs/plans/2026-07-27-002-master-axonhub-class-gateway-plan.md` 的范围依据。

## 一、最终判断

**用户关心的两个高级功能，AxonHub 都真支持，且是一等能力（专门设计过，不是凑出来的）：**

### 推理等级——支持，有 canonical 中间表示
- 核心抽象 `llm.Request.ReasoningEffort`（string，`llm/model.go:177`）+ `ReasoningBudget *int64` + `ReasoningSummary *string`。
- 四协议归一化互转：anthropic thinking block / openai reasoning_effort / openai-responses reasoning 对象 / gemini ThinkingConfig。
- 用内部哨兵 `xhigh` 无损承载 anthropic 的 `max`（openai/gemini 出站显式降级）。
- 配套四层：① 模型名后缀解析（`gpt-5-high`→model+effort，含 qwen-max 误伤守卫）；② per-channel `ReasoningEffortMapping[{From,To}]` 值映射（首匹配、未命中透传）；③ effort↔budget 默认表（low=5000/medium=15000/high=xhigh=max=30000 + 反向阈值）；④ TransformerMetadata sidecar 保协议私有字段无损往返 + 签名来源启发式（`gAAAA*`→OpenAI Fernet、`Eq*`→Anthropic）。
- **它没有的**：没有命名为"推理 profile/模板（等级→一组参数）"的一等配置对象；没有把"等级→下游值"映射表（thinkingLevelMap）暴露给消费端做自动发现。（这两点原计划 R1/R10 暂不做。）

### 自定义参数注入——支持，是专门的声明式引擎
- `internal/server/orchestrator/override.go`（9 操作分派，`applyOverrideRequestBody` 约 :149-260）。
- per-channel 配一组 `OverrideOperation{op,path,from,to,value,condition,match,index,splat}`，作为 pipeline 中间件在 transformer 产出**原始 HTTP body/header** 之后用 sjson/gjson 路径改写。
- 9 操作：set / set_if_absent / delete / rename / copy / array_append / array_prepend / array_insert / array_remove。
- value/condition 走 Go text/template（`.RequestModel/.Model/.Metadata/.RequestHeader/.ReasoningEffort`），渲染结果自动解析为结构化值；condition 渲染后 `=='true'` 才执行。
- 作用在原始 body 而非逻辑对象 → 能注入 transformer 不认识的上游私有字段，与协议转换解耦。安全边界：`path='stream'` 被拒绝。
- **llm-proxy 完全没有此能力。**

## 二、AxonHub 全貌（强项）

- 10+ 提供商，协议：OpenAI/Anthropic/Gemini + embedding/image/rerank（realtime todo）。
- 路由：6 种模型关联（channel_model/regex/tag）+ priority 严格 failover + when 条件 + 5min 缓存。
- failover：两层重试（同 channel 换 model → 跨 channel），429 强制换道，三层可重试判定（全局 429+5xx + provider 级状态码 + 错误 pattern）。
- 负载均衡：4 套预组装 LB × 8 打分策略（EWMA/限流/配额/权重），partial top-k + 防扎堆。
- 熔断：per-(channel,model) 内存状态机（半开/全开/探测租约 CAS 单飞/指数退避）。
- 可观测：Request+RequestExecution 双表（body 可卸载对象存储），PerformanceRecord 打点（TTFT/推理时长），EWMA 喂 LB。
- usage：15+ 维（cache read/write 含 TTL 变体、reasoning、audio、prediction）；EnsureUsage 自动注入 `stream_options.include_usage`。
- 成本：多定价模式（flat/per-unit/tiered/volume）× price items + 时间表 + decimal。
- 模型：`/v1/models` + `/v1/models/{model}`，`OpenAIModel{ContextLength,MaxOutputTokens,Modalities{input,output},Capabilities{vision,tool_call,reasoning},Pricing}`，include 参数按需返回；ModelFetcher 每小时同步上游 `/models`。
- trace：Trace/Thread 实体，header/body 提取 + 客户端嗅探（Claude Code/Codex/OpenCode），tool_call_id 重建 agent 时间线树。
- 平台：Go+Gin+ent ORM（27 实体）+gqlgen GraphQL（~10000 行）+fx DI+多 DB（sqlite/pg/mysql）+auto migration；多租户（RBAC 19 scope/project 行级隔离/API Key 四类型/配额三时间窗）。

## 三、逐功能差距表（精选）

| 功能 | AxonHub | llm-proxy 现状 | 差距 |
|------|---------|----------------|------|
| canonical reasoning | `llm.Request.ReasoningEffort`+Budget+Summary，四协议归一 | config 有 reasoning_effort（含 xhigh/max）但仅静态注入，两两直转丢等级 | 中 |
| 模型名后缀解析 | auto_reasoning_effort 中间件 + 误伤守卫 | 无 | 小 |
| 自定义参数注入 | 9 操作声明式 override 引擎 | 完全没有 | 中（简化版 ~300 行 TS） |
| 多上游 + 优先级路由 | 6 关联 + priority + when | router.ts 64 行精确单目标 | 大（实用子集 M） |
| failover | 两层重试 + 429 换道 + 三层判定 | 无，上游失败直接返回 | 中大 |
| 负载均衡 | 4 LB × 8 策略 | 无 | 中（单用户只需 weight+round-robin+衰减） |
| 熔断 | per-(channel,model) 状态机 | 无（StatusTracker 被动） | 中（纯 Map 简化版 ~200 行） |
| 流式健壮性 | 首事件超时 + 预读 3 事件判空 | 全量解析 SSE 但无超时/判空 | 小 |
| /v1/models | OpenAI 兼容 + include + ModelCard | 无端点，模型只是 YAML id 列表 | 中 |
| 上游列表同步 | ModelFetcher 每小时 + 正则过滤 | 无 | 中 |
| 正则映射 + 模型名还原 | xregexp + 流式 chunk 还原 | 精确匹配，无还原 | 小中 |
| usage 粒度 | 15+ 维 + EnsureUsage | SQLite 4 维按日聚合 | 小中 |
| 每请求日志 | Request+RequestExecution 双表 | 内存抓包环形缓冲（重启即失） | 中 |
| 延迟指标 | TTFT/推理时长/TPS 打点 | 无 | 小 |
| 成本 | 多定价模式 + 明细落库 | 无 | 中 |
| trace 聚合 | Trace/Thread + 时间线树 | 无 | 大（lite 版 M） |
| 协议广度 | 22 入站 × ~60 出站 | 3 协议两两互转 | XL |

## 四、可立即借鉴的快赢

模型名后缀解析（~20 行）；xhigh 哨兵；effort↔budget 集中表；简化 override（3 操作+模板+条件）；EnsureUsage 注入 include_usage；stream-converter 加 FirstToken/ReasoningStart/ReasoningEnd 三时间戳白得 TTFT；正则映射 + 模型名还原；/v1/models include 参数；可重试错误三层判定 + 429 换道；流首事件超时 + 预读判空；ErrorAware 时间衰减（~50 行内存）；TransformerMetadata sidecar；签名前缀启发式；config 每行注释标注环境变量。

## 五、战略风险（诚实评估）

- **身份危机**：llm-proxy 价值主张是 `npm i -g` 零配置；"除多租户外都要"有内在矛盾——约一半复杂度是"有状态平台地基"，砍多租户后不会变轻。务实答案是借能力不抄架构。
- **省力路径更优**：80% 实用价值来自 ~1500–2500 行 TS 子集，约全盘改造 1/5 工作量，不破坏转换层测试。
- **转换层重构沉没成本**：N=3 协议时 hub-and-spoke 不比两两直转简单，收益到 N=4 才显现 → 触发式而非默认。
- **单用户过度工程陷阱**：熔断状态机/EWMA/防扎堆/top-k 解决"并发分散到几十上游"，单用户 2-3 provider 照搬复杂度翻倍而行为零差异。
- **维护带宽不对称**：~60 种出站 channel 的 provider 怪癖是团队级资产，个人追不动，协议广度按需扩展。
- **不换技术栈**：Go 重写丢 npm/单文件 admin/TS 一致/现有用户；AxonHub 选 Go 的理由全绑多租户。
- **反向风险**：完全不动会被 AxonHub/one-api 单用户模式蚕食（它们已有 reasoning 归一 + override）→ 推理 canonical + override 是防守性必做。
