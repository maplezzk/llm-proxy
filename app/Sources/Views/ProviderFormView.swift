import SwiftUI

struct ProviderFormView: View {
    @Bindable var viewModel: ProvidersViewModel
    @State private var selectedPullModelIds: Set<String> = []
    @State private var pullModelSearch = ""

    private let supportedProtocolTypes: [(String, String)] = [
        ("openai", "OpenAI (Chat)"),
        ("openai-responses", "OpenAI (Responses)"),
        ("anthropic", "Anthropic"),
    ]

    /// 按搜索词过滤后的拉取模型（搜索 ID 或描述）
    private var filteredPullModels: [PullModelItem] {
        guard let result = viewModel.pullModelsResult else { return [] }
        let q = pullModelSearch.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return result.models }
        return result.models.filter {
            $0.id.lowercased().contains(q) || ($0.description?.lowercased().contains(q) ?? false)
        }
    }

    /// 对过滤结果中可勾选（非已存在）的模型批量操作
    private func setFilteredSelection(_ mode: SelectionMode) {
        let existing = Set(viewModel.pullModelsResult?.existing ?? [])
        for item in filteredPullModels where !existing.contains(item.id) {
            switch mode {
            case .all: selectedPullModelIds.insert(item.id)
            case .clear: selectedPullModelIds.remove(item.id)
            case .invert:
                if selectedPullModelIds.contains(item.id) {
                    selectedPullModelIds.remove(item.id)
                } else {
                    selectedPullModelIds.insert(item.id)
                }
            }
        }
    }

    private enum SelectionMode { case all, invert, clear }

    var body: some View {
        VStack(spacing: 0) {
            // 标题栏
            formHeader

            Divider()

            // 表单内容
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    basicFields
                    Divider()
                    modelsSection
                }
                .padding(20)
            }

            Divider()

            // 底部按钮
            formFooter
        }
        .frame(width: 520, height: 640)
        .sheet(isPresented: $viewModel.showPullModelsSheet) {
            pullModelsSheetView
        }
    }

    // MARK: - Pull Models Sheet

    private var pullModelsSheetView: some View {
        VStack(spacing: 0) {
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

                        // 搜索 + 批量选择工具栏
                        HStack(spacing: 8) {
                            HStack(spacing: 6) {
                                Image(systemName: "magnifyingglass")
                                    .font(.caption)
                                    .foregroundColor(.secondary)
                                TextField(loc("providers.pullModels.search"), text: $pullModelSearch)
                                    .textFieldStyle(.plain)
                                    .font(.callout)
                            }
                            .padding(.horizontal, 8)
                            .padding(.vertical, 5)
                            .background(RoundedRectangle(cornerRadius: 6).fill(Color.secondary.opacity(0.08)))

                            Spacer()

                            Button(loc("providers.pullModels.selectAll")) { setFilteredSelection(.all) }
                            Button(loc("providers.pullModels.invert")) { setFilteredSelection(.invert) }
                            Button(loc("providers.pullModels.clear")) { setFilteredSelection(.clear) }
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .padding(.horizontal, 16)
                        .padding(.top, 4)

                        Divider()

                        if result.models.isEmpty {
                            Text(loc("providers.pullModels.empty"))
                                .foregroundColor(.secondary)
                                .frame(maxWidth: .infinity, alignment: .center)
                                .padding(.top, 40)
                        } else {
                            ScrollView {
                                LazyVStack(alignment: .leading, spacing: 2) {
                                    ForEach(filteredPullModels, id: \.id) { item in
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

            HStack {
                Spacer()
                if viewModel.pullModelsResult != nil && !viewModel.pullModelsLoading {
                    Button(loc("providers.pullModels.importCount", selectedPullModelIds.count)) {
                        importSelectedModels()
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(selectedPullModelIds.isEmpty)
                }
            }
            .padding(12)
        }
        .frame(width: 460, height: 420)
        .onAppear {
            // 默认全选新模型，清空上次搜索
            selectedPullModelIds = Set(viewModel.pullModelsNewItems.map { $0.id })
            pullModelSearch = ""
        }
        .onChange(of: viewModel.pullModelsResult?.models.count) { _, _ in
            selectedPullModelIds = Set(viewModel.pullModelsNewItems.map { $0.id })
        }
    }

    private func importSelectedModels() {
        let existingIds = Set(viewModel.formData.models.map { $0.modelId })
        var added = 0
        for id in selectedPullModelIds {
            if !existingIds.contains(id) {
                viewModel.formData.models.append(ProviderModelFormData(modelId: id))
                added += 1
            }
        }
        viewModel.showPullModelsSheet = false
        viewModel.pullModelsResult = nil
        selectedPullModelIds = []
    }

    private func pullModelRow(_ item: PullModelItem) -> some View {
        let existingIds = viewModel.pullModelsResult?.existing ?? []
        let isExisting = existingIds.contains(item.id)
        let isSelected = selectedPullModelIds.contains(item.id)

        return Button(action: {
            if !isExisting {
                if isSelected {
                    selectedPullModelIds.remove(item.id)
                } else {
                    selectedPullModelIds.insert(item.id)
                }
            }
        }) {
            HStack(spacing: 8) {
                Image(systemName: isExisting ? "checkmark.circle.fill" : (isSelected ? "checkmark.circle.fill" : "circle"))
                    .foregroundColor(isExisting ? .green : (isSelected ? .accentColor : .secondary))
                    .font(.body)

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
        }
        .buttonStyle(.plain)
        .disabled(isExisting)
        .padding(.vertical, 4)
    }

    // MARK: - Header

    private var formHeader: some View {
        HStack {
            Text(viewModel.isEditing ? loc("providers.form.editTitle") : loc("providers.form.createTitle"))
                .font(.headline)
            Spacer()
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
    }

    // MARK: - Basic Fields

    private var basicFields: some View {
        VStack(alignment: .leading, spacing: 12) {
            // 名称
            VStack(alignment: .leading, spacing: 4) {
                Text(loc("providers.form.name")).font(.caption).foregroundColor(.secondary)
                TextField("my-provider", text: $viewModel.formData.name)
                    .textFieldStyle(.roundedBorder)
            }

            // API Key
            VStack(alignment: .leading, spacing: 4) {
                Text(loc("providers.form.apiKey")).font(.caption).foregroundColor(.secondary)
                SecureField(viewModel.isEditing ? loc("providers.form.apiKeyPlaceholderEdit") : "sk-xxx", text: $viewModel.formData.apiKey)
                    .textFieldStyle(.roundedBorder)
            }

            protocolsSection
        }
    }

    // MARK: - Protocols

    private var protocolsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(loc("providers.form.protocols")).font(.caption).foregroundColor(.secondary)
                Spacer()
            }
            Text(loc("providers.form.protocolsHint"))
                .font(.caption2)
                .foregroundColor(.secondary)

            ForEach(supportedProtocolTypes, id: \.0) { protocolType, label in
                let isSelected = viewModel.formData.protocolTypes.contains(protocolType)
                VStack(alignment: .leading, spacing: 6) {
                    Toggle(isOn: Binding(
                        get: { viewModel.formData.protocolTypes.contains(protocolType) },
                        set: { viewModel.toggleProtocol(type: protocolType, enabled: $0) }
                    )) {
                        Text(label)
                            .font(.callout)
                            .fontWeight(.medium)
                    }
                    .toggleStyle(.checkbox)

                    if isSelected {
                        TextField(loc("providers.form.apiBase"), text: Binding(
                            get: { viewModel.formData.protocols.first(where: { $0.type == protocolType })?.apiBase ?? "" },
                            set: { viewModel.updateProtocolBase(type: protocolType, apiBase: $0) }
                        ))
                        .textFieldStyle(.roundedBorder)
                        .padding(.leading, 20)
                    }
                }
                .padding(8)
                .background(isSelected ? Color.accentColor.opacity(0.08) : Color.primary.opacity(0.03))
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(isSelected ? Color.accentColor.opacity(0.35) : Color.primary.opacity(0.08), lineWidth: 1))
                .cornerRadius(6)
            }
        }
    }

    // MARK: - Models Section

    private var modelsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(loc("providers.form.models")).font(.caption).foregroundColor(.secondary)
                Spacer()
                Button(action: { viewModel.addModelRow() }) {
                    Label(loc("providers.form.addModel"), systemImage: "plus")
                        .font(.caption)
                }
                .buttonStyle(.borderless)

                Button(action: { Task { await viewModel.pullModels() } }) {
                    Label(loc("providers.form.pullModels"), systemImage: "arrow.down.circle")
                        .font(.caption)
                }
                .buttonStyle(.borderless)
                .disabled(viewModel.formData.name.trimmingCharacters(in: .whitespaces).isEmpty)
            }

            // 模型列表
            // 使用元素绑定（基于稳定的 UUID），避免按索引捕获导致的删除越界崩溃
            VStack(spacing: 8) {
                ForEach($viewModel.formData.models) { $model in
                    modelRow(model: $model)
                }
            }
        }
    }

    private func modelRow(model: Binding<ProviderModelFormData>) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                TextField(loc("providers.form.modelIdPlaceholder"), text: model.modelId)
                    .textFieldStyle(.roundedBorder)

                Spacer()

                Button(action: { viewModel.removeModelRow(id: model.wrappedValue.id) }) {
                    Image(systemName: "minus.circle")
                        .foregroundColor(.red)
                        .font(.title3)
                }
                .buttonStyle(.borderless)
            }

            // 一个模型可以同时声明多个上游协议；路由会优先选择与入站请求一致的协议。
            HStack(spacing: 6) {
                Text(loc("providers.form.modelProtocols"))
                    .font(.caption2)
                    .foregroundColor(.secondary)
                ForEach(viewModel.formData.protocolTypes, id: \.self) { protocolType in
                    Toggle(isOn: Binding(
                        get: { model.wrappedValue.protocols.contains(protocolType) },
                        set: { enabled in
                            if enabled { model.wrappedValue.protocols.insert(protocolType) }
                            else if model.wrappedValue.protocols.count > 1 { model.wrappedValue.protocols.remove(protocolType) }
                        }
                    )) {
                        Text(protocolType)
                    }
                    .toggleStyle(.button)
                    .controlSize(.mini)
                }
            }

            HStack(spacing: 8) {
                if viewModel.formData.protocolTypes.contains("anthropic") {
                    TextField(loc("providers.form.budgetTokens"), text: model.budgetTokens)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 130)
                        .help(loc("providers.form.budgetTokensHelp"))
                }

                if viewModel.formData.protocolTypes.contains("openai") || viewModel.formData.protocolTypes.contains("openai-responses") {
                    Picker("", selection: model.reasoningEffort) {
                        Text(loc("providers.form.reasoningNone")).tag("")
                        Text("Low").tag("low")
                        Text("Medium").tag("medium")
                        Text("High").tag("high")
                    }
                    .frame(width: 90)
                    .labelsHidden()
                }

                Picker("", selection: model.thinkingType) {
                    Text(loc("providers.form.thinkingTypeNone")).tag("")
                    Text("adaptive").tag("adaptive")
                    Text("auto").tag("auto")
                    Text("enabled").tag("enabled")
                    Text("disabled").tag("disabled")
                }
                .frame(width: 100)
                .labelsHidden()
                .help(loc("providers.form.thinkingTypeHelp"))

                Spacer()

                HStack(spacing: 6) {
                    Text(loc("providers.form.inputModalities"))
                        .font(.caption2)
                        .foregroundColor(.secondary)
                    ForEach(["text", "image"], id: \.self) { mod in
                        let isVisionLockedRow = mod == "image" && viewModel.isVisionModelRow(providerName: viewModel.formData.name, modelId: model.wrappedValue.modelId)
                        let isChecked = model.wrappedValue.input.contains(mod)
                        Toggle(isOn: Binding(
                            get: { model.wrappedValue.input.contains(mod) },
                            set: { newValue in
                                if isVisionLockedRow && !newValue {
                                    viewModel.errorMessage = loc("providers.form.visionImageLockedHint")
                                    return
                                }
                                if newValue { model.wrappedValue.input.insert(mod) }
                                else { model.wrappedValue.input.remove(mod) }
                                if model.wrappedValue.input.isEmpty { model.wrappedValue.input.insert("text") }
                            }
                        )) {
                            HStack(spacing: 2) {
                                Text(modalityIcon(mod)).font(.system(size: 10))
                                if isVisionLockedRow { Image(systemName: "lock.fill").font(.system(size: 8)) }
                            }
                        }
                        .toggleStyle(.button)
                        .controlSize(.mini)
                        .help(isVisionLockedRow ? loc("providers.form.visionImageLockedHint") : loc("providers.form.inputModality." + mod))
                        .overlay(isVisionLockedRow && isChecked ? RoundedRectangle(cornerRadius: 4).strokeBorder(Color.orange, lineWidth: 1) : nil)
                    }
                }
            }
        }
        .padding(8)
        .background(Color.primary.opacity(0.04))
        .cornerRadius(6)
    }

    // MARK: - Modality icon (for input modalities toggles)

    private func modalityIcon(_ mod: String) -> String {
        switch mod {
        case "text":  return "T"
        case "image": return "🖼"
        default:      return mod
        }
    }

    // MARK: - Footer

    private var formFooter: some View {
        VStack(spacing: 0) {
            // 错误提示（保存失败时显示）
            if let error = viewModel.errorMessage {
                HStack(alignment: .top, spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundColor(.red)
                        .font(.caption)
                    Text(error)
                        .font(.caption)
                        .foregroundColor(.red)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button(action: { viewModel.dismissError() }) {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundColor(.secondary)
                            .font(.caption)
                    }
                    .buttonStyle(.borderless)
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 8)
                .background(Color.red.opacity(0.08))
            }

            HStack {
                Button(loc("action.cancel")) {
                    viewModel.dismissForm()
                }
                .keyboardShortcut(.cancelAction)

                Spacer()

                Button(action: { Task { await viewModel.saveForm() } }) {
                    Text(loc("action.save"))
                        .frame(minWidth: 60)
                }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
                .disabled(viewModel.formData.name.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
        }
    }
}
