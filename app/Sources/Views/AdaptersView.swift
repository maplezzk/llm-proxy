import SwiftUI

struct AdaptersView: View {
    @State private var viewModel = AdaptersViewModel()
    @Environment(TestCoordinator.self) private var testCoordinator
    @State private var showDeleteAlert = false
    @State private var adapterToDelete: String?

    var body: some View {
        VStack(spacing: 0) {
            // 顶部操作栏
            HStack {
                Image(systemName: "magnifyingglass")
                    .foregroundColor(.secondary)
                TextField(loc("adapter.searchPlaceholder"), text: Binding(
                    get: { viewModel.search },
                    set: { viewModel.search = $0 }
                ))
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: 240)

                Spacer()

                Button(action: { viewModel.openForm() }) {
                    Label(loc("adapter.newAdapter"), systemImage: "plus")
                }
                .buttonStyle(.borderedProminent)

                Button(action: { Task { await viewModel.load() } }) {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .disabled(viewModel.isLoading)
            }
            .padding(.horizontal)
            .padding(.vertical, 10)

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
                List {
                    ForEach(viewModel.filteredAdapters, id: \.name) { adapter in
                        adapterRow(adapter)
                    }
                }
                .listStyle(.inset)
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
        .alert(loc("adapter.deleteConfirm", viewModel.testingAdapterName ?? ""), isPresented: $showDeleteAlert) {
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

    // MARK: - Adapter Row

    private func adapterRow(_ adapter: Adapter) -> some View {
        HStack(spacing: 12) {
            // 类型图标
            Image(systemName: typeIcon(for: adapter.type))
                .font(.title3)
                .foregroundColor(.accentColor)
                .frame(width: 28)

            // 名称 + 类型标签
            VStack(alignment: .leading, spacing: 4) {
                Text(adapter.name)
                    .font(.body)
                    .fontWeight(.medium)
                HStack(spacing: 6) {
                    typeBadge(adapter.type)
                    Text(loc("adapter.mappingCount", adapter.models.count))
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }

            Spacer()

            // 操作按钮
            HStack(spacing: 4) {
                // 测试按钮 → 跳转到测试 tab
                Button {
                    let firstModelId = adapter.models.first?.sourceModelId
                    testCoordinator.requestAdapterTest(adapter: adapter, firstModelId: firstModelId)
                } label: {
                    Image(systemName: "play.circle")
                }
                .buttonStyle(.borderless)
                .help(loc("adapter.test"))

                // 编辑按钮
                Button {
                    viewModel.openForm(adapter: adapter)
                } label: {
                    Image(systemName: "pencil")
                }
                .buttonStyle(.borderless)
                .help(loc("adapter.edit"))

                // 删除按钮
                Button {
                    adapterToDelete = adapter.name
                    showDeleteAlert = true
                } label: {
                    Image(systemName: "trash")
                        .foregroundColor(.red)
                }
                .buttonStyle(.borderless)
                .help(loc("adapter.delete"))
            }
        }
        .padding(.vertical, 4)
    }

    // MARK: - Helpers

    private func typeIcon(for type: String) -> String {
        switch type {
        case "anthropic": return "a.circle.fill"
        case "openai": return "o.circle.fill"
        case "openai-responses": return "r.circle.fill"
        default: return "questionmark.circle"
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
            .background(Color.accentColor.opacity(0.12))
            .cornerRadius(4)
    }
}
