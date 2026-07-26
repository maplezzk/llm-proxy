# Web-only 与动态模型能力配置 — Grill

- **状态**：completed
- **创建日期**：2026-07-25
- **项目根目录**：`/Users/mutallip/Desktop/project/agents/llm-proxy`
- **范围**：
  1. 移除 macOS 原生应用，仅保留 Web 管理界面。
  2. 在 Provider 模型配置集中维护模型能力与推理映射模板；Adapter 仅选择目标模型和统一推理等级，由 llm-proxy 解析为上游参数。
  3. Pi 作为普通客户端仅传递稳定模型 ID；不交付 Pi extension，也不管理 Pi 配置。llm-proxy 独立扩展 Adapter 的下游模型列表，动态返回当前有效模型能力，供任意下游自行消费。
- **启动方式**：用户明确指定三个风险点，先依次核实它们的产品边界、兼容性和迁移语义，再形成可实施的设计计划。

## 当前待确认项

- 无。所有触及分支已确认。

## 代码事实与证据

- `app/` 是完整的 macOS Swift Package：包含原生源码、测试、图标资源和 `app/scripts/build.sh`；`package.json` 的 `build:app` 直接调用该脚本。
- `.github/workflows/release.yml` 含 `build-macos` job，`.github/workflows/release-app.yml` 也会构建 DMG、上传 GitHub Release 并更新 Homebrew tap；两者均依赖 `app/`。
- `README.md`、`README.zh.md`、`DEVELOPMENT.md`、`docs/images/macos-*` 和 `scripts/mock-update-server.js` 都有 macOS App 的发布、安装、截图或更新说明。证据：`package.json`、两份 workflow、上述文档与文件。
- Web 管理端已经是独立的 Alpine.js SPA：`GET /admin/` 返回 HTML，`GET /admin-app.js` 返回构建产物；不会依赖 macOS App。证据：`src/api/server.ts`、`src/api/admin/`。
- Provider 模型当前仅持久化 `id`、上游转发所需的 `thinking`（budget/reasoning/type）及 `input`；Provider CRUD 和 Web 表单已支持它们。证据：`src/config/types.ts`、`src/config/parser.ts`、`src/config/validator.ts`、`src/api/admin/components/providers.ts`。
- 当前 `GET /v1/models` 与 `GET /{adapter}/v1/models` 只返回 OpenAI 风格的 `id/object/created/owned_by`，没有 Pi 所需的 `reasoning`、`contextWindow`、`maxTokens` 或 `thinkingLevelMap`。证据：`src/api/handlers/model-handlers.ts`、`src/adapter/handlers.ts`。
- 当前模型路由既支持直接 Provider，也支持 Adapter 映射；能力描述若只挂在 Provider 模型上，Adapter 列表需要定义如何继承/覆盖它。证据：`src/proxy/router.ts`、`src/adapter/router.ts`。
- 已核实本机 Pi 官方文档：Pi 不会把 OpenAI `GET /v1/models` 自动转为完整模型配置；要在启动时动态发现模型，需由异步 Pi extension 拉取远端数据后 `pi.registerProvider(..., { models })`。该 extension 可在 `~/.pi/agent/extensions/` 自动发现。证据：`/Users/mutallip/.nvm/versions/node/v24.5.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/custom-provider.md`（动态发现）与 `docs/extensions.md`（异步 factory）。

## 分支追问记录

### 分支 A：Web-only 产品边界

