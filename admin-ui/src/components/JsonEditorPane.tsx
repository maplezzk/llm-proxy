import { useEffect, useRef, useState } from 'react'

/**
 * jsoneditor 只读查看面板 — 封装 CDN 版 jsoneditor（window.JSONEditor）。
 *
 * 行为对齐旧版 capture.ts renderEditors：
 * - 无数据：居中占位「(暂无数据)」
 * - 流式阶段（isStream）或 JSON 解析失败：原始文本 <pre>
 * - 其余：JSON 树形编辑器（tree/code/text 可切，只读、无菜单栏/导航栏/状态栏）
 *
 * data 变化（含 SSE pairId 合并带来的选中条目更新）时销毁并重建编辑器。
 */
export default function JsonEditorPane({
  data,
  isStream,
}: {
  data: string | null
  isStream: boolean
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<{ destroy: () => void } | null>(null)
  const [parseFailed, setParseFailed] = useState(false)

  // 卸载时销毁编辑器，防止泄漏。
  useEffect(
    () => () => {
      editorRef.current?.destroy()
      editorRef.current = null
    },
    [],
  )

  // data / isStream 变化时重建。
  useEffect(() => {
    editorRef.current?.destroy()
    editorRef.current = null
    setParseFailed(false)

    const el = containerRef.current
    if (!el || !data || isStream) return
    const JsonEditor = (window as unknown as { JSONEditor?: unknown }).JSONEditor as
      | (new (
          el: HTMLElement,
          opts: Record<string, unknown>,
          json: unknown,
        ) => { destroy: () => void })
      | undefined
    if (!JsonEditor) {
      setParseFailed(true)
      return
    }
    try {
      const json = JSON.parse(data)
      el.innerHTML = ''
      editorRef.current = new JsonEditor(
        el,
        {
          mode: 'tree',
          modes: ['tree', 'code', 'text'],
          mainMenuBar: false,
          navigationBar: false,
          statusBar: false,
          readOnly: true,
        },
        json,
      )
    } catch {
      setParseFailed(true)
    }
  }, [data, isStream])

  if (!data) {
    // 旧版硬编码中文占位（locales 无对应 key，忠实迁移）
    return (
      <div className="flex min-h-20 items-center justify-center text-[11px] text-muted-foreground">
        (暂无数据)
      </div>
    )
  }

  if (isStream || parseFailed) {
    return (
      <pre className="min-h-20 overflow-auto p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all text-foreground">
        {data}
      </pre>
    )
  }

  return <div ref={containerRef} className="min-h-20 overflow-auto text-[11px]" />
}
