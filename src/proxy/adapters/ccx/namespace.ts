/** CCX namespace 工具名上下文。 */
export interface NamespaceFunctionSpec {
  namespace: string
  name: string
}

/** 从 namespace 工具定义建立扁平工具名到原始名称的映射。 */
export function buildNamespaceToolContext(tools: unknown[]): Map<string, NamespaceFunctionSpec> {
  const context = new Map<string, NamespaceFunctionSpec>()
  if (!Array.isArray(tools)) return context
  for (const raw of tools) {
    const tool = raw as Record<string, unknown>
    if (tool.type !== 'namespace' || typeof tool.name !== 'string' || !Array.isArray(tool.tools)) continue
    for (const childRaw of tool.tools) {
      const child = childRaw as Record<string, unknown>
      if (child.type !== 'function' || typeof child.name !== 'string' || !child.name) continue
      const namespace = tool.name
      const flat = namespace.endsWith('__') ? `${namespace}${child.name}` : `${namespace}__${child.name}`
      context.set(flat, { namespace, name: child.name })
    }
  }
  return context
}

/** 将 Responses function_call 的扁平名称还原为 namespace + name。 */
export function remapNamespaceFunctionCalls(
  output: Array<Record<string, unknown>>,
  context: Map<string, NamespaceFunctionSpec>,
): void {
  for (const item of output) {
    if (item.type !== 'function_call' || typeof item.name !== 'string') continue
    const spec = context.get(item.name)
    if (!spec) continue
    item.name = spec.name
    item.namespace = spec.namespace
  }
}

/** 使用请求上下文解码 namespace__name；未知名称保持原样。 */
export function decodeNs(
  flatName: string,
  context?: Map<string, NamespaceFunctionSpec>,
): { name: string; namespace?: string } {
  const spec = context?.get(flatName)
  return spec ? { name: spec.name, namespace: spec.namespace } : { name: flatName }
}

/** 编码 namespace 与函数名，避免 namespace 已带分隔符时重复添加。 */
export function encodeNs(namespace: string | undefined, name: string): string {
  if (!namespace) return name
  return namespace.endsWith('__') ? `${namespace}${name}` : `${namespace}__${name}`
}