- **状态**：已定
- **边界说明**：删除 macOS App 不只是 `app/` 源码；现有构建命令、DMG/Homebrew 发布工作流、更新脚本和面向用户的安装文档都以它为前提。Web Admin 与 Node CLI 可以独立保留。
- **推荐答案**：做一次完整的产品下线：删除 `app/`、专属构建/测试/资源、DMG/Homebrew 发布逻辑、专属更新脚本及用户文档/截图；保留 Git 历史作为追溯，不在仓库保留已失效的原生 App 计划。
- **问题 A1（删除范围）**：是否确认按上述“完整下线”执行，包括删除历史 macOS 需求/计划文档和 `docs/images/macos-*`，而不是仅停止发布？
- **推荐理由**：仅停发 DMG 会留下不可构建的脚本、误导性的安装入口和长期维护负担；Git 历史足以保留过去决策。
- **用户回答**：可以直接删除。
- **结论**：完整删除 macOS App 的源码、构建/发布链路、专属脚本、用户文档/截图及历史 macOS 计划文档。
- **问题 A2（Web-only 使用路径）**：下线后，是否接受用户通过现有 CLI 启动服务（`llm-proxy start`），再浏览器访问 `/admin/`；不额外提供桌面启动器或系统菜单栏入口？
- **推荐理由**：这与“只保留 Web 管理页面”一致，能保持发布物为 Node CLI + Web UI，避免以另一种形式重建原生桌面依赖。
- **用户回答**：是的。
- **结论**：Web-only 的唯一管理入口是浏览器 `/admin/`；服务继续由现有 CLI 启动，不提供桌面替代入口。

### 分支 B：供应商模型能力与适配器策略

- **状态**：已定
- **已明确方向**：不让 Pi 传递或选择推理等级。Adapter 选择 Provider 与目标模型后，只以一个统一下拉框选择推理等级。用户进一步提出：映射应只配置一次，并可供多个模型复用；需确定它作为可复用映射模板，还是内联在每个 Provider 模型中。
- **代码事实**：现有 `AdapterModelMapping.thinking` 已是固定策略的落点，且在路由时优先于 Provider 模型的 `thinking`；Adapter 也已负责 `max_tokens` 和 `stream` 的固定默认行为。现有 Web 表单已有 `reasoning_effort`、`thinking.type` 及 Anthropic `budget_tokens` 的受限选择/输入，但尚未根据目标模型仅展示其声明支持的选项。证据：`src/adapter/router.ts`、`src/config/types.ts`、`src/api/admin/components/adapters.ts`。
- **弹窗字段澄清**：
  - **推理力度**=`reasoning_effort`：静态选择 `low`、`medium`、`high`、`xhigh`、`max`。对于 OpenAI/Responses 上游，转成相应 reasoning effort；对于 Anthropic 上游，映射为 `1024/4096/16384/32768/65536` token 的 thinking budget。
  - **模式**=`thinking.type`：静态透传供应商的 thinking 开关/模式，候选值为 `adaptive`、`auto`、`enabled`、`disabled`，主要用于 MiniMax adaptive 一类 Anthropic 兼容行为；它不是推理强弱档位。
  - **优先关系**：`budget_tokens` 优先于 `reasoning_effort`，后者又优先于 `thinking.type`。因此同时填“推理力度”和“模式”时，模式可能不实际生效；`thinking.type` 在当前 OpenAI 上游路径也没有单独注入效果。
- **用户提问与回答**：用户询问 Adapter 弹窗中的“推理力度”和“模式”用途；已说明其为现有的原始上游协议参数，而不是按模型能力约束的统一业务配置。
- **术语结论**：已将项目特有术语写入根目录 `CONTEXT.md`。
  - **模型能力**：Provider 模型客观支持的输入模态、上下文窗口、最大输出以及推理能力；不包含客户端 UI 和上游协议细节。
  - **统一推理等级**：llm-proxy 自己定义的一组稳定、客户端无关的等级；它可复用 Pi 的命名，但不属于 Pi。
  - **推理映射模板**：可复用的等级映射，定义每个统一等级如何翻译成 `budget_tokens`、`reasoning_effort`、`thinking.type` 或“无推理”；一个模板可被多个 Provider 模型引用。
  - **模型映射选择**：Provider 模型在新增/编辑时选择一个推理映射模板；同名模型经不同 Provider 接入时可选择不同模板。
  - **适配器策略**：Adapter 的一条模型映射只保存一个统一推理等级；运行时沿目标模型引用的模板查找参数，不复制底层协议参数。
  - **有效模型描述**：适配器向任意下游客户端返回的最终能力；继承目标模型的通用能力，不包含可供客户端切换的原始推理映射。
