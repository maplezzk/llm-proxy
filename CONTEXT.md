# llm-proxy 上下文

llm-proxy 是本地的多协议 LLM 代理，提供浏览器管理界面。其配置严格区分上游模型事实和面向下游暴露的稳定模型 ID。

## 术语

**Provider 模型（Provider Model）**：
配置在某个上游 Provider 下的模型。它拥有上下文窗口、最大输出、输入模态以及选定的推理映射模板等模型事实。
_避免使用_：下游模型、Adapter 模型

**推理映射模板（Reasoning Mapping Template）**：
把 llm-proxy 统一推理等级转换为某一上游模型族具体推理参数的可复用映射。
_避免使用_：Pi thinking map、Provider 默认值

**统一推理等级（Unified Reasoning Level）**：
`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max` 之一。它是由 Adapter 选择的 llm-proxy 领域值，不属于任何客户端。
_避免使用_：Pi thinking level、reasoning effort

**Adapter 模型映射（Adapter Model Mapping）**：
将稳定的下游 `sourceModelId` 映射到 Provider 模型及一个统一推理等级的配置。改变其目标时，持续使用该 source ID 的下游客户端无需感知。
_避免使用_：Provider 模型、原始路由

**有效模型描述（Effective Model Description）**：
由 Adapter 模型映射当前目标模型和推理策略推导出的能力描述，通过 Adapter 模型列表端点返回给下游调用方。
_避免使用_：上游模型列表、Pi 模型配置
