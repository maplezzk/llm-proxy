# Web-only Distribution and Dynamic Model Capabilities Implementation Plan

> **For agentic workers:** 实施前必须消费本计划与 `docs/grills/2026-07-25-web-only-dynamic-model-capabilities-grill.md`、`CONTEXT.md`、`docs/adr/0001-web-only-distribution.md`、`docs/adr/0002-model-capability-ownership.md`、`docs/adr/0003-adapter-effective-model-descriptions.md`。任务使用 `U1`–`U10` 作为可追踪单元。

**Goal:** 将 llm-proxy 收敛为 Node CLI + 浏览器 `/admin/` 的 Web-only 交付，并让 Provider 模型集中维护能力和可复用推理模板；Adapter 使用稳定的外部模型 ID、目标模型与统一推理等级，向下游动态返回有效模型能力。

**Architecture:** 顶层配置新增可复用的推理映射模板目录。Provider Model 声明模型事实（上下文窗口、最大输出、输入模态、是否支持推理、模板引用）；Adapter Model Mapping 仅声明稳定的 `sourceModelId`、目标 Provider/模型和统一推理等级。Adapter 请求在路由阶段解析为明确的低层推理策略，转发阶段只应用这个策略；Adapter 模型列表由相同的本地配置推导安全能力描述。

**Tech Stack:** Node.js 20+、TypeScript ESM、YAML、原生 `node:test` + `tsx`、Alpine.js、i18next、esbuild、GitHub Actions。

---

## 已定边界

1. 完整删除 Swift/macOS App、DMG/Homebrew/自动更新发布链、macOS 专属脚本/图片/文档/历史计划；保留 Node CLI 与浏览器 `/admin/`。
2. 不新增 Pi extension、不修改 Pi 配置、不增加 Pi 专项接口；也不向供应商调用 `/v1/models`。模型清单和能力完全从本地 Config 推导。
3. Provider Model 拥有 `contextWindow`、`maxTokens`、`input`、推理能力和推理模板引用。`contextWindow` 本次只用于下游能力描述，不增加请求 token 预校验。
4. 统一推理等级是 llm-proxy 领域枚举：`off | minimal | low | medium | high | xhigh | max`。
5. 推理模板可复用；修改模板立即影响所有引用它的 Provider Model。支持推理的模板必须提供 `medium`；不支持推理的模型仅允许 `off`。
6. Adapter Mapping 保持 `sourceModelId` 为稳定的下游契约，仅保存目标 Provider、目标模型和 `reasoningLevel`。不保存/展示 `budget_tokens`、`reasoning_effort`、`thinking.type` 或 `max_tokens`。
7. 未映射等级必须不可选且后端拒绝；禁止最近档位或任意静默降级。推理模型默认 `medium`，不支持推理的模型默认 `off`。
8. 仅扩展 `GET /{adapter}/v1/models`。每个条目新增 `capabilities`：`contextWindow`、`maxTokens`、`input`、`reasoning`、`reasoningLevel`。直连 `GET /v1/models` 保持当前 JSON shape 不变，能力响应不得泄露模板或供应商低层字段。
9. UI 继续使用 Alpine.js 和原生控件。视觉整理只涉及 Provider 模型/模板编辑和 Adapter 配置弹窗；不重做 Dashboard、日志、抓包等页面。
10. 当前原工作树已有未跟踪的 `CONTEXT.md`、`docs/adr/`、`docs/grills/`。实施应在独立 worktree 中进行；禁止 `git clean`、reset 或修改/删除这些文件。

## 迁移策略

这是有意的配置破坏性变更。旧配置的 Adapter `max_tokens` 和 raw thinking 覆盖无法在多 Adapter 指向同一 Provider Model 时无歧义地合并，因此不自动猜测迁移结果：

- YAML parser、热重载和 Admin 写入必须对旧字段给出带字段路径的迁移错误，绝不静默丢弃或默认降为 `off`/`medium`。
- 管理员迁移顺序：创建模板 → 为每个 Provider Model 填能力并绑定模板 → 将 Adapter 输出默认值迁移到对应目标 Provider Model → 每条 Adapter Mapping 选择一个统一等级 → 删除旧 raw 字段。
- 直连 `/v1/*` 没有 Adapter 的固定等级。本次保持其现有客户端协议字段的透传语义，但不再从被删除的 `Model.thinking` 获取服务端强制策略；不得凭空为直连请求选择 `medium` 或最近档位。

