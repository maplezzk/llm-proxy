# Generic Browser-Managed Reasoning Mappings Implementation Plan

> **For agentic workers:** 实施前必须消费本计划、`CONTEXT.md`、现有 Web-only 动态模型能力计划及其 ADR；任务使用 `G1`–`G5` 作为可追踪单元。

**Goal:** 将推理映射从固定的 `budget_tokens`/`reasoning_effort`/`type` 字段升级为浏览器可维护的通用参数集合，并由运行时自动清理冲突字段后应用当前统一推理等级。

**Architecture:** 每个推理模板等级保存一个 `set` JSON object 或显式 `null`。模板不再要求管理员维护 `clear`；运行时清理现有通用推理别名及模板所有等级中出现的顶层键，再以完整顶层键替换当前等级的 `set`。YAML 仍是服务端持久化格式，Admin API 是唯一面向用户的编辑入口；新增的上游参数可直接在浏览器中配置。全新上游协议仍必须由代码实现协议转换。

**Tech Stack:** Node.js 20+、TypeScript ESM、YAML、原生 `node:test` + `tsx`、Alpine.js、i18next。

---

## 已定边界

1. 模板等级的用户可编辑结构为 `{ set: Record<string, JsonValue> } | null`；不在普通 UI 暴露 `clear`。
2. `set` 只允许修改推理参数的顶层键；禁止覆盖 `model`、`messages`、`input`、`stream`、`tools`、`system`、`instructions`、`max_tokens`、`max_output_tokens` 等请求主体字段。
3. Adapter policy 仍由 Provider Model 的模板和 Adapter 的 `reasoningLevel` 共同解析；`off` 必须清理推理字段且不能被客户端请求重新打开。
4. 当前旧模板中的直接字段 `{ budget_tokens, reasoning_effort, type }` 做机械兼容读取并在下一次写入时规范化为 `{ set: ... }`，不丢失已有配置。
5. YAML 作为内部配置文件保留；用户通过独立 Admin「推理映射」页面维护，不要求手动编辑 YAML。
6. 新增独立推理映射页面；Provider 模型页面只选择模板，Adapter 页面只选择统一等级。

---

## G1：配置模型、解析与校验

**Files:**
- Modify: `src/config/types.ts`
- Modify: `src/config/parser.ts`
- Modify: `src/config/validator.ts`
- Modify: `test/config/parser.test.ts`
- Modify: `test/config/validator.test.ts`
- Modify: `samples/config.yaml`

**Steps:**
- [ ] 将 `ThinkingConfig` 替换为通用 `JsonValue`/`JsonObject` 和 `ReasoningLevelMapping { set: JsonObject }`；`ReasoningTemplate.levels` 改为 `ReasoningLevelMapping | null`。
- [ ] YAML parser 同时读取新格式 `levels.medium.set` 和旧格式 `levels.medium.reasoning_effort`/`budget_tokens`/`type`；旧格式统一归一化为 `set`，serializer 始终写新格式。
- [ ] validator 校验 set 是可序列化的普通 JSON object，拒绝 undefined、循环结构和受保护请求主体键；递归拒绝 `model/messages/input/stream/tools/system/instructions/max_tokens/max_output_tokens` 作为任意嵌套根请求覆盖。
- [ ] 保留等级存在性、`off: null`、推理模型必须有 medium、非推理模型只能 off、Adapter 只能选择已映射等级等既有规则。
- [ ] 修改 parser/validator 测试，覆盖新格式、旧格式兼容、危险键拒绝、未知供应商参数保留、off 与缺失等级区别，并把 sample 改为新格式。

**Acceptance:** 新模板可 round-trip；旧模板可读且写回后规范化；浏览器配置的新参数不因固定 TypeScript 字段丢失；危险请求字段无法进入模板。

**Verification:**
```bash
node --import tsx --test test/config/parser.test.ts test/config/validator.test.ts
```

---

## G2：运行时通用 policy 与自动清理

**Files:**
- Modify: `src/proxy/types.ts`
- Modify: `src/adapter/router.ts`
- Modify: `src/proxy/translation.ts`
- Modify: `test/adapter/router.test.ts`
- Modify: `test/proxy/translation.test.ts`

**Steps:**
- [ ] 将 Adapter policy 从 `thinking: ThinkingConfig` 改为内部 `set: JsonObject`、派生 `clearKeys` 和是否需要 Anthropic thinking block 的运行时信息；不把 clearKeys 暴露给 Admin。
- [ ] 在 `resolveAdapterRoute()` 中收集内置别名 `thinking`、`reasoning_effort`、`reasoning` 以及模板所有等级 set 的顶层键，生成 clearKeys；当前等级为 off 时 set 为空。
- [ ] 在同协议和跨协议转换前清理 clearKeys；转换完成后对 upstream body 删除 clearKeys，再以完整顶层键 `Object.assign` 当前等级 set。禁止客户端值覆盖 Adapter 策略。
- [ ] 将 Anthropic thinking block 补偿限制为当前 set 明确包含 `thinking` 的模板，避免新供应商字段被错误注入 Anthropic 专有内容块；保留现有签名/多轮兼容逻辑。
- [ ] 添加未知字段覆盖、off 清理、新字段自动收集、OpenAI/Responses/Anthropic set 注入和 max token 不受模板影响的测试。

