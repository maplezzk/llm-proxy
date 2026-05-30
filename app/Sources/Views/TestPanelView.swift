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

    // 通用
    @State private var isTesting = false
    @State private var testResult: TestModelResult?
    @State private var errorMessage: String?
    @State private var isLoadingData = false

    private let api = APIClient()
    private let types = ["openai", "anthropic", "openai-responses"]

    private var selectedProvider: Provider? { providers.first { $0.name == selectedProviderName } }
    private var selectedAdapter: Adapter? { adapters.first { $0.name == selectedAdapterName } }

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
                    selectedType = p.type
                    apiKey = p.api_key ?? ""
                    apiBase = p.api_base ?? ""
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

            SecureField(loc("test.apiKey"), text: $apiKey).textFieldStyle(.roundedBorder)
            TextField(loc("test.apiBase"), text: $apiBase).textFieldStyle(.roundedBorder)
        }
    }

    private var providerModels: [ProviderModel] { selectedProvider?.models ?? [] }

    // MARK: - Adapter Form

    private var adapterForm: some View {
        Group {
            Picker(loc("test.selectProvider"), selection: $selectedAdapterName) {
                Text(loc("test.selectProvider")).tag("")
                ForEach(adapters, id: \.name) { a in Text(a.name).tag(a.name) }
            }
            .onChange(of: selectedAdapterName) { _, _ in
                if let a = selectedAdapter, let first = a.models.first {
                    adapterModelId = first.sourceModelId
                }
            }

            TextField(loc("test.model"), text: $adapterModelId).textFieldStyle(.roundedBorder)
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
                let base = apiBase.isEmpty ? (selectedProvider?.api_base ?? "") : apiBase
                testResult = try await api.testProvider(modelId: selectedModelId, provider: selectedProviderName, apiKey: key, apiBase: base, type: type)
            } else {
                testResult = try await api.testAdapter(name: selectedAdapterName, modelId: adapterModelId)
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
        guard let data = try? JSONSerialization.data(withJSONObject: body.value, options: [.prettyPrinted, .sortedKeys]),
              let str = String(data: data, encoding: .utf8) else { return "\(body.value)" }
        return str
    }

    // MARK: - Copy Curl

    private func copyCurl() {
        let curl: String
        if mode == .provider {
            let key = apiKey.isEmpty ? (selectedProvider?.api_key ?? "") : apiKey
            let base = apiBase.isEmpty ? (selectedProvider?.api_base ?? "") : apiBase
            curl = generateProviderCurl(type: selectedType, model: selectedModelId, apiKey: key, apiBase: base)
        } else {
            let port = APIClient.storedPort()
            curl = generateAdapterCurl(adapterName: selectedAdapterName, model: adapterModelId, port: port)
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

    private func generateAdapterCurl(adapterName: String, model: String, port: Int) -> String {
        return """
        curl -X POST http://127.0.0.1:\(port)/\(adapterName)/v1/chat/completions \\
          -H "Content-Type: application/json" \\
          -d '{"model": "\(model)", "messages": [{"role": "user", "content": "hi"}]}'
        """
    }

    // MARK: - Data Loading

    private func loadData() async {
        isLoadingData = true
        do {
            let config = try await api.fetchConfig()
            providers = config.data?.providers ?? []
            let adaptersResp = try await api.fetchAdapters()
            adapters = adaptersResp.data?.adapters ?? []
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
        }
    }
}
