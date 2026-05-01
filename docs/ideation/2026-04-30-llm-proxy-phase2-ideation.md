---
date: 2026-04-30
topic: llm-proxy-phase2
focus: open-ended (Responses API 上线后的优化方向)
mode: repo-grounded
---

# Ideation: llm-proxy Phase 2 优化方向

## Grounding Context

**项目状态**: ~5500 行 TypeScript，Node.js >= 20，零外部运行时依赖。核心代理逻辑：translation.ts (937L)、stream-converter.ts (1140L)、provider.ts (251L)、handlers.ts (144L)。3 协议（Anthropic Messages、OpenAI Chat Completions、OpenAI Responses），12 个转换器（6 流式 + 6 非流式）。

**已知痛点**: 巨型转换器文件、handler 与 adapter handler 代码重复、无 Body 大小限制、正则路由排序脆弱、无速率限制/超时、流式 SSE hang 无断路器、Token 统计仅内存、无指标导出、配置重载非原子读、thinking block 生命周期是 #1 错误源。

**外部调研**: Web 不可用，仅内部知识。

## Ranked Ideas

### 1. Protocol Canonical IR — 协议矩阵 N×M → 2N
**Description:** 定义规范中间表示（IR），统一消息、流式事件、工具调用、思考内容的格式。每个协议 1 入站解析器 + 1 出站序列化器。12 个转换器缩减为 6。字段映射只维护一次。
**Rationale:** 当前 converter 数量 O(N²) 增长，重复映射散落各处。IR 降为 O(N) 且 Anthropic content_block index 约定机器强制。
**Downsides:** IR 设计需覆盖三协议并集，初期成本高。
**Confidence:** 90%
**Complexity:** High
**Status:** Unexplored

### 2. Unified Request Pipeline + Pluggable Middleware
**Description:** 合并 proxy/handlers.ts 和 adapter/handlers.ts 中 85% 重复逻辑为统一 pipeline。叠加可组合中间件链：bodySizeLimit → auth → rateLimit → timeout → transform → capture → forward。
**Rationale:** 两个 handler 文件互为复制品。任何横切功能（限流、超时、压缩）当前需双份改动。
**Downsides:** 中间件链增加一层抽象。
**Confidence:** 95%
**Complexity:** Medium
**Status:** Explored

### 3. Production Traffic Shaping — 流量整形
**Description:** 按 Provider 维度：令牌桶限流、断路器、请求超时（AbortSignal）、流式超时（N 秒无 token 断连）。
**Rationale:** 无保护时一个上游异常挂起所有 SSE 连接。本地工具和生产级基础设施的分水岭。
**Downsides:** 断路器参数需经验调优。
**Confidence:** 85%
**Complexity:** Medium
**Status:** Unexplored

### 4. Reusable SSE Stream Parser — 可复用流解析器
**Description:** 抽取 6 个转换器中重复的 SSE 帧解析为 async generator：`parseSSEEvents(reader) → AsyncGenerator<SSEEvent>`。转换器变为纯消费者。
**Rationale:** 180 行重复样板代码。buffer 分割 bug 需 6 处修复。测试可直接注入类型化事件。
**Downsides:** Async generator 微小性能开销。
**Confidence:** 90%
**Complexity:** Low
**Status:** Unexplored

### 5. Streaming Test Harness — 流式测试组合拳
**Description:** (a) 实时流量录制为 fixture，(b) 语义往返测试（A→B→A）+ 属性化模糊测试，(c) CI 回归套件。
**Rationale:** 当前测试密度 ~25%，无往返测试。thinking block 生命周期 bug 自动捕获。
**Downsides:** 属性化生成器设计复杂；fixture 可能随 API 变更过期。
**Confidence:** 80%
**Complexity:** Medium
**Status:** Unexplored

### 6. Per-Event Capture for Live Stream Debugging
**Description:** 逐事件增量记录替代流完成后整 blob 记录。微秒时间戳 + SSE debug 端点推送。
**Rationale:** 挂起的流永不会有 capture 数据。#1 错误源的直接调试障碍。
**Downsides:** 增量推送增加 SSE 连接数和内存。
**Confidence:** 85%
**Complexity:** Low
**Status:** Unexplored

### 7. Config Quality of Life
**Description:** (a) fs.watch 自动热加载，(b) structuredClone 防并发读脏，(c) readBody 1MB 上限。约 50 行。
**Rationale:** 零摩擦配置变更基本体验。readBody 无上限是最高杠杆 DoS 防护。
**Downsides:** fs.watch 在 NFS/Docker bind mount 可能不可靠。
**Confidence:** 95%
**Complexity:** Low
**Status:** Unexplored

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | Schema/Codegen 生成转换器 | 被 IR 吸收 |
| 2 | 转换器状态机形式化 | 被 SSE 解析器吸收 |
| 3 | 可插拔协议对注册表 | 被 IR 吸收 |
| 4 | Rust 热路径 (napi-rs) | 本地代理过早优化 |
| 5 | 分布式 Mesh | 单人工具不合规模 |
| 6 | 零配置自动发现 | 高投入低回报 |
| 7 | 模型委派路由 | 元 LLM 增加延迟 |
| 8 | 有状态会话代理 | 无状态是正确默认 |
| 9 | 无界面模式 | Alpine.js 够用 |
| 10 | SDK 化依赖 | 牺牲零依赖设计 |
| 11 | 边缘转换 | 架构变动收益不明 |
| 12 | ECS 事件处理 | SSE 解析器更简单 |
| 13 | 渐进式 Token 释放 | 本地延迟可忽略 |
| 14 | 能力协商握手 | Provider 能力是静态的 |
| 15 | Schema 校验层 | IR 副作用 |
| 16 | 转换缓存 | 过早; 先 profiling |
| 17 | 上游协议桥接 | IR 更干净 |
| 18 | 会话级 sidecar | 单人场景过度设计 |
| 19 | URL Trie 路由 | 当前路由数够用 |
| 20 | Protocol DSL 代码生成 | 3 协议不需要此基础设施 |