**Acceptance:** 浏览器新增任意合法推理字段后下一次 Adapter 请求即可使用；客户端携带旧/新推理字段不能覆盖 Adapter；off 可靠关闭；跨协议仍按最终上游 body 应用映射。

**Verification:**
```bash
node --import tsx --test test/adapter/router.test.ts test/proxy/translation.test.ts
```

---

## G3：Admin API 与独立推理映射页面

**Files:**
- Modify: `src/api/handlers/reasoning-template-crud.ts`
- Modify: `src/api/handlers/base.ts`
- Modify: `src/api/admin/app.ts`
- Create/Modify: `src/api/admin/components/reasoning-mappings.ts`
- Modify: `src/api/admin/components/providers.ts`
- Modify: `src/api/admin/components/adapters.ts`
- Modify: `src/api/admin/types.ts`
- Modify in lockstep: `admin-ui.html`、`src/api/admin-ui.html`
- Modify: `locales/zh/translation.json`、`locales/en/translation.json`
- Generated: `src/types/i18n.generated.ts`
- Test: `test/api/handlers.test.ts`、`test/api/integration.test.ts`

**Steps:**
- [ ] 扩展模板 GET 返回模板、等级、引用的 Provider/Model 列表；创建/更新接受通用 set JSON；后端完整候选 Config 校验和原子写入；被引用模板删除/非法更新继续拒绝。
- [ ] 新增 Alpine `reasoningMappingsPage` 和侧边栏入口 `#reasoning-mappings`，提供模板列表、复制、新增、编辑、删除、引用影响展示。
- [ ] 模板编辑器为每个统一等级提供启用开关和 JSON object 编辑区；`off` 使用 null；JSON 解析失败、危险键、缺 medium 等显示字段错误，不静默过滤。
- [ ] Provider 模型编辑只保留模板选择；Adapter 只读取当前模板可用等级。删除 Provider 弹窗中的重复模板维护 UI，避免两处编辑逻辑不一致。
- [ ] 保持两份 Admin HTML 同步，新增中英文文案和 generated i18n 类型；构建时同步根目录和 dist Admin bundle。
- [ ] 增加 API 测试：未知 set 字段 round-trip、引用列表、删除保护、危险键 400、完整配置失败不落盘。

**Acceptance:** 用户无需编辑 YAML 即可创建供应商新参数模板、复制模板、查看引用、修改并立即影响 Adapter；Provider/Adapter 页面职责清晰；浏览器页面无 Alpine undefined expression。

**Verification:**
```bash
npm run generate:i18n-types
node --import tsx --test test/api/handlers.test.ts test/api/integration.test.ts
npm run typecheck
npm run build
cmp -s admin-ui.html src/api/admin-ui.html
```

---

## G4：端到端和发布文档

**Files:**
- Modify: `README.md`、`README.zh.md`、`docs/api-spec.md`、`DEVELOPMENT.md`
- Modify: `test/api/integration.test.ts`

**Steps:**
- [ ] 更新文档说明浏览器推理映射管理、通用 set 参数、保护字段、旧模板兼容和全新协议仍需代码支持；不要求用户编辑 YAML。
- [ ] 增加静态 Admin bundle 回归断言，确保根目录实际服务的 bundle 包含推理映射页面和 Adapter 动态等级方法。
- [ ] 使用临时配置执行浏览器 E2E：创建未知参数模板、绑定 Provider、创建 Adapter、验证 `/adapter/v1/models` 不泄露模板内部字段、切换目标模型和等级、编辑模板后验证下一次映射生效、删除保护、中英文和 Console/Network。

**Acceptance:** 浏览器完整走通“新增映射 → 绑定模型 → Adapter 使用 → 修改映射 → 请求能力变化”的闭环。

---

## G5：回归验证与交接

```bash
node --import tsx --test test/config/parser.test.ts test/config/validator.test.ts test/adapter/router.test.ts test/proxy/translation.test.ts test/api/handlers.test.ts test/api/integration.test.ts
npm run typecheck
npm test
npm run build
npm pack --dry-run --json
```

保留当前分支已有 Web-only/动态能力改动；不修改 `.pi/**`、`CONTEXT.md`、`docs/adr/**`、`docs/grills/**` 或已有实施计划。浏览器验收失败必须记录实际 console/network 证据，不能用 HTTP 单测替代。