---

## 变更面总览

| 范围 | 主要路径 | 结果 |
| --- | --- | --- |
| macOS 产品下线 | `app/`、`scripts/mock-update-server.js`、`.github/workflows/release.yml`、`.github/workflows/release-app.yml` | Node/npm 发布链保留，Swift/DMG/Homebrew/update 链消失 |
| 配置模型 | `src/config/types.ts`、`parser.ts`、`validator.ts`、`store.ts` | 模板、能力、统一等级成为可靠的持久化模型 |
| Admin 配置 API | `src/api/handlers/{base,provider-crud,adapter-crud}.ts`、新模板 handler、`src/api/server.ts` | 完整候选配置原子校验和模板 CRUD |
| 路由/转发 | `src/proxy/{types,router,translation}.ts`、`src/adapter/router.ts` | Adapter 只使用模板解析出的策略，`off` 真正关闭推理 |
| 下游模型列表 | `src/adapter/handlers.ts`、`src/api/handlers/model-handlers.ts` | 仅 Adapter list 返回有效能力，直连 list 无回归 |
| Admin UI/i18n | `src/api/admin/components/{providers,adapters}.ts`、`src/api/admin/types.ts`、`admin-ui.html`、`src/api/admin-ui.html`、`locales/*/translation.json` | Provider 管理模板/能力；Adapter 只选择合法等级 |
| 文档/样例 | `samples/config.yaml`、`README.md`、`README.zh.md`、`DEVELOPMENT.md`、`docs/api-spec.md` | 用户可按新 schema 手工配置，且不会看到失效的原生产品入口 |
| 回归 | `test/config/**`、`test/adapter/**`、`test/proxy/**`、`test/api/**`、`test/status/**` | 覆盖迁移、配置图、转发、能力列表、Node-only 交付 |

---

## U1：实施预检、事实锁定与 worktree 保护

**Files:**
- Read-only: `CONTEXT.md`、`docs/grills/2026-07-25-web-only-dynamic-model-capabilities-grill.md`、`docs/adr/000{1,2,3}-*.md`
- Read-only: `src/config/{types,parser,validator,store}.ts`
- Read-only: `src/{proxy,adapter}/router.ts`、`src/proxy/{types,translation}.ts`
- Read-only: `src/api/handlers/{base,provider-crud,adapter-crud,model-handlers}.ts`、`src/adapter/handlers.ts`

**Steps:**
- [ ] 记录原工作树的 `git status --short`，确认未跟踪决策文件仍存在；创建 feature worktree 时不复制、暂存、删除或覆盖它们。
- [ ] 在 worktree 中确认当前字段和函数契约：`parseThinkingConfig()`、`serializeConfigToYaml()`、`validateConfig()`、`ConfigStore.writeConfig()`、`resolveAdapterRoute()`、`routeModel()`、`transformInboundRequest()`、`handleTestAdapter()`。
- [ ] 确认两个 Admin HTML 源文件均被跟踪且同步；后续每次修改必须同步二者。
- [ ] 明确 `handleTestAdapter()` 当前是直接连通性探测（不经 `forwardPipeline()`）；本计划不把它当作模板注入的自动验证。若产品要把它升级为端到端转换测试，必须另开需求，避免改变其现有响应契约。

**Acceptance:** 实施记录只引用已证实的字段/签名；未跟踪决策文件状态不变。

**Verification:**
```bash
git status --short
rg -n "parseThinkingConfig|serializeConfigToYaml|validateConfig|writeConfig|resolveAdapterRoute|transformInboundRequest|handleTestAdapter" src test
cmp -s admin-ui.html src/api/admin-ui.html
```

---

## U2：删除 macOS 原生交付与上游模型拉取功能

**Files:**
- Delete: `app/`（整个 Swift package、测试、资源与 `app/scripts/build.sh`）
- Delete: `scripts/mock-update-server.js`
- Delete: `.github/workflows/release-app.yml`
- Modify: `.github/workflows/release.yml`、`package.json`、`.gitignore`
- Modify/Delete: `src/api/handlers/model-handlers.ts`（`handlePullModels`）、`src/api/server.ts`（对应 import/route）、`src/api/handlers/index.ts`
- Modify: `src/api/admin/components/providers.ts`、`admin-ui.html`、`src/api/admin-ui.html`、相关 i18n keys
- Delete: `docs/images/macos-{cn,cn2,en,en2}.png`、macOS 专属 brainstorm/plan 文档

