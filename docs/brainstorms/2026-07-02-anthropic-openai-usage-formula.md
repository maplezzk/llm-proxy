# Anthropic / OpenAI 用量字段语义对比 & llm-proxy 归一化口径

> 调研目的：统一 llm-proxy 内 `daily_aggregates.input_tokens` 等字段的语义，消除"同字段在不同上游协议下含义不一致"导致的统计错乱（典型现象：缓存命中率 > 100%）。

## 1. 三种协议原生 usage 字段语义

| 协议 | 字段 | 含义 | 总输入怎么算 |
|---|---|---|---|
| **Anthropic Messages API** | `input_tokens` | **计费输入**（不含缓存命中、缓存创建） | `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` |
| | `cache_read_input_tokens` | 命中已存在缓存的 token | — |
| | `cache_creation_input_tokens` | 写入新缓存的 token（按 input 计费） | — |
| | `output_tokens` | 输出 token | — |
| **OpenAI Chat Completions API** | `prompt_tokens` | **总输入**（含缓存命中） | `prompt_tokens` |
| | `completion_tokens` | 输出 token | — |
| | `prompt_tokens_details.cached_tokens` | 缓存命中（独立字段） | — |
| **OpenAI Responses API** | `input_tokens` | **计费输入**（不含缓存命中） | `input_tokens + input_tokens_details.cached_tokens` |
| | `output_tokens` | 输出 token | — |
| | `input_tokens_details.cached_tokens` | 缓存命中 | — |

> **关键陷阱**：OpenAI Chat 的 `prompt_tokens` 与 OpenAI Responses / Anthropic 的 `input_tokens` **含义完全不同**——前者含缓存命中，后两者只是计费部分。llm-proxy 必须做语义转换才能跨协议对比。

## 2. OpenAI 兼容上游字段变种（实战常见）

| 类型 | 返回字段 | 实际语义 | 例子 |
|---|---|---|---|
| 标准 OpenAI Chat | `prompt_tokens` / `completion_tokens` / `prompt_tokens_details.cached_tokens` | 总输入含缓存 | 标准 OpenAI、Azure OpenAI |
| OpenAI Responses 风格 | `input_tokens` / `output_tokens` / `input_tokens_details.cached_tokens` | 计费输入 | 部分新上游 |
| Anthropic 风格（伪装成 OpenAI 协议） | `input_tokens` / `output_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens` | 计费输入 | 某些 OpenAI-compat 网关 |
| **字段含义错乱** | `input_tokens` 字段实际填的是「上下文窗口剩余 token」或「累计配额」 | 不可信 | 部分早期/实验性 API |

> **第 4 类的极端案例**：实测库中 `cache_read_input_tokens` 集中在 80K~265K 区间，且同一 provider 内 `cache_read` 与单次请求 `input_tokens` 无关，明显不是真正的缓存命中。**该字段不可直接信上游返回值**。

## 3. llm-proxy 设计意图（最终口径）

`daily_aggregates` / `usage_events` 表 5 个数值字段：

| 字段 | 语义 | 写入期望 |
|---|---|---|
| `input_tokens` | **计费输入**（不含缓存命中/创建） | 永远 = 计费部分 |
| `output_tokens` | 输出 token | 同 |
| `cache_read_input_tokens` | 缓存命中读取 | 同 |
| `cache_creation_input_tokens` | 缓存创建 | 同 |
| `request_count` | 请求数 | 同 |

### Dashboard 命中率公式（最终）

```
hit_rate = cache_read_input_tokens
         / (input_tokens + output_tokens + cache_creation_input_tokens + cache_read_input_tokens)
```

分子分母都按 SQL SUM 累加后做浮点除法（`* 1.0` 防整数精度丢失）。

> 用户明确口径：四个 token 字段**互相独立**，`input_tokens` 不预先包含 cache_* —— 这是与 OpenAI Chat `prompt_tokens` 语义的关键区别。

## 4. 当前代码的归一化路径与实际行为

### 4.1 三处「归一化」逻辑（`src/proxy/provider.ts`）

| 位置 | 上游 | 触发条件 | 公式 | DB 存的是什么 |
|---|---|---|---|---|
| line 236（非流式响应） | `req.upstreamType === 'anthropic'` | `inputTokens += cacheRead + cacheCreate` | **总输入** |
| line 364（流式转换后） | `req.upstreamType === 'anthropic'` | `inputTokens += cacheRead + cacheCreate` | **总输入** |
| line 394（透传流） | `req.upstreamType === 'anthropic'` | `inputTokens += cacheRead + cacheCreate` | **总输入** |

### 4.2 各路径实际存储结果

| 上游协议 | 响应路径 | 拿到的 `input` 语义 | 走归一化？ | DB 里 `input_tokens` 实际是 |
|---|---|---|---|---|
| **Anthropic** 非流式 | `parsed.usage.input_tokens` | 计费部分 | ✅ 是 | **总输入**（与设计意图矛盾）|
| **Anthropic** 流式 | `convertAnthropicStreamToOpenAI/Responses` 返回 | 计费部分 | ✅ 是 | **总输入** |
| **Anthropic** 透传流 | `forwardPassthroughStream` | 计费部分 | ✅ 是 | **总输入** |
| **OpenAI Chat** 非流式 | `usage.input_tokens ?? usage.prompt_tokens` | 看上游字段 | ❌ 否 | 看上游 |
| **OpenAI Chat** → Anthropic 流式 | `convertOpenAIStreamToAnthropic` 返回 | `prompt_tokens - cached_tokens`（已转换） | ❌ 否 | **计费部分** ✓ |
| **OpenAI Chat** → OpenAI 流式 | `convertAnthropicStreamToOpenAI` 不适用；`forwardPassthroughStream` | 看上游 | ❌ 否 | 看上游 |
| **OpenAI Responses** 流式 | `convertOpenAIResponsesStreamToAnthropic` 返回 | 计费部分（Responses `input_tokens` 语义） | ❌ 否 | **计费部分** ✓ |
| **OpenAI-compat**（anthropic 风格字段） | 同上 | 计费部分 | ❌ 否 | **计费部分** ✓ |