- **初始推荐（后由分支 C 调整）**：维护一个独立、可复用的“推理映射模板”目录；在 Provider 页面新增或编辑模型时选择其模板，而不是把映射配置到 Adapter。模板可复用给多个模型名称；Adapter 在选定 Provider 与目标模型后，仅读取该模型的模板，显示一个统一的“推理等级”下拉框并保存等级键。代理运行时才将等级解析成具体参数。是否由下游 Pi 消费有效模型描述在分支 C 单独裁决。
- **限制说明**：模板可跨多个模型复用，但不能只按 `anthropic`/`openai` 类型自动绑定：同为 OpenAI 兼容协议的模型仍可能要求不同的 reasoning 字段或根本不支持推理。因此模板必须由管理员显式选定，Provider 类型只能作为推荐默认项。
- **问题 B0（映射维护位置与复用）**：是否确认新增独立的“推理映射模板”目录，并在 Provider 页面新增/编辑模型时选择模板；一个模板可被多个模型引用，Adapter 不再提供映射模板下拉？
- **推荐理由**：这正好满足“一个映射只配置一次，Adapter 直接用”；同时避免每条 Adapter 映射重复维护低层协议参数。
- **用户回答**：确认。推理模板的选择属于 Provider 模型层，因为它与目标模型绑定；Adapter 不应知道或配置具体映射，只选择对应的统一推理等级。
- **结论**：模板定义可作为可复用目录存在，但“模型选用哪个模板”的入口只位于 Provider 的模型新增/编辑页；Adapter 表单不展示模板选择或协议参数。
- **问题 B1（统一等级集合）**：统一下拉框是否采用七档：`关闭、极低、低、中、高、超高、最大`？
- **推荐理由**：这与 Pi 已有的粒度对齐，却由 llm-proxy 定义并可供所有客户端复用；各模型可将多个统一等级映射到同一实际供应商值。
- **用户回答**：可以。
- **结论**：统一推理等级固定为七档：`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`；它们是 llm-proxy 的领域枚举，而非 Pi 专属字段。
- **问题 B2（模型不支持某档时）**：当目标模型无法真实支持某一统一等级时，下拉框应当保留该项但禁用，还是自动降级映射到最接近的可用档位？
- **推荐答案**：保留统一的下拉 UI，但将未映射等级禁用并要求管理员明确选择；不静默降级。
- **推荐理由**：静默把“关闭”或“低”变成“高”会让配置名称与实际成本/延迟不一致，正是当前难以排查的风险。
- **用户回答**：未映射等级不可选，可禁用或不展示；默认选中中等级。
- **结论**：Adapter 仅展示或启用目标模型映射过的等级，不允许静默降级；默认选择 `medium`。
- **待澄清 B2a（默认等级前提）**：若某个模型模板没有 `medium` 映射，是否应阻止该模板保存；纯文本/不支持推理的模型则只允许 `off`？
- **推荐答案**：是。这样“默认中等”始终有确定含义，避免配置成功后 Adapter 仍无有效默认值。
- **用户回答**：是；不支持推理的模型默认 `off`，其余等级不可选。
- **结论**：支持推理的模板必须映射 `medium`；不支持推理的模型只启用 `off`，Adapter 默认选择 `off`。
- **问题 B3（切换方式）**：同一上游模型需要不同推理强度时，是否只允许管理员修改 Adapter 的这个单一下拉选择并统一生效，暂不创建“快速版/深度版”等多个模型别名？
- **推荐理由**：你明确说切换很少发生；集中修改能保持 Pi 模型列表简洁。未来出现并用需求时再扩展别名，而不在当前范围预建。
- **用户回答**：确认，直接修改 Adapter 即可。Adapter 对外保持模型 ID，内部自由切换目标模型以实现随时切换。
- **结论**：一个稳定的 `sourceModelId` 是对外契约；管理员可修改其 target Provider、target model 和统一推理等级，变更对该 Adapter 的所有后续调用统一生效，不创建额外模型别名。
- **待澄清 B4（模板复用语义）**：你提出“一个映射只配置一次”。是否确认同一个推理映射模板可被多个 Provider 模型引用，之后修改该模板会同时影响所有引用它的模型？
- **推荐答案**：确认；Provider 模型只保存模板引用，只有确有差异时才新建模板。
- **推荐理由**：这才真正消除重复维护；同时仍由 Provider 模型页控制“哪个模型使用哪个模板”，Adapter 完全无感。
- **用户回答**：是。
- **结论**：推理映射模板可被多个 Provider 模型引用；修改模板会同步影响全部引用该模板的模型。若模型行为不同，创建并绑定新模板。