**Steps:**
- [ ] 删除 `build-macos` job 中 Bun、Swift build、DMG 上传和 Homebrew cask 更新；保留 `release-please`、Ubuntu Node/npm publish、OIDC npm publish 权限和当前 npm 发布命令。
- [ ] 删除 `build:app`，但保留现有 Node 的 `build`（`tsc` + Admin asset copy + esbuild）、`typecheck`、`test`、`prepublishOnly` 和 CLI `bin`。
- [ ] 删除整个 `app/` 和 mock updater，不保留原生代码的壳或替代菜单栏入口；从 `.gitignore` 移除专属 `app/.build/` 规则。
- [ ] 删除 `handlePullModels()`、`POST /admin/providers/:name/pull-models` 及 Provider 页面 `pullModal/openPullModels/importPullModels` 和相关 DOM/i18n。Provider 模型只能由管理员在 Web 表单中手动定义，以满足“绝不请求供应商 `/models`”。
- [ ] 删除 macOS 截图和仅讨论原生 App/自动更新的历史计划；保留 Web Admin 截图、`CHANGELOG.md` 历史条目和当前 ADR/grill/CONTEXT 文件。

**Acceptance:** 已跟踪实现、发布 workflow、Admin UI 和活跃文档不再含原生 App、DMG/Homebrew/update 或供应商模型拉取入口；Node CLI 与 `/admin/` 路由仍存在。

**Verification:**
```bash
test ! -d app
test ! -e scripts/mock-update-server.js
test ! -e .github/workflows/release-app.yml
node -e "const p=require('./package.json'); if ('build:app' in p.scripts) throw new Error('build:app remains')"
rg -n "pull-models|handlePullModels|openPullModels|importPullModels" src admin-ui.html
```

---

## U3：定义新配置数据模型与对称 YAML 读写

**Files:**
- Modify: `src/config/types.ts`
- Modify: `src/config/parser.ts`
- Modify: `src/config/store.ts`（如完整 Config 写回需要补充字段）
- Test: `test/config/parser.test.ts`、`test/config/store.test.ts`

**Target contract:**

```ts
type UnifiedReasoningLevel =
  | 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

interface ReasoningTemplate {
  name: string
  levels: Partial<Record<UnifiedReasoningLevel, ThinkingConfig | null>>
}

interface Model {
  id: string
  contextWindow: number
  maxTokens: number
  input: InputModality[]
  reasoning: boolean
  reasoningTemplate: string
}

interface AdapterModelMapping {
  sourceModelId: string
  provider: string
  targetModelId: string
  reasoningLevel: UnifiedReasoningLevel
}
```

`ThinkingConfig` 保留为模板内部和路由已解析策略的低层表示；不再挂在 Provider Model 或 Adapter Mapping 上。YAML 使用仓库既有 snake_case 风格：`reasoning_templates`、`context_window`、`max_tokens`、`reasoning_template`、`reasoning_level`。

**Steps:**
- [ ] 先写 parser round-trip fixture：一个模板明确包含 `off: null`、`medium`，一个推理 Provider Model 和一个 Adapter Mapping。断言 load → serialize → write → reload 不丢模板、能力、引用或 level。
- [ ] 实现 template/Model/Mapping 的 TypeScript 与 file 类型；`off: null` 表示明确关闭，缺少键表示该等级不可用，二者不可混淆。
- [ ] 删除 `AdapterConfig.max_tokens`、`Model.thinking`、`AdapterModelMapping.thinking` 的持久化模型和 serializer 投影；保留 Adapter `stream` 默认值。
- [ ] parser 必须在投影前检测遗留字段：Adapter `max_tokens`、mapping `thinking`/`reasoning_effort`、Provider Model `thinking`/`reasoning_effort`。报出字段路径和手工迁移说明，不得静默丢字段。
- [ ] 确认 `writeConfig()` 只有在验证通过后写文件、更新内存和增加版本；失败 parse/validate 不得更新现有 Config。

