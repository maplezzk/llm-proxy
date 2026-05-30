import SwiftUI

struct AdaptersView: View {
    @State private var viewModel = AdaptersViewModel()
    @Environment(TestCoordinator.self) private var testCoordinator
    @State private var showDeleteAlert = false
    @State private var adapterToDelete: String?
    @State private var port: Int = APIClient.storedPort()

    var body: some View {
        VStack(spacing: 0) {
            // 顶部工具栏
            HStack(spacing: 12) {
                HStack(spacing: 6) {
                    Image(systemName: "magnifyingglass")
                        .foregroundColor(.secondary)
                        .font(.caption)
                    TextField(loc("adapter.searchPlaceholder"), text: Binding(
                        get: { viewModel.search },
                        set: { viewModel.search = $0 }
                    ))
                    .textFieldStyle(.plain)
                    .font(.body)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(RoundedRectangle(cornerRadius: 8).fill(Color(nsColor: .controlBackgroundColor)))
                .frame(maxWidth: 240)

                Spacer()

                Button(action: { viewModel.openForm() }) {
                    Label(loc("adapter.newAdapter"), systemImage: "plus")
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.regular)

                Button(action: { Task { await viewModel.load() } }) {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .disabled(viewModel.isLoading)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)

            Divider()

            // 内容区
            if viewModel.isLoading && viewModel.adapters.isEmpty {
                Spacer()
                ProgressView()
                    .scaleEffect(0.8)
                Spacer()
            } else if let error = viewModel.error, viewModel.adapters.isEmpty {
                Spacer()
                VStack(spacing: 12) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.largeTitle)
                        .foregroundColor(.secondary)
                    Text(error)
                        .foregroundColor(.secondary)
                    Button(loc("action.retry")) {
                        Task { await viewModel.load() }
                    }
                }
                Spacer()
            } else if viewModel.filteredAdapters.isEmpty {
                Spacer()
                VStack(spacing: 12) {
                    Image(systemName: "arrow.triangle.branch")
                        .font(.largeTitle)
                        .foregroundColor(.secondary)
                    Text(viewModel.search.isEmpty ? loc("adapter.empty") : loc("adapter.noResults"))
                        .foregroundColor(.secondary)
                }
                Spacer()
            } else {
                adapterCards
            }
        }
        .onAppear {
            Task { await viewModel.load() }
        }
        .sheet(isPresented: Binding(
            get: { viewModel.showForm },
            set: { if !$0 { viewModel.closeForm() } }
        )) {
            AdapterFormView()
                .environment(viewModel)
        }
        .alert(loc("adapter.deleteConfirm", adapterToDelete ?? ""), isPresented: $showDeleteAlert) {
            Button(loc("action.cancel"), role: .cancel) {
                adapterToDelete = nil
            }
            Button(loc("adapter.delete"), role: .destructive) {
                if let name = adapterToDelete {
                    Task { await viewModel.deleteAdapter(name) }
                }
                adapterToDelete = nil
            }
        }
    }

    // MARK: - Card List

    private var adapterCards: some View {
        ScrollView {
            LazyVStack(spacing: 1) {
                ForEach(viewModel.filteredAdapters, id: \.name) { adapter in
                    adapterCard(adapter)
                }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
        }
    }

    private func adapterCard(_ adapter: Adapter) -> some View {
        HStack(spacing: 14) {
            // 类型图标
            Image(systemName: typeIcon(for: adapter.type))
                .font(.title3)
                .foregroundColor(.white)
                .frame(width: 32, height: 32)
                .background(typeIconColor(for: adapter.type), in: RoundedRectangle(cornerRadius: 7))

            // 信息
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(adapter.name)
                        .font(.body)
                        .fontWeight(.medium)
                    typeBadge(adapter.type)
                    Text(loc("adapter.mappingCount", adapter.models.count))
                        .font(.caption)
                        .foregroundColor(.secondary)
                }

                Text(adapterURL(adapter))
                    .font(.system(.caption, design: .monospaced))
                    .foregroundColor(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }

            Spacer()

            // 操作按钮
            HStack(spacing: 6) {
                Button {
                    let firstModelId = adapter.models.first?.sourceModelId
                    testCoordinator.requestAdapterTest(adapter: adapter, firstModelId: firstModelId)
                } label: {
                    Image(systemName: "bolt.horizontal")
                        .font(.system(size: 13))
                        .foregroundColor(.secondary)
                }
                .buttonStyle(.borderless)
                .help(loc("adapter.test"))

                Button {
                    viewModel.openForm(adapter: adapter)
                } label: {
                    Image(systemName: "square.and.pencil")
                        .font(.system(size: 13))
                        .foregroundColor(.secondary)
                }
                .buttonStyle(.borderless)
                .help(loc("adapter.edit"))

                Button {
                    adapterToDelete = adapter.name
                    showDeleteAlert = true
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(.secondary)
                }
                .buttonStyle(.borderless)
                .help(loc("adapter.delete"))
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

    // MARK: - Helpers

    private func adapterURL(_ adapter: Adapter) -> String {
        let endpoint: String = {
            switch adapter.type {
            case "anthropic": return "messages"
            case "openai-responses": return "responses"
            default: return "chat/completions"
            }
        }()
        return "http://127.0.0.1:\(port)/\(adapter.name)/v1/\(endpoint)"
    }

    private func typeIcon(for type: String) -> String {
        switch type {
        case "anthropic": return "a.circle"
        case "openai": return "o.circle"
        case "openai-responses": return "r.circle"
        default: return "questionmark.circle"
        }
    }

    private func typeIconColor(for type: String) -> Color {
        switch type {
        case "anthropic": return .orange
        case "openai": return .blue
        case "openai-responses": return .purple
        default: return .gray
        }
    }

    private func typeBadge(_ type: String) -> some View {
        let label: String = {
            switch type {
            case "anthropic": return "Anthropic"
            case "openai": return "OpenAI"
            case "openai-responses": return "Responses"
            default: return type
            }
        }()
        return Text(label)
            .font(.caption2)
            .fontWeight(.medium)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(typeIconColor(for: type).opacity(0.12))
            .foregroundColor(typeIconColor(for: type))
            .clipShape(Capsule())
    }
}
