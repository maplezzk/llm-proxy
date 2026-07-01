import SwiftUI

/// 抓包查看器——启停开关、SSE 实时流、条目列表、JSON 详情、来源过滤、左右对比视图
struct CaptureView: View {
    @State private var viewModel = CaptureViewModel()
    @State private var copiedEntryId: Int? = nil

    var body: some View {
        VStack(spacing: 0) {
            // 顶部控制栏
            toolbar
            Divider()

            if viewModel.filteredEntries.isEmpty && !viewModel.running {
                // 空状态
                emptyState
            } else {
                // 主内容：左侧条目列表 + 右侧详情面板
                GeometryReader { geo in
                    HSplitView {
                        entryList
                            .frame(minWidth: 260, idealWidth: 320)
                            .frame(maxWidth: geo.size.width * 0.45)

                        detailPanel
                            .frame(minWidth: 300)
                    }
                }
            }
        }
        .task {
            await viewModel.checkStatus()
        }
    }

    // MARK: - Toolbar

    private var toolbar: some View {
        HStack(spacing: 14) {
            // 抓包开关
            HStack(spacing: 8) {
                Circle()
                    .fill(viewModel.running ? Color.green : Color.gray)
                    .frame(width: 8, height: 8)
                    .shadow(color: viewModel.running ? Color.green.opacity(0.4) : Color.clear, radius: 3)

                Text(viewModel.running ? loc("capture.stop") : loc("capture.start"))
                    .fontWeight(.medium)
                    .font(.subheadline)

                Toggle("", isOn: Binding(
                    get: { viewModel.running },
                    set: { enabled in
                        Task {
                            if enabled {
                                await viewModel.startCapture()
                            } else {
                                await viewModel.stopCapture()
                            }
                        }
                    }
                ))
                .toggleStyle(.switch)
                .labelsHidden()
            }

            if viewModel.running {
                Divider()
                    .frame(height: 20)

                // 结束并清空按钮
                Button(loc("capture.endAndClear")) {
                    Task { await viewModel.endCapture() }
                }
                .buttonStyle(.borderless)
                .foregroundColor(.red)
                .font(.caption)
            }

            Spacer()

            // 来源过滤
            if !viewModel.sources.isEmpty {
                HStack(spacing: 6) {
                    Text(loc("capture.sourceFilter") + ":")
                        .font(.caption)
                        .foregroundColor(.secondary)

                    Picker("", selection: Binding(
                        get: { viewModel.sourceFilter ?? "" },
                        set: { val in
                            viewModel.sourceFilter = val.isEmpty ? nil : val
                        }
                    )) {
                        Text(loc("capture.allSources")).tag("")
                        ForEach(viewModel.sources, id: \.self) { source in
                            Text(source).tag(source)
                        }
                    }
                    .pickerStyle(.menu)
                    .labelsHidden()
                    .frame(width: 140)
                }
            }

            // 条目计数
            if !viewModel.filteredEntries.isEmpty {
                Text("\(viewModel.filteredEntries.count) entries")
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .monospacedDigit()
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Color(nsColor: .controlBackgroundColor))
    }

    // MARK: - Empty State

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "antenna.radiowaves.left.and.right")
                .font(.system(size: 40))
                .foregroundColor(.secondary)
            Text(loc("capture.noData"))
                .foregroundColor(.secondary)
                .font(.subheadline)
            Text("Toggle the switch above to start capturing")
                .font(.caption)
                .foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Entry List

    private var entryList: some View {
        VStack(spacing: 0) {
            // 列表头
            entryListHeader

            Divider()

            // 条目列表
            if viewModel.filteredEntries.isEmpty {
                Spacer()
                Text(loc("capture.noData"))
                    .foregroundColor(.secondary)
                Spacer()
            } else {
                List(selection: Binding(
                    get: { viewModel.selectedId },
                    set: { viewModel.selectedId = $0 }
                )) {
                    ForEach(Array(viewModel.filteredEntries.enumerated()), id: \.element.id) { index, entry in
                        CaptureEntryRow(entry: entry, isSelected: viewModel.selectedId == entry.id, index: index)
                            .contentShape(Rectangle())
                            .onTapGesture {
                                viewModel.toggleSelected(entry.id)
                            }
                            .listRowSeparator(.hidden)
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
            }

            // 错误信息
            if let error = viewModel.errorMessage {
                Divider()
                HStack(spacing: 4) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundColor(.red)
                        .font(.caption)
                    Text(error)
                        .font(.caption)
                        .foregroundColor(.red)
                        .lineLimit(2)
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
            }
        }
        .background(Color(NSColor.controlBackgroundColor))
    }

    private var entryListHeader: some View {
        HStack(spacing: 4) {
            Text("#")
                .frame(width: 28, alignment: .leading)
            Text("Time")
                .frame(width: 60, alignment: .leading)
            Text("Source")
                .frame(width: 70, alignment: .leading)
            Text("Model")
                .frame(maxWidth: .infinity, alignment: .leading)
            Text("Size")
                .frame(width: 50, alignment: .trailing)
        }
        .font(.caption)
        .foregroundColor(.secondary)
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.5))
    }

