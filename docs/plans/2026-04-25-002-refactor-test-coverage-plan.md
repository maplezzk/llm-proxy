---
title: refactor: 补充单元测试覆盖
type: refactor
status: active
date: 2026-04-25
---

# 补充单元测试覆盖

## Overview

当前项目 37 个测试覆盖 parser/validator/store/translation/router 等核心逻辑，但 SSE 流式转换、StatusTracker、CLI 行为等模块尚无测试。补充缺失覆盖，确保关键路径有测试保护。

## Problem Frame

当前缺测试的模块中有生产代码经过端到端验证（stream-converter、provider 转发），但无单元测试。后续修改这些模块时缺乏回归保护。

## Requirements Trace

- 新增 stream-converter 测试（覆盖 Anthropic↔OpenAI SSE 双向转换）
- 新增 StatusTracker 测试（覆盖滑动窗口统计逻辑）
- 增强 CLI 命令测试（覆盖更多模块加载和边界情况）
- 增强现有测试边界覆盖

## Scope Boundaries
- 不改动生产代码，仅新增/修改测试文件
- 不引入新依赖

## Implementation Units

- [ ] **Unit 1: StatusTracker 单元测试**

**Files:**
- Create: `test/status/tracker.test.ts`

**Approach:** 独立测试滑动窗口统计逻辑

**Test scenarios:**
- [Happy path] 记录请求后查询返回正确统计
- [Happy path] 可用性阈值正确
- [Edge case] 无请求数据返回默认值
- [Edge case] 滑动窗口过期后数据清除
- [Edge case] 失败请求正确影响 errorRate

**Verification:** 5 个测试通过

- [ ] **Unit 2: 流式 SSE 转换器测试**

**Files:**
- Create: `test/proxy/stream-converter.test.ts`

**Approach:** 使用可控的 ReadableStream 模拟上游 SSE 事件流，验证转换后的输出

**Test scenarios:**
- [Happy path] Anthropic text_delta → OpenAI delta.content
- [Happy path] Anthropic input_json_delta → OpenAI tool_calls arguments
- [Happy path] Anthropic message_stop → OpenAI [DONE]
- [Happy path] OpenAI role 事件 → Anthropic message_start + content_block_start
- [Happy path] OpenAI content delta → Anthropic text_delta
- [Happy path] OpenAI tool_calls → Anthropic input_json_delta
- [Happy path] OpenAI [DONE] → Anthropic message_stop

**Verification:** 7 个测试通过

- [ ] **Unit 3: CLI 命令测试增强**

**Files:**
- Modify: `test/cli/commands.test.ts`

**Approach:** 增加对命令模块中 helper 函数的覆盖

**Test scenarios:**
- [Happy path] 模块导出所有必要命令
- [Edge case] 命令函数签名正确（参数接口）

**Verification:** 2+ 测试通过

- [ ] **Unit 4: 现有测试补充边界覆盖**

**Files:**
- Modify: `test/config/validator.test.ts`

**Approach:** 补充缺失的边界场景

**Test scenarios:**
- [Edge case] 空 providers 数组
- [Edge case] Model 名不合法
- [Edge case] Model 对象缺失 model 字段

**Verification:** 新增 3+ 测试通过
