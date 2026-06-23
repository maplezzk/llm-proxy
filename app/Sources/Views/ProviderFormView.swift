import SwiftUI

struct ProviderFormView: View {
    @Bindable var viewModel: ProvidersViewModel
    @State private var selectedPullModelIds: Set<String> = []

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

                        Divider()

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

            HStack {
                Spacer()
                if viewModel.pullModelsResult != nil && !viewModel.pullModelsLoading {
                    Button(loc("providers.pullModels.importAll")) {
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
            // 默认全选新模型
            selectedPullModelIds = Set(viewModel.pullModelsNewItems.map { $0.id })
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

            // 类型
            VStack(alignment: .leading, spacing: 4) {
                Text(loc("providers.form.type")).font(.caption).foregroundColor(.secondary)
                Picker("", selection: $viewModel.formData.type) {
                    Text("OpenAI").tag("openai")
                    Text("Anthropic").tag("anthropic")
                    Text("OpenAI Responses").tag("openai-responses")
                }
                .pickerStyle(.segmented)
            }

            // API Key
            VStack(alignment: .leading, spacing: 4) {
                Text(loc("providers.form.apiKey")).font(.caption).foregroundColor(.secondary)
                SecureField(viewModel.isEditing ? loc("providers.form.apiKeyPlaceholderEdit") : "sk-xxx", text: $viewModel.formData.apiKey)
                    .textFieldStyle(.roundedBorder)
            }

            // API Base
            VStack(alignment: .leading, spacing: 4) {
                Text(loc("providers.form.apiBase")).font(.caption).foregroundColor(.secondary)
                TextField("https://api.openai.com", text: $viewModel.formData.apiBase)
                    .textFieldStyle(.roundedBorder)
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
        HStack(spacing: 8) {
            // 模型 ID
            TextField(loc("providers.form.modelIdPlaceholder"), text: model.modelId)
                .textFieldStyle(.roundedBorder)
                .frame(minWidth: 120)

            // Anthropic: budget_tokens
            if viewModel.formData.type == "anthropic" {
                TextField(loc("providers.form.budgetTokens"), text: model.budgetTokens)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 80)
                    .help(loc("providers.form.budgetTokensHelp"))
            }

            // OpenAI: reasoning_effort
            if viewModel.formData.type == "openai" || viewModel.formData.type == "openai-responses" {
                Picker("", selection: model.reasoningEffort) {
                    Text(loc("providers.form.reasoningNone")).tag("")
                    Text("Low").tag("low")
                    Text("Medium").tag("medium")
                    Text("High").tag("high")
                }
                .frame(width: 90)
                .labelsHidden()
            }

            // thinking.type (对所有 provider type 生效，如 MiniMax adaptive)
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

            // 输入模态勾选（当前仅支持 text 和 image）
            HStack(spacing: 6) {
                Text(loc("providers.form.inputModalities"))
                    .font(.caption2)
                    .foregroundColor(.secondary)
                ForEach(["text", "image"], id: \.self) { mod in
                    Toggle(isOn: Binding(
                        get: { model.wrappedValue.input.contains(mod) },
                        set: { newValue in
                            if newValue { model.wrappedValue.input.insert(mod) }
                            else { model.wrappedValue.input.remove(mod) }
                            // 至少保留 text
                            if model.wrappedValue.input.isEmpty {
                                model.wrappedValue.input.insert("text")
                            }
                        }
                    )) {
                        Text(modalityIcon(mod))
                            .font(.system(size: 10))
                    }
                    .toggleStyle(.button)
                    .controlSize(.mini)
                    .help(loc("providers.form.inputModality." + mod))
                }
            }

            Spacer()

            // 删除按钮：通过 model.id 找到当前元素再删除，避免使用易过时的索引
            Button(action: { viewModel.removeModelRow(id: model.wrappedValue.id) }) {
                Image(systemName: "minus.circle")
                    .foregroundColor(.red)
                    .font(.title3)
            }
            .buttonStyle(.borderless)
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
