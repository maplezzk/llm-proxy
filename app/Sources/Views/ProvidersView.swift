import SwiftUI

struct ProvidersView: View {
    @State private var viewModel = ProvidersViewModel()
    @Environment(TestCoordinator.self) private var testCoordinator

    var body: some View {
        VStack(spacing: 0) {
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
        .searchable(text: $viewModel.searchText, prompt: loc("providers.searchPlaceholder"))
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button(action: { viewModel.openCreateForm() }) {
                    Label(loc("providers.addProvider"), systemImage: "plus")
                }
            }
        }
        .task { await viewModel.load() }
        .sheet(isPresented: $viewModel.showForm) {
            ProviderFormView(viewModel: viewModel)
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

    // MARK: - Provider List

    private var providerList: some View {
        List {
            ForEach(viewModel.filteredProviders, id: \.name) { provider in
                providerRow(provider)
            }
        }
        .listStyle(.inset(alternatesRowBackgrounds: true))
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

            // 操作按钮组
            HStack(spacing: 4) {
                Button(action: { testCoordinator.requestProviderTest(provider: provider) }) {
                    Image(systemName: "play.circle")
                        .help(loc("providers.testConnectivity"))
                }
                .buttonStyle(.borderless)
                .disabled(provider.models.isEmpty)

                Button(action: { viewModel.openEditForm(provider) }) {
                    Image(systemName: "pencil")
                        .help(loc("providers.edit"))
                }
                .buttonStyle(.borderless)

                Button(action: { viewModel.confirmDelete(provider.name) }) {
                    Image(systemName: "trash")
                        .foregroundColor(.red)
                        .help(loc("providers.delete.title"))
                }
                .buttonStyle(.borderless)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    // MARK: - Status Icon

    private func providerStatusIcon(_ provider: ProviderDetail) -> some View {
        if let result = viewModel.testResults[provider.name] {
            Circle()
                .fill(result.reachable ? Color.green : Color.red)
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
                if result.reachable, let latency = result.latency {
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

}