### 分支 D：配置界面与视觉边界

- **状态**：已定
- **用户请求**：删除 Adapter 弹窗中现有“推理力度”和“模式”两个低层下拉框；同时认为当前下拉框和整体表单视觉较丑。
- **代码事实**：管理端使用 Alpine.js，视觉样式全部内嵌于 `src/api/admin-ui.html`，`src/api/admin/components/` 是按页面组织的 Alpine 行为模块而非可复用视觉组件库。`package.json` 仅有 Alpine.js、Chart.js 与 JSONEditor；未引入 Tailwind、Bootstrap、Element Plus、shadcn/Radix 或其他 UI 组件库，也没有独立 CSS 文件。当前下拉框只是原生 `<select>` 加 6px 圆角、细边框与很小的内联尺寸样式。证据：`package.json`、`src/api/admin-ui.html`。
- **范围约束**：不能单独先删除两个字段；在新的“统一推理等级”选择器和映射解析可用的同一变更中替换，避免 Adapter 失去现有固定推理配置能力。
- **推荐答案**：保留 Alpine.js 和原生控件，不引入与当前架构不匹配的大型 React/Vue UI 库；为本次触及的 Provider/Adapter 配置表单建立小型可复用表单视觉规范，再根据确认范围扩展到其他页面。
- **问题 D1（视觉改造范围）**：本次是否只重做 Provider 模型配置和 Adapter 配置弹窗（含新模板/等级控件），而不顺手重做 Dashboard、日志、抓包等其他管理页？
- **推荐理由**：用户当前痛点集中在下拉与配置表单；限制范围能先交付一致、可用的管理体验，避免无关页面重构扩大风险。
- **用户回答**：是的。
- **结论**：本次视觉改造仅覆盖 Provider 模型配置和 Adapter 配置弹窗；Dashboard、日志、抓包等其他管理页不在范围内。
- **问题 D2（依赖取舍）**：是否接受不新增通用 UI 组件库，而是在现有 Alpine.js 上实现一致的自定义表单组件样式与交互？
- **推荐理由**：现有页面是轻量静态 SPA；引入为 Vue/React 设计的组件库意味着框架迁移或额外运行时，和本次需求不匹配。原生控件配合统一 CSS 可消除当前“内联小下拉框”的问题。
- **用户回答**：是的。
- **结论**：保留 Alpine.js 和原生控件；不引入通用 UI 组件库。本次范围内建立可复用的自定义表单样式与交互规范。

### 分支 C：下游模型能力接口边界