**Acceptance:** 新 schema 可完整 round-trip；遗留字段与缺失的新必填字段均显式失败；`off` 和“等级不存在”可区分。

**Verification:**
```bash
node --import tsx --test test/config/parser.test.ts test/config/store.test.ts
```

---

## U4：完整配置图校验与模板 Admin CRUD

**Files:**
- Modify: `src/config/validator.ts`
- Modify: `src/api/handlers/{base,provider-crud,adapter-crud}.ts`
- Create: `src/api/handlers/reasoning-template-crud.ts`
- Modify: `src/api/handlers/index.ts`、`src/api/server.ts`
- Test: `test/config/validator.test.ts`、`test/api/handlers.test.ts` 或新增专用 API 测试

**Steps:**
- [ ] 先在 `validateConfig()` 测试中覆盖完整配置图，再实现规则：模板名唯一；等级键只允许七档；每个模型能力字段合法；Provider/Model/template 引用存在；source ID 在 Adapter 内不重复；Adapter level 在目标模板中已映射。
- [ ] 校验推理关系：`reasoning: true` 的模型引用模板且模板提供 `medium`；`reasoning: false` 的模型只能对应显式 `off` 策略，Adapter 也只能选择 `off`；不能对未映射 level 自动选择相邻项。
- [ ] `contextWindow`、`maxTokens` 必须为正整数；`input` 必须非空且仅允许当前实现支持的 `text`/`image`。Anthropic 预算型模板值不得超过绑定模型 `maxTokens`；供应商协议不支持的低层 thinking 字段必须由 validator 拒绝。
- [ ] 将 Provider create/update 统一改为“复制完整 Config → 应用变更及 provider rename 引用修正 → validateConfig(candidate) → writeConfig”。禁止继续只校验孤立 Provider，以避免更新模板引用后留下失效 Adapter。
- [ ] 将 Adapter CRUD payload 收敛为 `name`、`type`、`stream`、`models[].{sourceModelId,provider,targetModelId,reasoningLevel}`；显式拒绝 legacy raw 字段，不能依赖对象解构后忽略。
- [ ] 增加 `GET/POST/PUT/DELETE /admin/reasoning-templates`。修改/删除一律在完整候选 Config 上验证；模板改名不提供隐式语义，引用中的模板不可删除，修改模板若让已存在 Adapter level 无效则原子拒绝。
- [ ] 修改 `handleGetConfig()` 与 `handleGetAdapters()` 以返回新模型能力、模板目录和 `reasoningLevel`。所有 `handleSet*` Config 写入必须以 `{ ...config, changedField }` 构造候选 Config，防止新增的 `reasoningTemplates` 被 log level、locale、port、proxy key 或 vision 设置丢失。

**Acceptance:** 手工 YAML reload 和每一个 Admin 写路径使用相同的完整配置校验；任何失败不落盘、不更新内存版本；模板低层配置只出现在管理 API，不会进入下游模型列表。

**Verification:**
```bash
node --import tsx --test test/config/validator.test.ts test/api/handlers.test.ts
npm run typecheck
```

---

## U5：路由解析、统一等级执行与模型级输出默认值

**Files:**
- Modify: `src/proxy/types.ts`、`src/proxy/router.ts`、`src/adapter/router.ts`
- Modify: `src/proxy/translation.ts`
- Test: `test/proxy/router.test.ts`、`test/adapter/router.test.ts`、`test/proxy/translation.test.ts`

