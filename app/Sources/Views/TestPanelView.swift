import SwiftUI

/// 独立测试面板 Sheet——从工具栏烧瓶按钮打开
struct TestPanelView: View {
    // MARK: - Form State

    @State private var providers: [Provider] = []
    @State private var selectedProviderName = ""
    @State private var selectedModelId = ""
    @State private var selectedType = "openai"
    @State private var apiKey = ""
    @State private var apiBase = ""

    // MARK: - Loading & Result State

    @State private var isLoadingProviders = false
    @State private var isTesting = false
    @State private var testResult: TestModelResult?
    @State private var errorMessage: String?

    // MARK: - Dependencies

    private let api = APIClient()

    // MARK: - Computed

    private var selectedProvider: Provider? {
        providers.first { $0.name == selectedProviderName }
    }

    private var providerModels: [ProviderModel] {
        selectedProvider?.models ?? []
    }

    private let types = ["openai", "anthropic", "openai-responses"]

    // MARK: - Body

    var body: some View {
        VStack(spacing: 0) {
            // 标题栏
            header

            Divider()

            // 表单 + 结果
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    formSection
                    sendButton
                    if isTesting {
                        testingIndicator
                    }
                    if let result = testResult {
                        resultSection(result)
                    }
                    if let error = errorMessage {
                        errorView(error)
                    }
                }
                .padding(20)
            }
        }
        .frame(width: 520, height: 560)
        .task { await loadProviders() }
    }

    // MARK: - Header

    private var header: some View {
        HStack {
            Image(systemName: "flask")
                .font(.title3)
                .foregroundColor(.accentColor)
            Text(loc("test.title"))
                .font(.headline)
            Spacer()
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
    }

    // MARK: - Form Section

    private var formSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Provider 选择器
            VStack(alignment: .leading, spacing: 4) {
                Text(loc("test.provider"))
                    .font(.caption)
                    .foregroundColor(.secondary)
                if isLoadingProviders {
                    HStack {
                        ProgressView()
                            .scaleEffect(0.6)
                        Text(loc("providers.loading"))
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                } else {
                    Picker(loc("test.selectProvider"), selection: $selectedProviderName) {
                        Text(loc("test.selectProvider")).tag("")
                        ForEach(providers, id: \.name) { provider in
                            Text(provider.name).tag(provider.name)
                        }
                    }
                    .pickerStyle(.menu)
                    .onChange(of: selectedProviderName) {
                        // 切换供应商时预填第一个模型
                        if let provider = selectedProvider {
                            selectedType = provider.type
                            apiBase = ""
                            apiKey = ""
                            if let firstModel = provider.models.first {
                                selectedModelId = firstModel.id
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }

            // Model 输入（TextField + Picker）
            VStack(alignment: .leading, spacing: 4) {
                Text(loc("test.model"))
                    .font(.caption)
                    .foregroundColor(.secondary)
                HStack(spacing: 8) {
                    TextField("model-id", text: $selectedModelId)
                        .textFieldStyle(.roundedBorder)
                    if !providerModels.isEmpty {
                        Picker("", selection: $selectedModelId) {
                            Text(loc("test.model")).tag("")
                            ForEach(providerModels, id: \.id) { model in
                                Text(model.id).tag(model.id)
                            }
                        }
                        .pickerStyle(.menu)
                        .frame(width: 40)
                        .labelsHidden()
                    }
                }
            }

            // Type 选择器
            VStack(alignment: .leading, spacing: 4) {
                Text(loc("test.type"))
                    .font(.caption)
                    .foregroundColor(.secondary)
                Picker(loc("test.type"), selection: $selectedType) {
                    ForEach(types, id: \.self) { type in
                        Text(type).tag(type)
                    }
                }
                .pickerStyle(.segmented)
                .frame(maxWidth: 300)
            }

            // API Key
            VStack(alignment: .leading, spacing: 4) {
                Text(loc("test.apiKey"))
                    .font(.caption)
                    .foregroundColor(.secondary)
                SecureField("sk-...", text: $apiKey)
                    .textFieldStyle(.roundedBorder)
            }

            // API Base
            VStack(alignment: .leading, spacing: 4) {
                Text(loc("test.apiBase"))
                    .font(.caption)
                    .foregroundColor(.secondary)
                TextField("https://api.openai.com", text: $apiBase)
                    .textFieldStyle(.roundedBorder)
            }
        }
    }

    // MARK: - Send Button

    private var sendButton: some View {
        Button(action: { Task { await sendTest() } }) {
            if isTesting {
                HStack(spacing: 6) {
                    ProgressView()
                        .scaleEffect(0.7)
                        .frame(width: 14, height: 14)
                    Text(loc("test.send"))
                }
            } else {
                Label(loc("test.send"), systemImage: "paperplane.fill")
            }
        }
        .buttonStyle(.borderedProminent)
        .disabled(isTesting || selectedModelId.trimmingCharacters(in: .whitespaces).isEmpty)
    }

    // MARK: - Testing Indicator

    private var testingIndicator: some View {
        HStack(spacing: 8) {
            ProgressView()
                .scaleEffect(0.7)
            Text(loc("providers.loading"))
                .font(.caption)
                .foregroundColor(.secondary)
        }
    }

    // MARK: - Result Section

    @ViewBuilder
    private func resultSection(_ result: TestModelResult) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Divider()

            Text(loc("test.result"))
                .font(.headline)

            // 连通状态
            HStack(spacing: 8) {
                if result.reachable {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(.green)
                    Text(loc("test.reachable"))
                        .foregroundColor(.green)
                        .fontWeight(.medium)
                } else {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundColor(.red)
                    Text(loc("test.unreachable"))
                        .foregroundColor(.red)
                        .fontWeight(.medium)
                }
            }

            // 延迟
            if let latency = result.latency {
                HStack(spacing: 4) {
                    Image(systemName: "stopwatch")
                        .font(.caption)
                        .foregroundColor(.secondary)
                    Text(loc("test.latency", latency))
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }

            // 错误信息
            if let error = result.error, !error.isEmpty {
                HStack(spacing: 4) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundColor(.red)
                    Text(error)
                        .font(.caption)
                        .foregroundColor(.red)
                }
            }

            // 请求 URL
            if let requestUrl = result.requestUrl, !requestUrl.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Request URL")
                        .font(.caption2)
                        .foregroundColor(.secondary)
                    Text(requestUrl)
                        .font(.caption)
                        .foregroundColor(.primary)
                        .lineLimit(2)
                }
            }

            // 响应状态码
            if let status = result.responseStatus {
                HStack(spacing: 4) {
                    Text("Status:")
                        .font(.caption)
                        .foregroundColor(.secondary)
                    Text("\(status)")
                        .font(.caption)
                        .fontWeight(.medium)
                        .foregroundColor(status >= 200 && status < 300 ? .green : .orange)
                }
            }

            // 原始响应 JSON
            if let responseBody = result.responseBody {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Response Body")
                        .font(.caption2)
                        .foregroundColor(.secondary)
                    ScrollView {
                        Text(formatAnyCodable(responseBody))
                            .font(.system(.caption, design: .monospaced))
                            .foregroundColor(.primary)
                            .textSelection(.enabled)
                    }
                    .frame(maxHeight: 180)
                    .padding(8)
                    .background(Color(nsColor: .textBackgroundColor))
                    .cornerRadius(6)
                    .overlay(
                        RoundedRectangle(cornerRadius: 6)
                            .stroke(Color.secondary.opacity(0.2))
                    )
                }
            }
        }
    }

    // MARK: - Error View

    private func errorView(_ error: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundColor(.red)
            Text(error)
                .font(.caption)
                .foregroundColor(.red)
        }
        .padding(10)
        .background(Color.red.opacity(0.08))
        .cornerRadius(6)
    }

    // MARK: - Actions

    private func loadProviders() async {
        isLoadingProviders = true
        do {
            let config = try await api.fetchConfig()
            providers = config.data?.providers ?? []
            if let first = providers.first {
                selectedProviderName = first.name
                selectedType = first.type
                if let firstModel = first.models.first {
                    selectedModelId = firstModel.id
                }
            }
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoadingProviders = false
    }

    private func sendTest() async {
        let modelId = selectedModelId.trimmingCharacters(in: .whitespaces)
        guard !modelId.isEmpty else { return }

        isTesting = true
        testResult = nil
        errorMessage = nil

        do {
            let result = try await api.testProvider(
                modelId: modelId,
                provider: selectedProviderName,
                apiKey: apiKey,
                apiBase: apiBase,
                type: selectedType
            )
            testResult = result
        } catch {
            testResult = TestModelResult(
                reachable: false,
                latency: nil,
                model: modelId,
                error: error.localizedDescription,
                adapterUrl: nil,
                requestUrl: nil,
                requestBody: nil,
                responseBody: nil,
                responseStatus: nil
            )
        }
        isTesting = false
    }

    // MARK: - Helpers

    /// 将 AnyCodable 格式化为可读 JSON 字符串
    private func formatAnyCodable(_ anyCodable: AnyCodable) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let encoded = try? encoder.encode(AnyCodable(anyCodable.value)),
           let jsonString = String(data: encoded, encoding: .utf8) {
            return jsonString
        }
        return "\(anyCodable.value)"
    }
}