- **状态**：已定
- **代码事实**：当前 `GET /{adapter}/v1/models` 已能按 Adapter 的 `sourceModelId` 返回模型列表，但只含 OpenAI 基础字段且没有认证；代理请求本身由 `parseAndAuth` 依据 `proxy_key` 认证。仓库内没有 Pi extension。Pi 官方机制要求 async extension 在启动或 `/reload` 时拉取远端模型，再通过 `pi.registerProvider(..., { models })` 注册；Pi 不会自动把 OpenAI 模型列表转换为能力配置。证据：`src/adapter/handlers.ts`、`src/proxy/pipeline.ts`、Pi `docs/custom-provider.md` 与 `docs/extensions.md`。
- **边界说明**：模型能力由 llm-proxy 统一维护并通过下游模型接口返回；Pi 可以在未来自行拉取该接口配置模型，但 llm-proxy 不交付或维护任何 Pi extension、Pi 配置或 Pi 刷新逻辑。
- **原推荐撤回**：用户明确不需要 Pi extension、Pi 动态能力发现或 Pi 侧参数维护。
- **问题 C1（交付边界）**：是否确认 llm-proxy 仓库需要随包交付官方 Pi extension，而不是仅提供一个模型能力 API 和手工集成说明？
- **用户回答**：否。Pi 只传递模型 ID；模型参数全部由 llm-proxy 处理。
- **问题 C2（刷新语义）**：在 Web 中修改 Provider 模型、模板或 Adapter 目标后，Pi 是否接受在下次启动或执行 Pi `/reload` 时重新拉取；v1 不做后台轮询或服务端推送？
- **用户回答**：不适用。现有 Pi 只感知稳定的模型 ID；Adapter 内部更换目标模型无需 Pi 感知。仅新增/删除对外模型 ID 时才需在 Pi 侧处理。
- **问题 C3（发现认证与故障）**：模型能力列表是否使用与代理请求相同的 `proxy_key` 认证；发现失败时新 Pi 会话明确报错且不使用本地静态/过期模型缓存？
- **用户回答**：不需要。模型清单来自 llm-proxy 自身配置，不请求目标供应商的 `/models` 接口；本需求不改变该部分。
- **问题 C4（接口兼容性）**：是否在现有 `GET /{adapter}/v1/models` 的 `data[]` 条目补充能力字段供官方 extension 读取，而不新增独立发现端点？
- **用户回答（已更新）**：需要模型接口返回当前模型的上下文窗口等参数给下游；但不处理 Pi 本身。
- **结论（部分）**：Pi 被视为普通客户端，只发送既有稳定 `sourceModelId`。本次不创建 Pi extension、不改 Pi `models.json`、不访问目标供应商模型目录；但 llm-proxy 要扩展下游模型列表，动态返回 Adapter 当前目标模型的有效能力。
- **问题 C5（下游端点范围）**：是否只扩展 `GET /{adapter}/v1/models`，使其返回 Adapter 对外的 `sourceModelId` 及当前目标模型能力；保持直连的 `GET /v1/models` 现有基础格式不变？
- **推荐答案**：是。Adapter 才是下游稳定模型 ID 与实际目标模型的绑定点，只有它能准确反映“当前模型”；避免为直连模型列表引入同名 Provider 的歧义。
- **用户回答**：是的。
- **结论**：只扩展 `GET /{adapter}/v1/models`；直连 `GET /v1/models` 保持现有基础格式。
- **问题 C6（能力契约）**：下游模型项是否返回统一 `capabilities` 对象，至少包含 `contextWindow`、`maxTokens`、`input`、`reasoning` 和 Adapter 当前的 `reasoningLevel`，但绝不暴露底层模板、`budget_tokens`、`reasoning_effort` 或 `thinking.type`？
- **推荐答案**：是。下游获得稳定、模型无关的能力事实和当前固定策略；上游协议细节继续封装在 llm-proxy 内部。
- **用户回答**：是的。
- **结论**：Adapter 模型列表的每项增加稳定 `capabilities` 对象：`contextWindow`、`maxTokens`、`input`、`reasoning`、`reasoningLevel`；不暴露模板或上游协议字段。

### 分支 E：模型参数的代理职责

- **状态**：已定
- **代码事实**：现有 Provider 模型仅有 `thinking` 和 `input`；`input` 已用于 vision fallback。`max_tokens` 当前是 Adapter 级默认值：客户端未传或传 0 时注入；不存在模型级最大输出字段。仓库没有 `contextWindow`/`context_window` 字段或基于它的上下文长度校验。证据：`src/config/types.ts`、`src/adapter/router.ts`、`src/proxy/translation.ts`。
- **边界说明**：Pi 不再消费能力配置后，推理映射仍可由代理执行；但 `contextWindow` 不会自动影响 Pi 的压缩策略，除非 llm-proxy 新增请求上下文校验。模型级最大输出是否取代现有 Adapter 默认值也需明确。
- **问题 E1（最大输出归属）**：是否把默认 `max_tokens` 从 Adapter 移到 Provider 模型配置，使其随 Adapter 目标模型切换而变化；Adapter 不再单独维护 `max_tokens` 覆盖？
- **推荐答案**：是。最大输出是模型能力，放在模型层可避免同一 Adapter 切换到不同模型后沿用不合适的旧值。
- **用户回答**：是。
- **结论**：默认最大输出移至 Provider 模型；Adapter 移除 `max_tokens` 配置并随当前目标模型生效。
- **问题 E2（上下文窗口）**：既然 Pi 不消费模型能力，是否将 `contextWindow` 排除本次范围，而不新增仅用于展示、没有实际请求效果的字段或上下文长度校验？
- **推荐答案**：是。上游模型仍是上下文限制的权威来源；除非你明确要代理层预校验，否则添加此字段只会制造看似被管理、实际不生效的配置。
- **用户回答（已更新）**：不排除。llm-proxy 的下游模型接口必须返回当前模型的上下文窗口等参数；但本次不处理 Pi。
- **结论（部分）**：Provider 模型维护 `contextWindow`，并由 Adapter 下游模型列表返回有效值；本次不新增代理层上下文长度校验。