**Steps:**
- [ ] 在 `RouterResult` 引入显式 Adapter policy 三态：直连请求没有 Adapter policy；Adapter `off` 是明确关闭；非 off 是解析后的 `ThinkingConfig`。不要把 `undefined` 当成 off。
- [ ] `resolveAdapterRoute()` 找到目标 Provider Model 后必须解析模板引用和 mapping `reasoningLevel`；将模型 `input`、`contextWindow`、`maxTokens` 与策略写入 route。删除 `mapping.thinking ?? model.thinking` 和 `adapter.max_tokens` 分支。
- [ ] `routeModel()`/`routeModelInProvider()` 使用 Provider Model 的 `maxTokens` 作为模型级默认输出上限；直连路由不生成虚构的统一等级。
- [ ] 将 `transformInboundRequest()` 中的 thinking 注入重构为只消费已解析 Adapter policy。Adapter 请求先清理客户端传入的 `thinking`、`reasoning_effort` 和 Responses `reasoning`，再按模板注入目标供应商字段；不得使用客户端字段或固定 `REASONING_EFFORT_TO_BUDGET` 表回退。
- [ ] 对 `off` 同样清理上述字段，且不新增 thinking block。跨协议 helper（包括 `ensureThinkingBlock()` / `ensureThinkingBlocks()`）只能在有效、启用的 Adapter policy 下补偿转换所需 block；保留多轮历史签名的既有兼容逻辑。
- [ ] `sanitizeMaxTokens()` 按上游协议注入默认输出值：Anthropic/OpenAI Chat 使用 `max_tokens`，OpenAI Responses 使用 `max_output_tokens`。仅当客户端省略或传 0 时使用 Provider Model 的 `maxTokens`；客户端明确正值按既有透传策略保留。

**Acceptance:** 相同模板被多个模型引用时新请求使用同一模板的最新值；`off` 不能被客户端字段或协议转换重新打开；未映射 level 在发起网络请求前被拒绝。

**Verification:**
```bash
node --import tsx --test test/adapter/router.test.ts test/proxy/router.test.ts test/proxy/translation.test.ts
```

必须覆盖 Anthropic budget、OpenAI Chat effort、OpenAI Responses reasoning 三个模板映射，`off` 清理，未映射等级，目标切换后的 max token 默认值，`max_output_tokens`，以及 vision input fallback 的持续可用性。

---

## U6：从 Adapter 模型列表返回有效能力

**Files:**
- Modify: `src/adapter/handlers.ts`（`handleAdapterModels()`）
- Read/Regression test: `src/api/handlers/model-handlers.ts`（`handleListModels()`）
- Test: `test/adapter/handlers.test.ts`、`test/api/integration.test.ts`

**Steps:**
- [ ] 固定 `GET /v1/models` 回归测试：每个直连条目仍只有 `id`、`object`、`created`、`owned_by`，没有 `capabilities`。
- [ ] `handleAdapterModels()` 为每个 mapping 解析本地目标 Provider Model，追加：
  ```json
  {
    "capabilities": {
      "contextWindow": 1000000,
      "maxTokens": 65536,
      "input": ["text", "image"],
      "reasoning": true,
      "reasoningLevel": "medium"
    }
  }
  ```
  值必须来自有效 Config，而不是常量。
- [ ] 固定字段语义：`reasoning` 表示目标 Provider Model 是否具备推理能力；`reasoningLevel` 表示此 Adapter 当前固定策略。列表不得包含模板名、Provider 类型、预算、`reasoning_effort`、`thinking.type`、API key 或任何上游原始字段。
- [ ] 维持现有 Adapter list 的不认证边界和 CORS 行为；不得调用 `parseAndAuth()`，更不得发起网络或供应商 `/models` 请求。失效配置必须返回明确本地配置错误，不得静默跳过 mapping。

**Acceptance:** 修改 Adapter target 或 `reasoningLevel` 后下一次列表请求立即反映当前有效能力；直连 Models API 的 shape 不变；无低层字段泄露。

**Verification:**
```bash
node --import tsx --test test/adapter/handlers.test.ts test/api/integration.test.ts
```

---

## U7：重做 Provider/模板与 Adapter 配置弹窗

**Files:**
- Modify: `src/api/admin/components/providers.ts`、`src/api/admin/components/adapters.ts`、`src/api/admin/types.ts`
- Modify in lockstep: `admin-ui.html`、`src/api/admin-ui.html`
- Modify: `locales/zh/translation.json`、`locales/en/translation.json`
- Generated: `src/types/i18n.generated.ts`（仅通过 generator）

