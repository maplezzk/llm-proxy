import SwiftUI

struct LogsView: View {
    @State private var viewModel = LogsViewModel()
    @Namespace private var logListBottom
    @State private var expandedLogIds: Set<Int> = []

    var body: some View {
        VStack(spacing: 0) {
            filterBar
            Divider()
            logList
            Divider()
            paginationBar
        }
        .frame(minWidth: 500)
        .task {
            await viewModel.load()
            viewModel.startPolling()
        }
        .onDisappear {
            viewModel.stopPolling()
        }
    }

    // MARK: - Filter Bar

    private var filterBar: some View {
        HStack(spacing: 12) {
            // 级别过滤 - segmented style
            Picker(loc("logs.levelFilter"), selection: Binding(
                get: { viewModel.levelFilter ?? "all" },
                set: { newVal in
                    Task {
                        await viewModel.setLevelFilter(newVal == "all" ? nil : newVal)
                    }
                }
            )) {
                Text(loc("logs.all")).tag("all")
                Text(loc("logs.level.debug")).tag("debug")
                Text(loc("logs.level.info")).tag("info")
                Text(loc("logs.level.warn")).tag("warn")
                Text(loc("logs.level.error")).tag("error")
            }
            .pickerStyle(.segmented)

            // 类型过滤 - segmented style
            Picker(loc("logs.typeFilter"), selection: Binding(
                get: { viewModel.typeFilter ?? "all" },
                set: { newVal in
                    Task {
                        await viewModel.setTypeFilter(newVal == "all" ? nil : newVal)
                    }
                }
            )) {
                Text(loc("logs.all")).tag("all")
                Text(loc("logs.type.request")).tag("request")
                Text(loc("logs.type.system")).tag("system")
            }
            .pickerStyle(.segmented)

            Spacer()

            // 搜索框 - rounded style
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .foregroundColor(.secondary)
                    .font(.caption)
                TextField(loc("logs.searchPlaceholder"), text: Binding(
                    get: { viewModel.search },
                    set: { viewModel.setSearch($0) }
                ))
                .textFieldStyle(.plain)
                .font(.subheadline)
                if !viewModel.search.isEmpty {
                    Button(action: { viewModel.setSearch("") }) {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundColor(.secondary)
                            .font(.caption)
                    }
                    .buttonStyle(.borderless)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(Color(nsColor: .textBackgroundColor))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .strokeBorder(Color.secondary.opacity(0.25), lineWidth: 1)
            )
            .frame(width: 190)

            // 自动滚动按钮
            Button(action: { viewModel.autoScroll.toggle() }) {
                Image(systemName: viewModel.autoScroll ? "arrow.down.to.line.circle.fill" : "arrow.down.to.line.circle")
                    .font(.system(size: 16))
                    .foregroundColor(viewModel.autoScroll ? .accentColor : .secondary)
            }
            .buttonStyle(.borderless)
            .help(viewModel.autoScroll ? loc("logs.autoScroll.on") : loc("logs.autoScroll.off"))

            // 日志总数
            if !viewModel.allLogs.isEmpty {
                Text(loc("logs.totalCount", viewModel.totalCount))
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .monospacedDigit()
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(Color(nsColor: .controlBackgroundColor))
    }

    // MARK: - Log List

    private var logList: some View {
        Group {
            if viewModel.isLoading && viewModel.allLogs.isEmpty {
                loadingView
            } else if let error = viewModel.errorMessage, viewModel.allLogs.isEmpty {
                errorView(error)
            } else if viewModel.pagedLogs.isEmpty {
                emptyView
            } else {
                scrollableLogList
            }
        }
    }

    private var scrollableLogList: some View {
        ScrollViewReader { proxy in
            List {
                ForEach(Array(viewModel.pagedLogs.enumerated()), id: \.element.id) { index, entry in
                    logRow(entry, index: index)
                        .id(entry.id)
                        .listRowSeparator(.hidden)
                }

                // 底部哨兵元素，用于自动滚动
                Color.clear
                    .frame(height: 1)
                    .id(logListBottom)
                    .listRowSeparator(.hidden)

                // "加载更多"按钮
                if viewModel.hasMore {
                    HStack {
                        Spacer()
                        Button(action: {
                            Task { await viewModel.loadOlder() }
                        }) {
                            if viewModel.isLoadingOlder {
                                ProgressView()
                                    .scaleEffect(0.7)
                                    .frame(width: 20, height: 20)
                            }
                            Text(loc("logs.loadMore"))
                        }
                        .disabled(viewModel.isLoadingOlder)
                        Spacer()
                    }
                    .padding(.vertical, 8)
                    .listRowSeparator(.hidden)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .overlay(alignment: .bottomTrailing) {
                // 自动滚动关闭时显示"回到底部"按钮
                if !viewModel.autoScroll && viewModel.currentPage == 1 && !viewModel.pagedLogs.isEmpty {
                    Button(action: {
                        viewModel.autoScroll = true
                        withAnimation {
                            proxy.scrollTo(logListBottom, anchor: .bottom)
                        }
                    }) {
                        Image(systemName: "arrow.down.circle.fill")
                            .font(.system(size: 28))
                            .foregroundColor(.blue)
                            .background(Circle().fill(Color.white).shadow(radius: 2))
                    }
                    .buttonStyle(.borderless)
                    .padding(.trailing, 16)
                    .padding(.bottom, 12)
                }
            }
            .onChange(of: viewModel.pagedLogs.count) { _, _ in
                scrollToBottomIfNeeded(proxy: proxy)
            }
            // 切换页码时跳到底部
            .onChange(of: viewModel.currentPage) { _, _ in
                scrollToBottomIfNeeded(proxy: proxy)
            }
        }
    }

    private func scrollToBottomIfNeeded(proxy: ScrollViewProxy) {
        guard viewModel.autoScroll, viewModel.currentPage == 1 else { return }
        DispatchQueue.main.async {
            proxy.scrollTo(logListBottom, anchor: .bottom)
        }
    }

    // MARK: - Log Row

    private func logRow(_ entry: LogEntry, index: Int) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                // 时间戳 — 仅显示时间
                Text(LogsViewModel.formatTimeOnly(entry.timestamp))
                    .font(.system(.caption, design: .monospaced))
                    .foregroundColor(.secondary)

                // 级别标签 — pill shaped
                levelBadge(entry.level)

                // 类型标签
                typeBadge(entry.type)

                // 消息
                Text(entry.message)
                    .font(.system(.body))
                    .lineLimit(3)
            }

            // 详情展开
            if let details = entry.details, !details.isEmpty {
                detailsDisclosure(entry.id, details: details)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(
            index.isMultiple(of: 2)
                ? Color(nsColor: .controlBackgroundColor)
                : Color.primary.opacity(0.03)
        )
    }

    private func levelBadge(_ level: String) -> some View {
        Text(level.uppercased())
            .font(.system(.caption2, design: .monospaced))
            .fontWeight(.semibold)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(levelColor(level).opacity(0.15))
            .foregroundColor(levelColor(level))
            .clipShape(Capsule())
    }

    private func typeBadge(_ type: String) -> some View {
        Text(type)
            .font(.system(.caption2))
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(Color.secondary.opacity(0.12))
            .foregroundColor(.secondary)
            .clipShape(Capsule())
    }

    private func detailsDisclosure(_ id: Int, details: [String: AnyCodable]) -> some View {
        let isExpanded = expandedLogIds.contains(id)
        return VStack(alignment: .leading, spacing: 4) {
            Button(action: { toggleExpanded(id) }) {
                HStack(spacing: 4) {
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(.caption))
                    Text(isExpanded ? loc("logs.hideDetails") : loc("logs.showDetails"))
                        .font(.system(.caption))
                }
                .foregroundColor(.blue)
            }
            .buttonStyle(.borderless)

            if isExpanded {
                Text(LogsViewModel.formatDetails(details))
                    .font(.system(.caption, design: .monospaced))
                    .padding(8)
                    .background(Color.gray.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 4))
                    .textSelection(.enabled)
            }
        }
    }

    private func toggleExpanded(_ id: Int) {
        if expandedLogIds.contains(id) {
            expandedLogIds.remove(id)
        } else {
            expandedLogIds.insert(id)
        }
    }

    // MARK: - Level Color

    private func levelColor(_ level: String) -> Color {
        switch level {
        case "debug": return .gray
        case "info": return .blue
        case "warn": return .orange
        case "error": return .red
        default: return .secondary
        }
    }

    // MARK: - Pagination Bar

    private var paginationBar: some View {
        HStack(spacing: 16) {
            // 上一页
            Button(action: {
                viewModel.autoScroll = false
                viewModel.prevPage()
            }) {
                Image(systemName: "chevron.backward")
            }
            .disabled(viewModel.currentPage <= 1)
            .buttonStyle(.borderless)

            // 页码
            Text("\(viewModel.currentPage) / \(viewModel.totalPages)")
                .font(.system(.body, design: .monospaced))
                .foregroundColor(.secondary)
                .monospacedDigit()

            // 下一页
            Button(action: {
                viewModel.autoScroll = false
                viewModel.nextPage()
            }) {
                Image(systemName: "chevron.forward")
            }
            .disabled(viewModel.currentPage >= viewModel.totalPages)
            .buttonStyle(.borderless)

            Spacer()

            // 总数
            Text(loc("logs.totalCount", viewModel.totalCount))
                .font(.caption)
                .foregroundColor(.secondary)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }

    // MARK: - Empty / Loading / Error States

    private var emptyView: some View {
        VStack(spacing: 12) {
            Image(systemName: "doc.text.magnifyingglass")
                .font(.system(size: 36))
                .foregroundColor(.secondary)
            Text(loc("logs.empty"))
                .foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var loadingView: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text(loc("logs.loading"))
                .foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func errorView(_ message: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 36))
                .foregroundColor(.orange)
            Text(loc("logs.error"))
                .font(.headline)
            Text(message)
                .font(.caption)
                .foregroundColor(.secondary)
            Button(loc("logs.retry")) {
                Task { await viewModel.load() }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