    // MARK: - Detail Panel

    @ViewBuilder
    private var detailPanel: some View {
        if let entry = viewModel.selectedEntry {
            entryDetail(entry)
        } else {
            VStack {
                Spacer()
                Image(systemName: "doc.text.magnifyingglass")
                    .font(.system(size: 32))
                    .foregroundColor(.secondary)
                Text(loc("capture.noSelection"))
                    .foregroundColor(.secondary)
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func entryDetail(_ entry: CaptureEntry) -> some View {
        VStack(spacing: 0) {
            // 条目元信息
            entryMetaHeader(entry)
            Divider()

            // 左右对比视图
            HSplitView {
                // 左侧：客户端↔代理
                phaseColumn(
                    title: loc("capture.clientSide"),
                    topLabel: loc("capture.phase.requestIn"),
                    bottomLabel: loc("capture.phase.responseOut"),
                    topContent: entry.requestIn,
                    bottomContent: entry.responseOut,
                    isResponse: false
                )

                // 右侧：代理↔上游
                phaseColumn(
                    title: loc("capture.upstreamSide"),
                    topLabel: loc("capture.phase.requestOut"),
                    bottomLabel: loc("capture.phase.responseIn"),
                    topContent: entry.requestOut,
                    bottomContent: entry.responseIn,
                    isResponse: true
                )
            }
        }
    }

    private func entryMetaHeader(_ entry: CaptureEntry) -> some View {
        HStack(spacing: 10) {
            Text("#\(entry.id)")
                .font(.caption)
                .foregroundColor(.secondary)
                .monospacedDigit()

            Text(formatTimestamp(entry.timestamp))
                .font(.caption.monospacedDigit())
                .foregroundColor(.secondary)

            sourceBadge(entry.source)

            Text(entry.protocol.uppercased())
                .font(.caption2)
                .fontWeight(.medium)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Color.blue.opacity(0.12))
                .foregroundColor(.blue)
                .clipShape(Capsule())

            Text(entry.model)
                .font(.caption)
                .foregroundColor(.primary)

            if let adapter = entry.adapterName, !adapter.isEmpty {
                Image(systemName: "arrow.right")
                    .font(.system(size: 8))
                    .foregroundColor(.secondary)
                Text(adapter)
                    .font(.caption)
                    .foregroundColor(.orange)
            }

            Spacer()

            Button {
                copyToClipboard(rawJSON: formatEntryJSON(entry))
                withAnimation(.easeInOut(duration: 0.2)) {
                    copiedEntryId = entry.id
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        if copiedEntryId == entry.id {
                            copiedEntryId = nil
                        }
                    }
                }
            } label: {
                Image(systemName: copiedEntryId == entry.id ? "checkmark" : "doc.on.doc")
                    .font(.caption)
                    .foregroundColor(copiedEntryId == entry.id ? .green : .secondary)
            }
            .buttonStyle(.borderless)
            .help(copiedEntryId == entry.id ? loc("common.copied") : loc("common.copy"))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.6))
    }

