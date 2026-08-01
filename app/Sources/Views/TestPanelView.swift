import SwiftUI

/// 独立测试面板 tab——支持 Provider 和 Adapter 两种测试模式
struct TestPanelView: View {
    @Environment(TestCoordinator.self) private var coordinator

    enum TestMode: String, CaseIterable { case provider, adapter }
    @State private var mode: TestMode = .provider

    // Provider 表单
    @State private var selectedProviderName = ""
    @State private var selectedModelId = ""
    @State private var selectedType = "openai"
    @State private var apiKey = ""
    @State private var apiBase = ""
    @State private var providers: [Provider] = []

    // Adapter 表单
    @State private var adapters: [Adapter] = []
    @State private var selectedAdapterName = ""
    @State private var adapterModelId = ""
    @State private var selectedAdapterProtocol = "openai"

    // 通用
    @State private var isTesting = false
    @State private var testResult: TestModelResult?
    @State private var errorMessage: String?
    @State private var isLoadingData = false

    private let api = APIClient()
    private let types = ["openai", "anthropic", "openai-responses"]

    private var selectedProvider: Provider? { providers.first { $0.name == selectedProviderName } }
    private var selectedAdapter: Adapter? { adapters.first { $0.name == selectedAdapterName } }
    private var adapterModels: [AdapterModel] { selectedAdapter?.models ?? [] }

