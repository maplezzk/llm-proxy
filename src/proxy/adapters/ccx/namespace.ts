/** CCX namespace 工具名上下文。 */
export interface NamespaceFunctionSpec {
  namespace: string
  name: string
}

/** 判断输入是否为可读字段的非数组对象（排除 null / undefined / 数组 / 原始类型）。 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/**
 * 生成扁平工具名。namespace 已以 `__` 结尾时直接拼接，避免重复分隔符（如 mcp__x____run）。
 * 与 `decodeNs` 经 `buildNamespaceToolContext` 的 lookup 保持双向一致。
 */
const buildFlatName = (namespace: string, name: string): string =>
  namespace.endsWith('__') ? `${namespace}${name}` : `${namespace}__${name}`

/**
 * 从工具记录里读出合法子数组：每项必须是 record，过滤掉 null / string / number 等。
 * 同时排除非数组输入，避免不安全的 `as` 强制断言。
 */
const parseChildRecords = (raw: unknown): Array<Record<string, unknown>> | null => {
  if (!Array.isArray(raw)) return null
  const records: Array<Record<string, unknown>> = []
  for (const item of raw) {
    if (isRecord(item)) records.push(item)
  }
  return records
}

/** 提取工具记录里指定 type 的字符串名称字段，不合法返回 null。 */
const readStringField = (raw: unknown, expectedType: string): string | null => {
  if (!isRecord(raw)) return null
  if (raw.type !== expectedType) return null
  if (typeof raw.name !== 'string' || !raw.name) return null
  return raw.name
}

/**
 * 提取合法 namespace 工具记录的 namespace + 已过滤的 children 记录数组。
 * `children` 已在子步骤里完成 null / 字符串过滤，调用方无需再做 typeof 校验。
 */
const parseNamespaceTool = (
  raw: unknown,
): { namespace: string; children: Array<Record<string, unknown>> } | null => {
  const name = readStringField(raw, 'namespace')
  if (!name) return null
  const children = parseChildRecords((raw as Record<string, unknown>).tools)
  if (!children) return null
  return { namespace: name, children }
}

/** 从 namespace 工具定义建立扁平工具名到原始名称的映射。 */
export function buildNamespaceToolContext(tools: unknown[]): Map<string, NamespaceFunctionSpec> {
  const context = new Map<string, NamespaceFunctionSpec>()
  if (!Array.isArray(tools)) return context
  for (const raw of tools) {
    // 防御非对象元素（null / undefined / string / number）：通过 parseNamespaceTool 内部守卫过滤
    const parsed = parseNamespaceTool(raw)
    if (!parsed) continue
    for (const childRaw of parsed.children) {
      // children 已过滤为 record；仅 type=function 且 name 非空时纳入映射
      const childName = readStringField(childRaw, 'function')
      if (!childName) continue
      context.set(buildFlatName(parsed.namespace, childName), {
        namespace: parsed.namespace,
        name: childName,
      })
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
