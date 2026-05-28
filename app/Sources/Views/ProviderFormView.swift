import SwiftUI

struct ProviderFormView: View {
    @Bindable var viewModel: ProvidersViewModel

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
        .frame(width: 520, height: 580)
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
            VStack(spacing: 8) {
                ForEach(viewModel.formData.models.indices, id: \.self) { index in
                    modelRow(index: index)
                }
            }
        }
    }

    private func modelRow(index: Int) -> some View {
        HStack(spacing: 8) {
            // 模型 ID
            TextField(loc("providers.form.modelIdPlaceholder"), text: $viewModel.formData.models[index].modelId)
                .textFieldStyle(.roundedBorder)
                .frame(minWidth: 120)

            // Anthropic: budget_tokens
            if viewModel.formData.type == "anthropic" {
                TextField(loc("providers.form.budgetTokens"), text: $viewModel.formData.models[index].budgetTokens)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 80)
                    .help(loc("providers.form.budgetTokensHelp"))
            }

            // OpenAI: reasoning_effort
            if viewModel.formData.type == "openai" || viewModel.formData.type == "openai-responses" {
                Picker("", selection: $viewModel.formData.models[index].reasoningEffort) {
                    Text(loc("providers.form.reasoningNone")).tag("")
                    Text("Low").tag("low")
                    Text("Medium").tag("medium")
                    Text("High").tag("high")
                }
                .frame(width: 90)
                .labelsHidden()
            }

            Spacer()

            // 删除按钮
            Button(action: { viewModel.removeModelRow(at: index) }) {
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