    var body: some View {
        VStack(spacing: 0) {
            // 标题
            header
            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    modePicker

                    if mode == .provider {
                        providerForm
                    } else {
                        adapterForm
                    }

                    sendButton

                    if isTesting { ProgressView().padding(.horizontal) }

                    if let result = testResult { resultView(result) }
                    if let msg = errorMessage { Text(msg).foregroundColor(.red).font(.caption).padding(.horizontal) }
                }
                .padding()
            }
        }
        .task { await loadData() }
        .onAppear { consumePending() }
    }

    private var header: some View {
        HStack {
            Label(loc("test.title"), systemImage: "flask")
                .font(.title2)
                .fontWeight(.semibold)
            Spacer()
        }
        .padding(.horizontal)
        .padding(.vertical, 12)
    }

    private var modePicker: some View {
        Picker("", selection: $mode) {
            ForEach(TestMode.allCases, id: \.self) { m in
                Text(m == .provider ? loc("nav.providers") : loc("nav.adapters")).tag(m)
            }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
    }

    // MARK: - Provider Form

    private var providerForm: some View {
        Group {
            Picker(loc("test.selectProvider"), selection: $selectedProviderName) {
                Text(loc("test.selectProvider")).tag("")
                ForEach(providers, id: \.name) { p in Text(p.name).tag(p.name) }
            }
            .onChange(of: selectedProviderName) { _, name in
                if let p = selectedProvider {
                    selectedType = p.supportedProtocols.first?.type ?? p.type
                    apiKey = p.api_key ?? ""
                    apiBase = p.apiBase(for: selectedType)
                    if let first = p.models.first { selectedModelId = first.id }
                }
            }

            HStack {
                TextField(loc("test.model"), text: $selectedModelId)
                    .textFieldStyle(.roundedBorder)
                if !providerModels.isEmpty {
                    Picker("", selection: $selectedModelId) {
                        ForEach(providerModels, id: \.id) { m in Text(m.id).tag(m.id) }
                    }
                }
            }

            Picker(loc("test.type"), selection: $selectedType) {
                ForEach(types, id: \.self) { t in Text(t).tag(t) }
            }
            .pickerStyle(.segmented)
            .onChange(of: selectedType) { _, type in
                guard selectedProvider != nil else { return }
                apiBase = selectedProvider?.apiBase(for: type) ?? ""
            }

            SecureField(loc("test.apiKey"), text: $apiKey).textFieldStyle(.roundedBorder)
            TextField(loc("test.apiBase"), text: $apiBase).textFieldStyle(.roundedBorder)
        }
    }

    private var providerModels: [ProviderModel] { selectedProvider?.models ?? [] }

    // MARK: - Adapter Form

    private var adapterForm: some View {
        Group {
            Picker(loc("test.selectAdapter"), selection: $selectedAdapterName) {
                Text(loc("test.selectAdapter")).tag("")
                ForEach(adapters, id: \.name) { a in Text(a.name).tag(a.name) }
            }
            .onChange(of: selectedAdapterName) { _, name in
                selectedAdapterProtocol = "openai"
                if let a = adapters.first(where: { $0.name == name }), let first = a.models.first {
                    adapterModelId = first.sourceModelId
                } else {
                    adapterModelId = ""
                }
            }

            if adapterModels.isEmpty {
                TextField(loc("test.model"), text: $adapterModelId).textFieldStyle(.roundedBorder)
            } else {
                Picker(loc("test.model"), selection: $adapterModelId) {
                    Text(loc("test.model")).tag("")
                    ForEach(adapterModels, id: \.sourceModelId) { model in
                        Text(model.sourceModelId).tag(model.sourceModelId)
                    }
                }
                .pickerStyle(.menu)
            }

            Picker(loc("test.protocol"), selection: $selectedAdapterProtocol) {
                ForEach(types, id: \.self) { type in
                    Text(type).tag(type)
                }
            }
            .pickerStyle(.segmented)
        }
    }

    // MARK: - Send

    private var sendButton: some View {
        HStack {
            Spacer()
            Button(action: { Task { await runTest() } }) {
                Label(loc("test.send"), systemImage: "play.fill")
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(isTesting || (mode == .provider ? selectedModelId.isEmpty : adapterModelId.isEmpty))
        }
    }

    // MARK: - Run

    private func runTest() async {
        isTesting = true; testResult = nil; errorMessage = nil
        do {
            if mode == .provider {
                let type = selectedType
                let key = apiKey.isEmpty ? (selectedProvider?.api_key ?? "") : apiKey
                let base = apiBase
                testResult = try await api.testProvider(modelId: selectedModelId, provider: selectedProviderName, apiKey: key, apiBase: base, type: type)
            } else {
                testResult = try await api.testAdapter(
                    name: selectedAdapterName,
                    modelId: adapterModelId,
                    protocolType: selectedAdapterProtocol
                )
            }
        } catch {
            errorMessage = error.localizedDescription
        }
        isTesting = false
    }

    // MARK: - Result

    private func resultView(_ result: TestModelResult) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label(loc("test.result"), systemImage: "list.clipboard").font(.headline)
                Spacer()
                Button(action: { copyCurl() }) {
                    Label(loc("test.copyCurl"), systemImage: "doc.on.doc")
                        .font(.caption)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
            Divider()

            HStack {
                Image(systemName: result.reachable ? "checkmark.circle.fill" : "xmark.circle.fill")
                    .foregroundColor(result.reachable ? .green : .red)
                Text(result.reachable ? loc("test.reachable") : loc("test.unreachable"))
                if let lat = result.latency { Text("· \(lat)ms").foregroundColor(.secondary) }
                Spacer()
            }

            if let reqUrl = result.requestUrl {
                Text("Request: \(reqUrl)").font(.caption).foregroundColor(.secondary)
            }
            if let status = result.responseStatus {
                Text("Status: \(status)").font(.caption).foregroundColor(.secondary)
            }

            if let body = result.responseBody {
                Divider()
                Text(responseJSON(from: body))
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(8)
                    .background(Color.primary.opacity(0.04))
                    .clipShape(RoundedRectangle(cornerRadius: 6))
            }
        }
        .padding()
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.04)))
    }

    private func responseJSON(from body: AnyCodable) -> String {
        // 后端在 responseBody 不可 JSON 化时（如上游返回 HTML 错误页）会回退为原始字符串，
        // 直接喂给 JSONSerialization.data(withJSONObject:) 会触发 NSException 导致 app 闪退。
        // JSONFormatter.pretty 内部用 isValidJSONObject 守卫，顶层非 array/dict 时降级展示原文。
        JSONFormatter.pretty(body.value)
    }

    // MARK: - Copy Curl

    private func copyCurl() {
        let curl: String
        if mode == .provider {
            let key = apiKey.isEmpty ? (selectedProvider?.api_key ?? "") : apiKey
            let base = apiBase
            curl = generateProviderCurl(type: selectedType, model: selectedModelId, apiKey: key, apiBase: base)
        } else {
            curl = generateAdapterCurl(
                model: adapterModelId,
                baseURL: APIClient.adapterAPIBaseURL(selectedAdapterName),
                protocolType: selectedAdapterProtocol
            )
        }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(curl, forType: .string)
    }

    private func generateProviderCurl(type: String, model: String, apiKey: String, apiBase: String) -> String {
        switch type {
        case "anthropic":
            return """
            curl -X POST \(apiBase)/v1/messages \\
              -H "Content-Type: application/json" \\
              -H "x-api-key: \(apiKey)" \\
              -H "anthropic-version: 2023-06-01" \\
              -d '{"model": "\(model)", "max_tokens": 100, "messages": [{"role": "user", "content": "hi"}]}'
            """
        case "openai-responses":
            return """
            curl -X POST \(apiBase)/v1/responses \\
              -H "Content-Type: application/json" \\
              -H "Authorization: Bearer \(apiKey)" \\
              -d '{"model": "\(model)", "input": "hi"}'
            """
        default: // openai
            return """
            curl -X POST \(apiBase)/v1/chat/completions \\
              -H "Content-Type: application/json" \\
              -H "Authorization: Bearer \(apiKey)" \\
              -d '{"model": "\(model)", "messages": [{"role": "user", "content": "hi"}]}'
            """
        }
    }

    private func generateAdapterCurl(model: String, baseURL: String, protocolType: String) -> String {
        switch protocolType {
        case "anthropic":
            return """
            curl -X POST \(baseURL)messages \\
              -H "Content-Type: application/json" \\
              -d '{"model": "\(model)", "max_tokens": 100, "messages": [{"role": "user", "content": "hi"}]}'
            """
        case "openai-responses":
            return """
            curl -X POST \(baseURL)responses \\
              -H "Content-Type: application/json" \\
              -d '{"model": "\(model)", "input": "hi"}'
            """
        default:
            return """
            curl -X POST \(baseURL)chat/completions \\
              -H "Content-Type: application/json" \\
              -d '{"model": "\(model)", "messages": [{"role": "user", "content": "hi"}]}'
            """
        }
    }

    // MARK: - Data Loading

    private func loadData() async {
        isLoadingData = true
        do {
            let config = try await api.fetchConfig()
            providers = config.data?.providers ?? []
            let adaptersResp = try await api.fetchAdapters()
            adapters = adaptersResp.data?.adapters ?? []
            if let selected = adapters.first(where: { $0.name == selectedAdapterName }),
               !selected.models.contains(where: { $0.sourceModelId == adapterModelId }) {
                adapterModelId = selected.models.first?.sourceModelId ?? ""
            }
        } catch { /* ignore */ }
        isLoadingData = false
    }

    private func consumePending() {
        if let p = coordinator.consumeProviderPending() {
            mode = .provider
            selectedProviderName = p.name
            selectedType = p.type
            apiKey = p.apiKey
            apiBase = p.apiBase
            if let first = p.models.first { selectedModelId = first }
        } else if let a = coordinator.consumeAdapterPending() {
            mode = .adapter
            selectedAdapterName = a.name
            adapterModelId = a.modelId
            selectedAdapterProtocol = "openai"
        }
    }
}
