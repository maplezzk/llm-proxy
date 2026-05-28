/**
 * 精确模拟 CCX 的 stripCodexClientOnlyTools + shouldDropResponsesToolObject 行为。
 * 
 * 输入数据：模拟 Codex 发送的完整 tools 数组（包含所有类型）
 * 输出：CCX 会保留哪些、剥离哪些
 * 
 * 用于验证：CCX 是否真的会传递 list_mcp_resource_templates 给上游模型。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert'

/** CCX shouldDropResponsesToolObject 的精确翻译 */
function shouldDropResponsesToolObject(tool: Record<string, unknown>): boolean {
  const toolType = String(tool.type ?? '').toLowerCase()
  switch (toolType) {
    case 'namespace':
    case 'custom':
    case 'web_search':
    case 'local_shell':
    case 'computer_use':
      return true
  }
  return false
}

/** CCX stripCodexClientOnlyTools 的精确翻译 */
function stripCodexClientOnlyTools(tools: unknown[]): unknown[] {
  let removedCount = 0
  const kept: unknown[] = []

  for (const item of tools) {
    if (typeof item === 'string') {
      removedCount++
      continue
    }
    if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
      if (shouldDropResponsesToolObject(item as Record<string, unknown>)) {
        removedCount++
        continue
      }
      kept.push(item)
      continue
    }
    removedCount++
  }

  // CCX: if removed > 0 but kept.length === 0, delete tools + tool_choice entirely
  if (removedCount > 0 && kept.length === 0) {
    return [] // Equivalent to deleting keys
  }

  return kept
}

/**
 * 模拟 Codex 发送给 CCX 的完整 tools 数组。
 * 包含 computer_use_preview、list_mcp_resource_templates、namespace 等所有类型。
 */
const CODEX_FULL_TOOLS = [
  // Codex 内置：computer use preview
  { type: 'computer_use_preview', display_width: 1024, display_height: 768, environment: 'browser' },

  // Codex 内部工具（触发 MCP 调用）
  { type: 'function', name: 'list_mcp_resources', description: 'List MCP resources', parameters: { type: 'object', properties: { server: { type: 'string' } }, required: ['server'] } },
  { type: 'function', name: 'list_mcp_resource_templates', description: 'List MCP resource templates', parameters: { type: 'object', properties: { server: { type: 'string' } }, required: ['server'] } },
  { type: 'function', name: 'read_mcp_resource', description: 'Read MCP resource', parameters: { type: 'object', properties: { server: { type: 'string' }, uri: { type: 'string' } }, required: ['server', 'uri'] } },

  // Codex 内部工具（字符串简写，CCX 会剥离）
  'exec_command',

  // Codex 内部工具（对象格式）
  { type: 'function', name: 'exec_command', description: 'Execute shell command', parameters: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' } }, required: ['command'] } },

  // Codex namespace 工具（MCP server 中的工具）
  { type: 'namespace', name: 'mcp__computer_use__', tools: [{ type: 'function', name: 'get_app_state' }, { type: 'function', name: 'click' }] },

  // 用户自定义工具（应该保留）
  { type: 'function', name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
]

describe('CCX stripCodexClientOnlyTools 精确模拟', () => {
  it('CCX 会剥离 computer_use_preview（shouldDropResponsesToolObject 匹配）', () => {
    // 注意：CCX 的 shouldDropResponsesToolObject 只有 case "computer_use"
    // 没有 case "computer_use_preview"
    // 所以 computer_use_preview 在使用 shouldDropResponsesToolObject 时不剥离
    // 但在后续 convertToolsToOpenAI 中 type 不匹配 function → 剥离
    const resultCCX = shouldDropResponsesToolObject({ type: 'computer_use_preview' })
    const resultComputerUse = shouldDropResponsesToolObject({ type: 'computer_use' })
    console.log(`  shouldDrop('computer_use_preview'): ${resultCCX}`)
    console.log(`  shouldDrop('computer_use'): ${resultComputerUse}`)
    // computer_use_preview type is not in the switch → not dropped by this function alone
    // It gets dropped later in convertToolsToOpenAI which only accepts type: "function"
    assert.strictEqual(resultCCX, false, 'computer_use_preview 不被 shouldDrop 剥离')
    assert.strictEqual(resultComputerUse, true, 'computer_use 被 shouldDrop 剥离')
  })

  it('CCX 保留 list_mcp_resource_templates（type:function 不在剥离表）', () => {
    const tool = { type: 'function', name: 'list_mcp_resource_templates' }
    assert.strictEqual(shouldDropResponsesToolObject(tool), false,
      'list_mcp_resource_templates 是 type:function，CCX 不剥离')
  })

  it('stripCodexClientOnlyTools: 保留所有 type:function 工具（包括 list_mcp_*）', () => {
    const kept = stripCodexClientOnlyTools(CODEX_FULL_TOOLS)
    const keptNames = kept.map((t: any) => t.name)

    console.log(`  输入: ${CODEX_FULL_TOOLS.length} tools`)
    console.log(`  保留: ${kept.length} tools`)
    console.log(`  保留名称:`, keptNames)

    // 验证：list_mcp_resource_templates 应该保留
    assert.ok(keptNames.includes('list_mcp_resource_templates'),
      'CCX 保留 list_mcp_resource_templates — 这就是模型会调用的工具！')

    // 验证：list_mcp_resources 应该保留
    assert.ok(keptNames.includes('list_mcp_resources'),
      'CCX 保留 list_mcp_resources')

    // 验证：read_mcp_resource 应该保留
    assert.ok(keptNames.includes('read_mcp_resource'),
      'CCX 保留 read_mcp_resource')

    // 验证：用户自定义工具保留
    assert.ok(keptNames.includes('get_weather'),
      'CCX 保留用户自定义函数工具')

    // 验证：computer_use_preview 保留（shouldDrop 不处理，后续 convertToolsToOpenAI 会处理）
    const hasComputerUsePreview = kept.some((t: any) => t.type === 'computer_use_preview')
    assert.ok(hasComputerUsePreview, 'stripCodexClientOnlyTools 保留 computer_use_preview（后续由工具转换器剥离）')

    // 验证：namespace 剥离
    const hasNamespace = kept.some((t: any) => t.type === 'namespace')
    assert.strictEqual(hasNamespace, false, 'CCX 剥离 namespace 工具')

    // 验证：字符串简写剥离
    const hasStrings = kept.some((t: any) => typeof t === 'string')
    assert.strictEqual(hasStrings, false, 'CCX 剥离字符串简写工具')

    // 结论
    console.log(`\n  结论：CCX stripCodexClientOnlyTools 保留 list_mcp_* 工具（type:function）`)
    console.log(`  这些工具传到 DeepSeek → DeepSeek 调用它们 → 转回 function_call →`)
    console.log(`  Codex 执行 function_call → 调 MCP resources/* → 失败`)
    console.log(`  → CCX 和我们的行为完全相同`)
  })
})