    private func sourceBadge(_ source: String) -> some View {
        let color: Color = source == "proxy" ? .green : .orange
        return Text(source)
            .font(.caption2)
            .fontWeight(.medium)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.12))
            .foregroundColor(color)
            .clipShape(Capsule())
    }

    // MARK: - Phase Column

    private func phaseColumn(
        title: String,
        topLabel: String,
        bottomLabel: String,
        topContent: String?,
        bottomContent: String?,
        isResponse: Bool
    ) -> some View {
        VStack(spacing: 0) {
            // 列标题
            Text(title)
                .font(.caption)
                .fontWeight(.semibold)
                .foregroundColor(.secondary)
                .padding(.vertical, 6)
                .frame(maxWidth: .infinity)
                .background(Color(nsColor: .controlBackgroundColor).opacity(0.7))

            VSplitView {
                // 请求（上）
                phaseBlock(label: topLabel, content: topContent, isResponse: false)

                // 响应（下）
                phaseBlock(label: bottomLabel, content: bottomContent, isResponse: isResponse)
            }
        }
    }

    private func phaseBlock(label: String, content: String?, isResponse: Bool) -> some View {
        VStack(spacing: 0) {
            // 标签
            HStack {
                Text(label)
                    .font(.caption)
                    .fontWeight(.medium)
                    .foregroundColor(.secondary)
                Spacer()
                if let raw = content {
                    Button {
                        copyToClipboard(rawJSON: raw)
                    } label: {
                        Image(systemName: "doc.on.doc")
                            .font(.system(size: 10))
                    }
                    .buttonStyle(.borderless)
                    .help(loc("common.copy"))
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(Color(nsColor: .controlBackgroundColor).opacity(0.4))

            // 内容
            if let contentStr = content, !contentStr.isEmpty {
                let maxDisplayLen = 8000
                let isTruncated = contentStr.count > maxDisplayLen
                let displayStr = isTruncated
                    ? String(contentStr.prefix(maxDisplayLen))
                    : contentStr

                VStack(spacing: 0) {
                    ScrollView([.horizontal, .vertical]) {
                        Text(formatPhaseContent(displayStr, isResponse: isResponse))
                            .font(.system(.caption, design: .monospaced))
                            .textSelection(.enabled)
                            .padding(10)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    if isTruncated {
                        HStack(spacing: 6) {
                            Image(systemName: "exclamationmark.triangle")
                                .font(.caption2)
                                .foregroundColor(.orange)
                            Text("Content truncated (\(contentStr.count / 1024)KB). Use copy button for full content.")
                                .font(.caption2)
                                .foregroundColor(.secondary)
                            Spacer()
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(Color.orange.opacity(0.06))
                    }
                }
                .background(Color.primary.opacity(0.03))
            } else {
                VStack {
                    Spacer()
                    Text(loc("capture.noContent"))
                        .font(.caption)
                        .foregroundColor(.secondary)
                    Spacer()
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    // MARK: - Helpers

    private func formatTimestamp(_ ts: Int) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(ts) / 1000.0)
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss.SSS"
        return formatter.string(from: date)
    }

    private func fmtSize(_ str: String?) -> String {
        guard let s = str, !s.isEmpty else { return "0B" }
        let bytes = s.utf8.count
        if bytes > 1024 {
            return String(format: "%.1fKB", Double(bytes) / 1024.0)
        }
        return "\(bytes)B"
    }

    private func formatPhaseContent(_ raw: String, isResponse: Bool) -> String {
        if isResponse {
            // 响应可能是流式 SSE 文本，直接显示
            return raw
        }
        // 尝试 JSON 格式化（用 JSONFormatter 守卫顶层非 array/dict 等场景的 NSException）
        guard let data = raw.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) else { return raw }
        return JSONFormatter.pretty(json)
    }

    private func formatEntryJSON(_ entry: CaptureEntry) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(entry) else {
            return ""
        }
        return String(data: data, encoding: .utf8) ?? ""
    }

    private func copyToClipboard(rawJSON: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(rawJSON, forType: .string)
    }
}

// MARK: - Entry Row

private struct CaptureEntryRow: View {
    let entry: CaptureEntry
    let isSelected: Bool
    let index: Int

    var body: some View {
        HStack(spacing: 4) {
            Text("#\(entry.id)")
                .frame(width: 28, alignment: .leading)
                .foregroundColor(.secondary)

            Text(formatTime(entry.timestamp))
                .frame(width: 60, alignment: .leading)

            sourceBadge

            Text(entry.model)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)

            Text(fmtSize(entry.requestIn ?? entry.requestOut))
                .frame(width: 50, alignment: .trailing)
                .foregroundColor(.secondary)
        }
        .font(.caption)
        .padding(.vertical, 4)
        .padding(.horizontal, 6)
        .background(
            isSelected
                ? Color.accentColor.opacity(0.15)
                : (index.isMultiple(of: 2)
                    ? Color(nsColor: .controlBackgroundColor)
                    : Color.primary.opacity(0.03))
        )
        .cornerRadius(4)
    }

    private var sourceBadge: some View {
        let color: Color = entry.source == "proxy" ? .green : .orange
        return Text(entry.source)
            .font(.system(size: 9))
            .padding(.horizontal, 3)
            .padding(.vertical, 1)
            .background(color.opacity(0.2))
            .cornerRadius(2)
            .frame(width: 70, alignment: .leading)
    }

    private func formatTime(_ ts: Int) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(ts) / 1000.0)
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        return formatter.string(from: date)
    }

    private func fmtSize(_ str: String?) -> String {
        guard let s = str, !s.isEmpty else { return "0B" }
        let bytes = s.utf8.count
        if bytes > 1024 {
            return String(format: "%.1fK", Double(bytes) / 1024.0)
        }
        return "\(bytes)B"
    }
}
