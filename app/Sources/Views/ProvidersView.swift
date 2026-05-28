import SwiftUI

struct ProvidersView: View {
    @State private var viewModel = ProvidersViewModel()

    var body: some View {
        VStack(spacing: 0) {
            // 搜索栏 + 新增
            toolbar

            Divider()

            // 内容区
            ZStack {
                if viewModel.isLoading && viewModel.providers.isEmpty {
                    ProgressView(loc("providers.loading"))
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if !viewModel.providers.isEmpty || !viewModel.searchText.isEmpty {
                    providerList
                } else {
                    emptyState
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .task { await viewModel.load() }
        .sheet(isPresented: $viewModel.showForm) {
            ProviderFormView(viewModel: viewModel)
        }
        .sheet(isPresented: $viewModel.showPullModelsSheet) {
            pullModelsSheetView
        }
        .alert(loc("providers.delete.title"), isPresented: $viewModel.showDeleteAlert) {
            Button(loc("action.cancel"), role: .cancel) {
                viewModel.deleteTargetName = nil
            }
            Button(loc("providers.delete.confirm"), role: .destructive) {
                Task { await viewModel.executeDelete() }
            }
        } message: {
            Text(loc("providers.delete.message", viewModel.deleteTargetName ?? ""))
        }
    }

    // MARK: - Toolbar

    private var toolbar: some View {
        HStack(spacing: 12) {
            Image(systemName: "magnifyingglass")
                .foregroundColor(.secondary)
            TextField(loc("providers.searchPlaceholder"), text: $viewModel.searchText)
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: 280)

            Spacer()

            Button(action: { viewModel.openCreateForm() }) {
                Label(loc("providers.addProvider"), systemImage: "plus")
            }
            .buttonStyle(.borderedProminent)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    // MARK: - Provider List

    private var providerList: some View {
        List {
            ForEach(viewModel.filteredProviders, id: \.name) { provider in
                providerRow(provider)
            }
        }
        .listStyle(.inset)
    }

    private func providerRow(_ provider: ProviderDetail) -> some View {
        HStack(spacing: 12) {
            // 状态 + 名称
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    providerStatusIcon(provider)
                    Text(provider.name)
                        .font(.headline)
                    typeBadge(provider.type)
                }

                // 模型列表（截断显示）
                if !provider.models.isEmpty {
                    Text(modelSummary(provider.models))
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                }
            }

            Spacer()

            // 测试状态
            testStatusView(provider)

            // 操作按钮组
            HStack(spacing: 4) {
                // 测试按钮
                Button(action: { Task { await viewModel.testProvider(provider) } }) {
                    if viewModel.testingProviderNames.contains(provider.name) {
                        ProgressView()
                            .scaleEffect(0.6)
                            .frame(width: 20, height: 20)
                    } else {
                        Image(systemName: "play.circle")
                            .help(loc("providers.testConnectivity"))
                    }
                }
                .buttonStyle(.borderless)
                .disabled(viewModel.testingProviderNames.contains(provider.name) || provider.models.isEmpty)

                // 编辑按钮
                Button(action: { viewModel.openEditForm(provider) }) {
                    Image(systemName: "pencil")
                        .help(loc("providers.edit"))
                }
                .buttonStyle(.borderless)

                // 删除按钮
                Button(action: { viewModel.confirmDelete(provider.name) }) {
                    Image(systemName: "trash")
                        .foregroundColor(.red)
                        .help(loc("providers.delete.title"))
                }
                .buttonStyle(.borderless)
            }
        }
        .padding(.vertical, 6)
    }

    // MARK: - Status Icon

    private func providerStatusIcon(_ provider: ProviderDetail) -> some View {
        if let result = viewModel.testResults[provider.name] {
            Circle()
                .fill(result.ok ? Color.green : Color.red)
                .frame(width: 8, height: 8)
        } else {
            Circle()
                .fill(Color.gray.opacity(0.4))
                .frame(width: 8, height: 8)
        }
    }

    // MARK: - Test Status

    @ViewBuilder
    private func testStatusView(_ provider: ProviderDetail) -> some View {
        if let result = viewModel.testResults[provider.name] {
            HStack(spacing: 4) {
                if result.ok, let latency = result.latency_ms {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(.green)
                        .font(.caption)
                    Text("\(latency)ms")
                        .font(.caption)
                        .foregroundColor(.green)
                } else {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundColor(.red)
                        .font(.caption)
                    Text(result.error ?? loc("providers.testFailed"))
                        .font(.caption)
                        .foregroundColor(.red)
                        .lineLimit(1)
                }
            }
        }
    }

    // MARK: - Type Badge

    private func typeBadge(_ type: String) -> some View {
        Text(type)
            .font(.caption2)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(typeBadgeColor(type).opacity(0.15))
            .foregroundColor(typeBadgeColor(type))
            .cornerRadius(4)
    }

    private func typeBadgeColor(_ type: String) -> Color {
        switch type {
        case "anthropic": return .orange
        case "openai-responses": return .purple
        default: return .blue
        }
    }

    // MARK: - Model Summary

    private func modelSummary(_ models: [ProviderModelDetail]) -> String {
        let count = models.count
        let prefix = models.prefix(3).map { $0.id }.joined(separator: ", ")
        if count > 3 {
            return "\(prefix) \(loc("providers.andMore", count - 3))"
        }
        return prefix
    }

    // MARK: - Empty State

    private var emptyState: some View {
        VStack(spacing: 16) {
            Image(systemName: "server.rack")
                .font(.system(size: 48))
                .foregroundColor(.secondary.opacity(0.5))
            Text(loc("providers.empty"))
                .font(.title3)
                .foregroundColor(.secondary)
            Text(loc("providers.emptyHint"))
                .font(.caption)
                .foregroundColor(.secondary.opacity(0.7))
            Button(action: { viewModel.openCreateForm() }) {
                Label(loc("providers.addProvider"), systemImage: "plus")
            }
            .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Pull Models Sheet

    private var pullModelsSheetView: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Text(loc("providers.pullModels.title"))
                    .font(.headline)
                Spacer()
                Button(loc("providers.pullModels.close")) {
                    viewModel.dismissPullModels()
                }
                .buttonStyle(.borderless)
            }
            .padding(16)

            Divider()

            // Content
            Group {
                if viewModel.pullModelsLoading {
                    VStack(spacing: 12) {
                        ProgressView()
                        Text(loc("providers.pullModels.loading"))
                            .foregroundColor(.secondary)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let error = viewModel.pullModelsError {
                    VStack(spacing: 12) {
                        Image(systemName: "xmark.circle")
                            .font(.title)
                            .foregroundColor(.red)
                        Text(error)
                            .foregroundColor(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .padding()
                } else if let result = viewModel.pullModelsResult {
                    VStack(alignment: .leading, spacing: 12) {
                        // 统计信息
                        HStack {
                            Text(loc("providers.pullModels.total", result.models.count))
                            Text("·")
                            Text(loc("providers.pullModels.existing", viewModel.pullModelsExistingCount))
                            Text("·")
                            Text(loc("providers.pullModels.new", viewModel.pullModelsNewItems.count))
                                .foregroundColor(.green)
                        }
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .padding(.horizontal, 16)
                        .padding(.top, 8)

                        Divider()

                        // 模型列表
                        if result.models.isEmpty {
                            Text(loc("providers.pullModels.empty"))
                                .foregroundColor(.secondary)
                                .frame(maxWidth: .infinity, alignment: .center)
                                .padding(.top, 40)
                        } else {
                            ScrollView {
                                LazyVStack(alignment: .leading, spacing: 2) {
                                    ForEach(result.models, id: \.id) { item in
                                        pullModelRow(item)
                                    }
                                }
                                .padding(.horizontal, 16)
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }

            Divider()

            // Footer
            HStack {
                Spacer()
                if viewModel.pullModelsResult != nil && !viewModel.pullModelsLoading {
                    Button(loc("providers.pullModels.importAll")) {
                        viewModel.importPullModels()
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(viewModel.pullModelsNewItems.isEmpty)
                }
            }
            .padding(12)
        }
        .frame(width: 460, height: 420)
    }

    private func pullModelRow(_ item: PullModelItem) -> some View {
        let existingIds = viewModel.pullModelsResult?.existing ?? []
        let isExisting = existingIds.contains(item.id)

        return HStack(spacing: 8) {
            Image(systemName: isExisting ? "checkmark.circle.fill" : "circle")
                .foregroundColor(isExisting ? .green : .secondary)
                .font(.caption)

            Text(item.id)
                .font(.callout)
                .strikethrough(isExisting, color: .secondary)
                .foregroundColor(isExisting ? .secondary : .primary)

            if let desc = item.description {
                Text("— \(desc)")
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .lineLimit(1)
            }

            Spacer()
        }
        .padding(.vertical, 4)
    }
}
