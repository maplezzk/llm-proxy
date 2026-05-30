import SwiftUI

struct ProvidersView: View {
    @State private var viewModel = ProvidersViewModel()
    @Environment(TestCoordinator.self) private var testCoordinator

    var body: some View {
        VStack(spacing: 0) {
            // 顶部工具栏
            HStack(spacing: 12) {
                HStack(spacing: 6) {
                    Image(systemName: "magnifyingglass")
                        .foregroundColor(.secondary)
                        .font(.caption)
                    TextField(loc("providers.searchPlaceholder"), text: $viewModel.searchText)
                        .textFieldStyle(.plain)
                        .font(.body)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(RoundedRectangle(cornerRadius: 8).fill(Color(nsColor: .controlBackgroundColor)))
                .frame(maxWidth: 240)

                Spacer()

                Button(action: { viewModel.openCreateForm() }) {
                    Label(loc("providers.addProvider"), systemImage: "plus")
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.regular)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)

            Divider()

            // 内容区
            if viewModel.isLoading && viewModel.providers.isEmpty {
                Spacer()
                ProgressView(loc("providers.loading"))
                Spacer()
            } else if viewModel.filteredProviders.isEmpty && !viewModel.searchText.isEmpty {
                Spacer()
                Text(loc("providers.noResults"))
                    .foregroundColor(.secondary)
                Spacer()
            } else if viewModel.providers.isEmpty {
                emptyState
            } else {
                providerCards
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

    // MARK: - Card List

    private var providerCards: some View {
        ScrollView {
            LazyVStack(spacing: 1) {
                ForEach(viewModel.filteredProviders, id: \.name) { provider in
                    providerCard(provider)
                }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
        }
    }

    private func providerCard(_ provider: ProviderDetail) -> some View {
        HStack(spacing: 14) {
            // 左侧：类型图标
            Image(systemName: typeIcon(for: provider.type))
                .font(.title3)
                .foregroundColor(.white)
                .frame(width: 32, height: 32)
                .background(typeBadgeColor(provider.type), in: RoundedRectangle(cornerRadius: 7))

            // 中间：信息
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 8) {
                    Text(provider.name)
                        .font(.body)
                        .fontWeight(.medium)
                    typeBadge(provider.type)
                }

                if !provider.models.isEmpty {
                    Text(modelSummary(provider.models))
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                }
            }

            Spacer()

            // 右侧：操作按钮
            HStack(spacing: 8) {
                Button(action: { testCoordinator.requestProviderTest(provider: provider) }) {
                    Text(loc("test.title"))
                        .font(.caption)
                        .foregroundColor(.white)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(Color.green, in: Capsule())
                }
                .buttonStyle(.plain)
                .disabled(provider.models.isEmpty)

                Button(action: { viewModel.openEditForm(provider) }) {
                    Text(loc("providers.edit"))
                        .font(.caption)
                        .foregroundColor(.white)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(Color.accentColor, in: Capsule())
                }
                .buttonStyle(.plain)

                Button(action: { viewModel.confirmDelete(provider.name) }) {
                    Text(loc("providers.delete.confirm"))
                        .font(.caption)
                        .foregroundColor(.white)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(Color.red, in: Capsule())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(Color.primary.opacity(0.06), lineWidth: 1)
        )
    }

    // MARK: - Status Icon

    @ViewBuilder
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

    // MARK: - Type Badge

    private func typeBadge(_ type: String) -> some View {
        Text(type)
            .font(.caption2)
            .fontWeight(.medium)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(typeBadgeColor(type).opacity(0.12))
            .foregroundColor(typeBadgeColor(type))
            .clipShape(Capsule())
    }

    private func typeBadgeColor(_ type: String) -> Color {
        switch type {
        case "anthropic": return .orange
        case "openai-responses": return .purple
        default: return .blue
        }
    }

    private func typeIcon(for type: String) -> String {
        switch type {
        case "anthropic": return "a.circle"
        case "openai": return "o.circle"
        case "openai-responses": return "r.circle"
        default: return "questionmark.circle"
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
            Spacer()
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
            Spacer()
        }
        .frame(maxWidth: .infinity)
    }
}