### 4.3 当前问题

**anthropic 上游的 3 条路径都被错误归一化为「总输入」**——与设计意图"DB 里 `input_tokens` = 计费部分"相反。

后果：

1. **统计错位**：anthropic 上游的 `cache_read` 是 `input_tokens`（已含 cache_read）的子集，按用户最终公式算命中率时分母虚大，命中率偏低
2. **跨协议对比失真**：anthropic 路径的 `input` 是「总输入」、其他路径是「计费部分」，两者不能直接相加或对比
3. **缓存命中率看似正常其实有偏差**：当 anthropic 上游命中率高时，分母里 cache_read 重复出现，分子分母同时偏大

## 5. 修复方案

### 5.1 统一归一化目标

```
DB 里 input_tokens 永远 = 计费部分
                        = 总输入 - cache_read - cache_create
```

### 5.2 各上游的转换公式

| 上游 | 来源字段 | 转换公式 |
|---|---|---|
| Anthropic Messages API | `usage.input_tokens` | 直接用（已经是计费） |
| OpenAI Chat 标准 | `usage.prompt_tokens` + `usage.prompt_tokens_details.cached_tokens` | `prompt_tokens - cached_tokens` |
| OpenAI Chat compat（anthropic 风格字段） | `usage.input_tokens` | 直接用（已经是计费） |
| OpenAI Responses | `usage.input_tokens` | 直接用（已经是计费） |
| OpenAI Responses compat（带 `input_tokens_details.cached_tokens`） | 同上 | 同上 |

### 5.3 provider.ts 改造方案

**删除** 3 处 `if (req.upstreamType === 'anthropic') { inputTokens += cacheRead + cacheCreate }`。

**新增** OpenAI Chat 标准协议的归一化：

```ts
if (req.upstreamType === 'openai') {
  // 标准 OpenAI Chat: prompt_tokens 含缓存命中，需减去才是计费部分
  if (usage.prompt_tokens != null && (cacheRead ?? 0) > 0) {
    inputTokens = Math.max(0, inputTokens - (cacheRead ?? 0))
  }
}
```

**容错**：若上游是字段错乱的兼容 API（OpenAI 风格字段填了 anthropic 风格语义），`input_tokens` 数值看起来会异常大或负数，配合现有「clamp cacheRead ≤ inputTokens」防御一起做。

### 5.4 测试覆盖补全

`test/proxy/usage-recording.test.ts` 现状：

- ✅ Anthropic 非流式：归一化断言（但**断言方向错了**——期望的是「总输入」，应改为「计费部分」）
- ✅ OpenAI 非流式：直接写入（mock 用 anthropic 风格字段，覆盖不到标准 prompt_tokens 场景）

**需补的测试用例**：

1. OpenAI Chat 标准 `prompt_tokens=1000, cached_tokens=800` → DB `input_tokens=200`（计费）
2. Anthropic 非流式 → DB `input_tokens=22`（计费部分，原值不改）
3. 流式转换后（Anthropic 上游 / OpenAI 上游）的归一化结果
4. 透传流的归一化结果
5. `cacheRead > input` 的脏数据防御 clamp

## 6. 临时应对（修代码前的现状）

如果仅想先看正确数据，可手工 SQL：

```sql
-- 查某天「计费输入」/「缓存命中」分布
SELECT date,
       SUM(input_tokens)                         AS billable_input,
       SUM(cache_read_input_tokens)              AS cache_read,
       SUM(cache_creation_input_tokens)          AS cache_create,
       SUM(output_tokens)                        AS output,
       ROUND(100.0 * SUM(cache_read_input_tokens) * 1.0
             / NULLIF(SUM(input_tokens + output_tokens + cache_read_input_tokens + cache_creation_input_tokens), 0), 1)
                                                  AS hit_rate_pct
FROM daily_aggregates
WHERE date = 'YYYY-MM-DD'
GROUP BY date;
```

> 注意：因 anthropic 路径当前被错误归一化，**该 SQL 在 anthropic 上游事件上分母会虚大**，需结合 `provider` 字段过滤或等待代码修复。

## 7. 关键代码引用

| 文件 | 行号 | 说明 |
|---|---|---|
| `src/proxy/provider.ts` | 236 | 非流式 anthropic 归一化（**待删**）|
| `src/proxy/provider.ts` | 364 | 流式转换后 anthropic 归一化（**待删**）|
| `src/proxy/provider.ts` | 394 | 透传流 anthropic 归一化（**待删**）|
| `src/proxy/stream-converter.ts` | 168-187 | 流式转换中 OpenAI usage → Anthropic usage（`ai + cr`）|
| `src/proxy/stream-converter.ts` | 271-281 | `buildAnthropicUsage`：OpenAI Chat → Anthropic 视角（`promptTokens - cachedTokens`）|
| `src/api/admin/components/dashboard.ts` | 248-254 | Dashboard 命中率公式（已按用户最终口径修）|
| `test/proxy/usage-recording.test.ts` | 57-134 | 现有归一化测试（**断言方向需改**）|

## 8. 决策记录

- **2026-07-02**：用户明确口径——`input_tokens` = 计费部分，命中率分母用四字段之和
- **2026-07-02**：dashboard 公式已按用户口径修复（commit `08d1efd`）
- **2026-07-02**：provider.ts 三处 anthropic 归一化 + OpenAI Chat 路径归一化 **待实施**