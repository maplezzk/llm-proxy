import SwiftUI

struct AdapterFormView: View {
    @Environment(AdaptersViewModel.self) private var viewModel

    private let adapterTypes = [
        ("anthropic", "Anthropic"),
        ("openai", "OpenAI"),
        ("openai-responses", "OpenAI Responses"),
    ]

    var body: some View {
        @Bindable var vm = viewModel

        VStack(spacing: 0) {
            // 标题栏
            HStack {
                Text(vm.editingAdapter != nil ? loc("adapter.editTitle") : loc("adapter.newTitle"))
                    .font(.headline)
                Spacer()
            }
            .padding()

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    // 名称
                    VStack(alignment: .leading, spacing: 4) {
                        Text(loc("adapter.name")).font(.caption).foregroundColor(.secondary)
                        TextField(loc("adapter.namePlaceholder"), text: $vm.formName)
                            .textFieldStyle(.roundedBorder)
                    }

                    // 类型
                    VStack(alignment: .leading, spacing: 4) {
                        Text(loc("adapter.type")).font(.caption).foregroundColor(.secondary)
                        Picker("", selection: $vm.formType) {
                            ForEach(adapterTypes, id: \.0) { type in
                                Text(type.1).tag(type.0)
                            }
                        }
                        .pickerStyle(.segmented)
                    }

                    // 模型映射
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text(loc("adapter.modelMappings")).font(.caption).foregroundColor(.secondary)
                            Spacer()
                            Button(action: { vm.addMappingRow() }) {
                                Label(loc("adapter.addMapping"), systemImage: "plus")
                                    .font(.caption)
                            }
                            .buttonStyle(.borderless)
                        }

                        // 一键导入供应商模型
                        HStack(spacing: 8) {
                            Picker("", selection: $vm.bulkImportProvider) {
                                Text(loc("adapter.selectProvider")).tag("")
                                ForEach(vm.providers, id: \.name) { p in
                                    Text(p.name).tag(p.name)
                                }
                            }
                            .pickerStyle(.menu)
                            .labelsHidden()
                            .frame(maxWidth: 180)

                            Button(action: { vm.bulkImportModels() }) {
                                Text(loc("adapter.importFromProvider"))
                                    .font(.caption)
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                            .disabled(vm.bulkImportProvider.isEmpty)
                        }

                        ForEach(Array(vm.formMappings.enumerated()), id: \.element.id) { index, _ in
                            mappingRow(index: index)
                        }
                    }
                }
                .padding()
            }

            Divider()

            // 错误提示
            if let error = vm.error {
                Text(error)
                    .font(.caption)
                    .foregroundColor(.red)
                    .padding(.horizontal)
                    .padding(.top, 8)
            }

            // 底部按钮
            HStack {
                Spacer()
                Button(loc("action.cancel")) {
                    vm.closeForm()
                }
                .keyboardShortcut(.cancelAction)

                Button(loc("action.save")) {
                    Task { await vm.save() }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(vm.formName.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .padding()
        }
        .frame(width: 560, height: 480)
    }

    // MARK: - Mapping Row

    private func mappingRow(index: Int) -> some View {
        @Bindable var vm = viewModel

        return HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(loc("adapter.sourceModelId")).font(.caption2).foregroundColor(.secondary)
                TextField("gpt-4", text: Binding(
                    get: { index < vm.formMappings.count ? vm.formMappings[index].sourceModelId : "" },
                    set: { if index < vm.formMappings.count { vm.formMappings[index].sourceModelId = $0 } }
                ))
                .textFieldStyle(.roundedBorder)
            }
            .frame(minWidth: 120)

            VStack(alignment: .leading, spacing: 2) {
                Text(loc("adapter.provider")).font(.caption2).foregroundColor(.secondary)
                Picker("", selection: Binding(
                    get: { index < vm.formMappings.count ? vm.formMappings[index].provider : "" },
                    set: { newVal in
                        guard index < vm.formMappings.count else { return }
                        vm.formMappings[index].provider = newVal
                        vm.onProviderChanged(at: index)
                    }
                )) {
                    Text(loc("adapter.selectProvider")).tag("")
                    ForEach(viewModel.providers, id: \.name) { p in
                        Text(p.name).tag(p.name)
                    }
                }
                .pickerStyle(.menu)
                .frame(maxWidth: .infinity)
            }
            .frame(minWidth: 140)

            VStack(alignment: .leading, spacing: 2) {
                Text(loc("adapter.targetModelId")).font(.caption2).foregroundColor(.secondary)
                let providerName = index < vm.formMappings.count ? vm.formMappings[index].provider : ""
                let modelOptions = viewModel.providerModels(for: providerName)

                if modelOptions.isEmpty {
                    TextField("claude-sonnet-4", text: Binding(
                        get: { index < vm.formMappings.count ? vm.formMappings[index].targetModelId : "" },
                        set: { if index < vm.formMappings.count { vm.formMappings[index].targetModelId = $0 } }
                    ))
                    .textFieldStyle(.roundedBorder)
                } else {
                    Picker("", selection: Binding(
                        get: { index < vm.formMappings.count ? vm.formMappings[index].targetModelId : "" },
                        set: { if index < vm.formMappings.count { vm.formMappings[index].targetModelId = $0 } }
                    )) {
                        Text(loc("adapter.selectModel")).tag("")
                        ForEach(modelOptions, id: \.self) { m in
                            Text(m).tag(m)
                        }
                    }
                    .pickerStyle(.menu)
                    .frame(maxWidth: .infinity)
                }
            }
            .frame(minWidth: 140)

            Button(action: { vm.removeMappingRow(at: index) }) {
                Image(systemName: "minus.circle.fill")
                    .foregroundColor(.red)
                    .font(.title3)
            }
            .buttonStyle(.plain)
            .padding(.top, 16)
        }
        .padding(8)
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.5))
        .cornerRadius(6)
    }
}