## 术语挑战

- 已解决：Provider Model、Reasoning Mapping Template、Unified Reasoning Level、Adapter Model Mapping 与 Effective Model Description 的规范定义已写入 `CONTEXT.md`；无 deferred 术语。

## 已定

- 完整删除 macOS App 的源码、构建/发布链路、专属脚本、用户文档/截图及历史 macOS 计划文档。
- 仅保留 Node CLI 启动服务与浏览器 `/admin/` 管理入口；不提供桌面替代入口。
- 推理模板与目标 Provider 模型绑定：在 Provider 模型新增/编辑时选择模板；Adapter 不接触映射模板或上游协议参数，只选择统一推理等级。
- llm-proxy 使用七档统一推理等级：`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`；这些等级不属于 Pi。
- Adapter 只提供目标模型已经映射的等级，未映射等级不可选且不得静默降级；默认选择 `medium`。
- Adapter 的 `sourceModelId` 是稳定的外部模型 ID；管理员可通过修改 Adapter 映射切换其目标 Provider、目标模型和推理等级，后续请求统一生效，不创建额外模型别名。
- 推理映射模板可被多个 Provider 模型引用；模板变更同步作用于所有引用模型。支持推理的模板必须映射 `medium`；不支持推理的模型仅启用且默认选中 `off`。
- Pi 仅作为普通客户端传递稳定 `sourceModelId`；不交付 Pi extension、不管理 Pi 侧模型参数。llm-proxy 独立扩展 Adapter 下游模型列表的有效能力字段，Adapter 内部切换目标模型对 Pi 与其他下游保持透明。
- 本次只重做 Provider 模型配置和 Adapter 配置弹窗，保留 Alpine.js 与原生控件，不增加通用 UI 组件库。
- 默认最大输出从 Adapter 移至 Provider 模型，Adapter 移除其 `max_tokens` 覆盖；Provider 模型维护 `contextWindow`，本次不增加代理层上下文长度校验。
- 仅扩展 `GET /{adapter}/v1/models`：每个 Adapter 对外模型返回稳定 `capabilities`（`contextWindow`、`maxTokens`、`input`、`reasoning`、`reasoningLevel`）；直连 `/v1/models` 维持基础格式，且不返回模板或上游协议字段。

## 未定

- 无。

## Deferred

- 无。

## 阻塞项

- 无。

## ADR 判断

- **写入 `docs/adr/0001-web-only-distribution.md`**：Web-only 分发难以逆转、缺失上下文会难以理解，且存在保留或移除原生 App 的真实取舍。
- **写入 `docs/adr/0002-model-capability-ownership.md`**：模型能力/模板/Adapter 的所有权会长期决定配置结构与请求优先级；未来没有上下文难以理解，并存在多层配置的真实取舍。
- **写入 `docs/adr/0003-adapter-effective-model-descriptions.md`**：Adapter 模型列表的能力契约是下游公开接口，难以逆转且存在“扩展 Adapter、扩展直连或新增端点”的真实取舍。
- **不写 ADR：表单视觉范围与不引入组件库**，该决定易于调整、原因直接，不满足难以逆转条件。
- **不单独写 ADR：模型级 `maxTokens` 和不做上下文预校验**，它们是模型能力所有权决策的直接后果，单独记录价值不足。

## Glossary / CONTEXT.md 更新

- 已创建 `CONTEXT.md`，定义 Provider Model、Reasoning Mapping Template、Unified Reasoning Level、Adapter Model Mapping 和 Effective Model Description；没有遗留术语冲突。