**Steps:**
- [ ] Provider 模型行只编辑：ID、context window、model max tokens、input modalities、reasoning capability、reasoning template。删除行内 raw budget/effort/type 状态、序列化和控件。
- [ ] 在 Provider 配置弹窗内部增加模板库子面板/子弹窗：列表、新增、编辑、删除具名模板和七档映射。只有模板编辑器可以显示低层 budget/effort/type；模板引用与模型能力不一致时显示后端字段错误。
- [ ] 删除 Provider 的远程“拉取模型”按钮和模态。新增模型只允许手工添加，避免调用上游 `/models`。
- [ ] Adapter 弹窗删除 `max_tokens`、mapping raw `thinking`、`reasoning_effort`、`thinking.type`。每条 mapping 只包含 source ID、Provider、target model、`reasoningLevel`；Adapter 级 `stream` 保留。
- [ ] 根据当前 target Model 的模板计算可选 level。切换 Provider 或 target 时清空旧 target/level；推理模型默认明确设置为 `medium`，无推理模型只选 `off`。bulk import 必须生成同样的有效默认值。
- [ ] 删除两个 `save()` 中以 `filter()` 静默丢弃不完整 mapping/model 的行为；改为保留行、展示行级错误并阻止提交。请求 body 不得再包含 Adapter raw thinking/max token 字段。
- [ ] 对本次表单区域建立一致的本地 class：字段 label、输入控件、select、helper/error text、mapping row、模板层级。只改 Provider/Adapter modal，禁止重构其他页面。
- [ ] 为模板库、模型能力、统一等级、无可用等级、引用删除保护、字段校验错误添加中英文 key；运行 generator 更新类型。删除无调用的 pull-model 与 Adapter raw thinking/max token 文案。

**Acceptance:** 管理员能够手工创建模板 → 绑定模型 → 创建 Adapter；不可用等级不可提交；目标切换不残留旧等级；两份 HTML 内容一致；中英文切换没有 missing key。

**Verification:**
```bash
npm run generate:i18n-types
npm run typecheck
npm run build
cmp -s admin-ui.html src/api/admin-ui.html
```

人工浏览器 smoke：中英文各走一遍“创建模板、绑定 Provider Model、创建 Adapter、切换 target、尝试非法等级、尝试删除已引用模板”，并确认 Adapter UI 中不存在 raw budget/effort/type/max token 控件。

---

## U8：移除原生运行时专属分支并保证 Web Admin 静态交付

**Files:**
- Modify: `src/lib/sqlite-client.ts`、`src/status/usage-store.ts`、`test/status/usage-store.test.ts`
- Modify: `src/api/server.ts`
- Test: `test/api/integration.test.ts`

**Steps:**
- [ ] 删除 `isBunRuntime()` 和 `bun:sqlite` 载入分支，只保留 Node `node:sqlite` 优先、`better-sqlite3` fallback。相应地删除 Bun/编译 App 的注释和测试陈述。
- [ ] 保留 `getAdminUIHtml()`/`getAdminAppJs()` 的 CWD/`dist/api` asset fallback，但将“bun compiled binary”注释改为 Node 开发/部署时从同目录资产读取的中性说明。
- [ ] 为实际服务补充回归：`GET /admin/` 返回 HTML、`GET /admin-app.js` 返回非空 JavaScript；不得删除 Web Admin 路由、`src/api/admin/**` 或 `bin/llm-proxy.js`。

**Acceptance:** 不再有 Bun/macOS App runtime 分支；Node 20 fallback、Admin 页面和 Admin bundle 均持续可用。

**Verification:**
```bash
node --import tsx --test test/status/usage-store.test.ts test/api/integration.test.ts
npm run typecheck
npm run build
```

---

## U9：更新样例、用户文档和 API 契约

**Files:**
- Modify: `samples/config.yaml`、`README.md`、`README.zh.md`、`DEVELOPMENT.md`、`docs/api-spec.md`
- Preserve: `docs/architecture.md`、`CHANGELOG.md`、`CONTEXT.md`、`docs/adr/**`、`docs/grills/**`

**Steps:**
- [ ] 将 sample 改为可 parse/validate 的完整 schema：模板（明确 `off` 和 `medium`）、Provider Model 能力和模板引用、Adapter `reasoning_level`。示例不在 Provider/Adapter 位置保留 raw thinking 或 Adapter `max_tokens`。
- [ ] 双语 README 只保留 npm/Node CLI 安装、`llm-proxy start` 和浏览器 `/admin/`；删除 DMG/Homebrew、桌面自动更新、`build:app`、quarantine 等说明和 macOS 截图。
- [ ] DEVELOPMENT 仅描述 Node 测试、构建和 npm 发布；移除 `release-app.yml`、Swift、Bun 和 DMG release 步骤。
- [ ] API spec 描述 Adapter Models 的五个 capabilities 字段、其语义与不泄露规则；明确直连 `/v1/models` 不变。移除 `/admin/providers/{name}/pull-models`，不误删标准客户端请求协议中的 `max_tokens`/thinking 兼容文档。
- [ ] 写明破坏性手工迁移和“无静默降级”规则；不得宣称存在自动迁移器。

