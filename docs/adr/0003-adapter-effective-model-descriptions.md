# 从 Adapter 模型列表返回有效模型能力

仅扩展 `GET /{adapter}/v1/models`：每个对外 source model 返回稳定的 `capabilities` 对象，包含当前目标模型推导出的上下文窗口、最大输出、输入模态、推理状态和固定推理等级，但绝不包含原始模板或上游协议参数。直连 `/v1/models` 保持现有基础格式。llm-proxy 不交付或维护 Pi 专项集成；任何下游客户端都可以消费这一通用 Adapter 能力契约。