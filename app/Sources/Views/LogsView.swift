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
        .task {
            await viewModel.load()
            await viewModel.fetchLogLevel()
            viewModel.startPolling()
        }
        .onDisappear {
            viewModel.stopPolling()
        }
    }

    // MARK: - Filter Bar

    private var filterBar: some View {
        HStack(spacing: 10) {
            Text(loc("logs.filter.level"))
                .font(.caption)
                .foregroundColor(.secondary)
            Picker("", selection: Binding(
                get: { viewModel.levelFilter ?? "all" },
                set: { newVal in
                    Task { await viewModel.setLevelFilter(newVal == "all" ? nil : newVal) }
                }
            )) {
                Text(loc("logs.all")).tag("all")
                Text(loc("logs.level.debug")).tag("debug")
                Text(loc("logs.level.info")).tag("info")
                Text(loc("logs.level.warn")).tag("warn")
                Text(loc("logs.level.error")).tag("error")
            }
            .pickerStyle(.menu)
            .labelsHidden()

            Text(loc("logs.filter.type"))
                .font(.caption)
                .foregroundColor(.secondary)
            Picker("", selection: Binding(
                get: { viewModel.typeFilter ?? "all" },
                set: { newVal in
                    Task { await viewModel.setTypeFilter(newVal == "all" ? nil : newVal) }
                }
            )) {
                Text(loc("logs.all")).tag("all")
                Text(loc("logs.type.request")).tag("request")
                Text(loc("logs.type.system")).tag("system")
            }
            .pickerStyle(.menu)
            .labelsHidden()

            Spacer()

            Picker("", selection: Binding(
                get: { viewModel.logLevel },
                set: { newLevel in
                    Task { await viewModel.setLogLevel(newLevel) }
                }
            )) {
                Text("debug").tag("debug")
                Text("info").tag("info")
                Text("warn").tag("warn")
                Text("error").tag("error")
            }
            .pickerStyle(.menu)
            .labelsHidden()

            Button(action: { viewModel.autoScroll.toggle() }) {
                Image(systemName: viewModel.autoScroll ? "arrow.down.to.line.circle.fill" : "arrow.down.to.line.circle")
                    .font(.system(size: 14))
                    .foregroundColor(viewModel.autoScroll ? .accentColor : .secondary)
            }
            .buttonStyle(.borderless)
            .help(viewModel.autoScroll ? loc("logs.autoScroll.on") : loc("logs.autoScroll.off"))

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
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(
                RoundedRectangle(cornerRadius: 6)
                    .fill(Color(nsColor: .textBackgroundColor))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 6)
                    .strokeBorder(Color.secondary.opacity(0.25), lineWidth: 1)
            )
            .frame(maxWidth: 160)

            if !viewModel.allLogs.isEmpty {
                Text(loc("logs.totalCount", viewModel.totalCount))
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .monospacedDigit()
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
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
                        .listRowInsets(EdgeInsets())
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
        let hasDetails = entry.details != nil && !(entry.details?.isEmpty ?? true)
        let isExpanded = expandedLogIds.contains(entry.id)

        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text(LogsViewModel.formatTimeOnly(entry.timestamp))
                    .font(.system(.caption, design: .monospaced))
                    .foregroundColor(.secondary)
                    .frame(width: 64, alignment: .leading)

                levelBadge(entry.level)

                typeBadge(entry.type)

                Text(entry.message)
                    .font(.system(.subheadline))
                    .lineLimit(isExpanded ? nil : 2)
                    .frame(maxWidth: .infinity, alignment: .leading)

                if hasDetails {
                    Button(action: { toggleExpanded(entry.id) }) {
                        Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                            .font(.system(size: 10, weight: .medium))
                            .foregroundColor(.secondary)
                            .frame(width: 16, height: 16)
                    }
                    .buttonStyle(.borderless)
                }
            }

            // 展开的详情
            if isExpanded, let details = entry.details {
                Text(LogsViewModel.formatDetails(details))
                    .font(.system(.caption, design: .monospaced))
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.gray.opacity(0.06))
                    .clipShape(RoundedRectangle(cornerRadius: 4))
                    .textSelection(.enabled)
                    .padding(.top, 4)
                    .padding(.leading, 72)  // 对齐时间戳+标签之后
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            index.isMultiple(of: 2)
                ? Color(nsColor: .controlBackgroundColor)
                : Color.clear
        )
    }

    private func levelBadge(_ level: String) -> some View {
        Text(level.uppercased())
            .font(.system(.caption2, design: .monospaced))
            .fontWeight(.semibold)
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(levelColor(level).opacity(0.15))
            .foregroundColor(levelColor(level))
            .clipShape(Capsule())
    }

    private func typeBadge(_ type: String) -> some View {
        Text(type)
            .font(.system(.caption2))
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(Color.secondary.opacity(0.12))
            .foregroundColor(.secondary)
            .clipShape(Capsule())
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
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
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