**Acceptance:** 样例能通过 parser/validator；活跃文档统一指向 Node CLI + Web Admin，且 API 文档不暴露模板低层实现。

**Verification:**
```bash
node --import tsx --test test/config/parser.test.ts test/config/validator.test.ts
rg -n "pull-models|build:app|LLMProxy\.dmg|Homebrew|macOS \(recommended\)" README.md README.zh.md DEVELOPMENT.md docs/api-spec.md samples/config.yaml
```

---

## U10：全量回归、构建、包内容与发布下线核对

**Steps:**
- [ ] 在 worktree 执行格式检查、针对性测试、全量测试、类型检查和 build；失败必须按 code/merge/environment/tool 分类，不能用重跑掩盖问题。
- [ ] 执行实际 dist 服务 smoke，检查 `/admin/health`、`/admin/`、`/admin-app.js`。
- [ ] 用 `npm pack --dry-run --json` 确认包含 `dist/index.js`、Admin assets、`bin/llm-proxy.js`，且没有 `app/` 或 updater。
- [ ] 在仓库外由发布负责人确认 Homebrew tap cask、`TAP_REPO_PAT` secret 和既有 Release DMG 已下线或明确标记停用；本地测试不能伪称已验证这些外部状态。
- [ ] 将最终 worktree 的 `git status --short` 与 U1 基线核对，确保原工作树中的 ADR/grill/CONTEXT 没有被改动或纳入提交。

**Verification matrix:**

| Scope | Command / observation | Pass condition |
| --- | --- | --- |
| Config/schema | `node --import tsx --test test/config/parser.test.ts test/config/store.test.ts test/config/validator.test.ts` | round-trip、legacy rejection、完整配置图均通过 |
| Routing/translation | `node --import tsx --test test/adapter/router.test.ts test/proxy/router.test.ts test/proxy/translation.test.ts` | selected template、off、3 协议和 output default 均通过 |
| API | `node --import tsx --test test/adapter/handlers.test.ts test/api/handlers.test.ts test/api/integration.test.ts` | capabilities/no leak/direct list/no pull-models 均通过 |
| Node regression | `node --import tsx --test test/status/usage-store.test.ts` | Node SQLite fallback 没有回归 |
| Full suite/type/build | `npm run typecheck && npm test && npm run build` | 所有命令退出码为 0 |
| Package | `npm pack --dry-run --json` | Node CLI/Admin assets 存在，无原生 App/updater |
| Admin smoke | 临时 HOME + `node dist/index.js start` + `curl` | `/admin/health`、`/admin/`、`/admin-app.js` 都成功 |

Suggested smoke command:

```bash
tmp=$(mktemp -d)
HOME="$tmp/home" node dist/index.js start --config "$tmp/config.yaml" --port 19876 >"$tmp/server.log" 2>&1 &
pid=$!
cleanup() { kill -TERM "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; rm -rf "$tmp"; }
trap cleanup EXIT
for n in {1..50}; do curl -fsS http://127.0.0.1:19876/admin/health >"$tmp/health.json" && break; sleep 0.1; done
grep -q '"success":true' "$tmp/health.json"
curl -fsS http://127.0.0.1:19876/admin/ | grep -q '<title>llm-proxy</title>'
curl -fsS http://127.0.0.1:19876/admin-app.js | grep -q .
```

## Out of scope

- Pi extension、Pi `models.json`、Pi reload/discovery 行为。
- 上游供应商 `/models` 拉取、轮询或任何缓存。
- 基于 `contextWindow` 的请求 token 预校验、自动截断或压缩。
- 多个 Adapter alias（例如“快速版/深度版”）或一个 stable ID 下的运行时 level 选择。
- Dashboard、日志、抓包、捕获页或其他 Admin 页面整体视觉重构。
- 自动迁移历史 YAML、外部 Homebrew/Release/secret 的自动删除。
