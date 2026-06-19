import SwiftUI

/// 设置页面——侧边栏独立 tab，完整详情区域展示
struct SettingsView: View {
    @State private var port: String = ""
    @State private var originalPort: Int?
    @State private var hasProxyKey: Bool = false
    @State private var proxyKeyInput: String = ""
    @State private var selectedLang: String = currentLang()
    @State private var showProxyKeySheet: Bool = false
    @State private var showVisionSheet: Bool = false
    @State private var visionConfig: VisionConfig?
    @State private var visionProvider: String = ""
    @State private var visionModel: String = ""
    @State private var visionPrompt: String = ""
    @State private var visionProviders: [ProviderDetail] = []
    @State private var isReloading: Bool = false
    @State private var toastMessage: String?
    @State private var toastType: String = "info"

    private let api = APIClient()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                // 标题
                HStack {
                    Label(loc("settings.title"), systemImage: "gearshape")
                        .font(.title2)
                        .fontWeight(.semibold)
                    Spacer()
                }
                .padding(.horizontal, 24)
                .padding(.top, 20)
                .padding(.bottom, 16)

                // Toast
                if let toast = toastMessage {
                    HStack(spacing: 6) {
                        Image(systemName: toastType == "success" ? "checkmark.circle.fill" : "xmark.circle.fill")
                            .foregroundColor(toastType == "success" ? .green : .red)
                        Text(toast)
                            .font(.callout)
                    }
                    .padding(.horizontal, 24)
                    .padding(.bottom, 12)
                }

                // 端口
                settingsSection {
                    settingsRow(
                        icon: "network",
                        iconColor: .blue,
                        title: loc("settings.port"),
                        subtitle: port.isEmpty ? loc("settings.notSet") : port
                    ) {
                        HStack(spacing: 8) {
                            TextField(loc("settings.portPlaceholder"), text: $port)
                                .textFieldStyle(.roundedBorder)
                                .frame(width: 100)
                                .onSubmit { Task { await savePort() } }
                            Button(loc("action.save")) {
                                Task { await savePort() }
                            }
                            .buttonStyle(.borderedProminent)
                            .controlSize(.small)
                        }
                    }
                }

                Divider().padding(.horizontal, 24)

                // 代理密钥
                settingsSection {
                    settingsRow(
                        icon: "key",
                        iconColor: .orange,
                        title: loc("settings.proxyKey"),
                        subtitle: hasProxyKey ? loc("settings.set") : loc("settings.notSet")
                    ) {
                        HStack(spacing: 8) {
                            Button(loc("settings.set")) {
                                showProxyKeySheet = true
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)

                            if hasProxyKey {
                                Button(loc("settings.remove"), role: .destructive) {
                                    Task { await removeProxyKey() }
                                }
                                .buttonStyle(.bordered)
                                .controlSize(.small)
                            }
                        }
                    }
                }

                Divider().padding(.horizontal, 24)

                // 外挂识图
                settingsSection {
                    settingsRow(
                        icon: "eye",
                        iconColor: .pink,
                        title: loc("settings.vision"),
                        subtitle: visionSubtitle
                    ) {
                        HStack(spacing: 8) {
                            // 按钮文字：未设置→"设置"；已设置→"编辑"（避免与状态文案“已设置”混淆）
                            Button(visionConfig == nil ? loc("settings.visionSetup") : loc("settings.visionEdit")) {
                                showVisionSheet = true
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)

                            if visionConfig != nil {
                                Button(loc("settings.remove"), role: .destructive) {
                                    Task { await removeVision() }
                                }
                                .buttonStyle(.bordered)
                                .controlSize(.small)
                            }
                        }
                    }
                }

                Divider().padding(.horizontal, 24)

                // 自动检查更新
                settingsSection {
                    AutoUpdateToggleRow()
                }

                Divider().padding(.horizontal, 24)

                // 语言
                settingsSection {
                    settingsRow(
                        icon: "globe",
                        iconColor: .purple,
                        title: loc("action.language"),
                        subtitle: selectedLang == "zh" ? "中文" : "English"
                    ) {
                        Picker("", selection: $selectedLang) {
                            Text("中文").tag("zh")
                            Text("English").tag("en")
                        }
                        .pickerStyle(.segmented)
                        .labelsHidden()
                        .frame(width: 160)
                        .onChange(of: selectedLang) { _, newLang in
                            switchLang(newLang)
                            NotificationCenter.default.post(name: .configDidChange, object: nil)
                        }
                    }
                }

                Divider().padding(.horizontal, 24)

                // 配置重载
                settingsSection {
                    HStack(spacing: 12) {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 14, weight: .medium))
                            .foregroundColor(.white)
                            .frame(width: 30, height: 30)
                            .background(Color.green, in: RoundedRectangle(cornerRadius: 7))
                        Text(loc("action.reloadConfig"))
                            .font(.body)
                        Spacer()
                        if isReloading {
                            ProgressView()
                                .scaleEffect(0.7)
                                .frame(width: 20, height: 20)
                        }
                        Button(loc("action.reloadConfig")) {
                            Task { await reloadConfig() }
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                        .disabled(isReloading)
                    }
                    .padding(.horizontal, 24)
                    .padding(.vertical, 14)
                }

                Spacer(minLength: 40)
            }
        }
        .sheet(isPresented: $showProxyKeySheet) {
            proxyKeySheet
        }
        .sheet(isPresented: $showVisionSheet) {
            visionSheet
        }
        .task {
            await loadSettings()
        }
    }

    // MARK: - Layout Helpers

    private func settingsSection<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            content()
        }
    }

    private func settingsRow<Controls: View>(
        icon: String,
        iconColor: Color = .accentColor,
        title: String,
        subtitle: String,
        @ViewBuilder controls: () -> Controls
    ) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 14, weight: .medium))
                .foregroundColor(.white)
                .frame(width: 30, height: 30)
                .background(iconColor, in: RoundedRectangle(cornerRadius: 7))

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.body)
                Text(subtitle)
                    .font(.caption)
                    .foregroundColor(.secondary)
            }

            Spacer()

            controls()
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 14)
    }

    // MARK: - Auto Update

    private struct AutoUpdateToggleRow: View {
        @AppStorage("llm-proxy-auto-update-enabled") private var autoUpdateEnabled: Bool = true

        var body: some View {
            HStack(spacing: 12) {
                Image(systemName: "arrow.triangle.2.circlepath")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundColor(.white)
                    .frame(width: 30, height: 30)
                    .background(Color.teal, in: RoundedRectangle(cornerRadius: 7))

                VStack(alignment: .leading, spacing: 2) {
                    Text(loc("settings.autoUpdate"))
                        .font(.body)
                    Text(autoUpdateEnabled ? loc("settings.autoUpdateDesc") : loc("settings.autoUpdate"))
                        .font(.caption)
                        .foregroundColor(.secondary)
                }

                Spacer()

                Toggle("", isOn: $autoUpdateEnabled)
                    .toggleStyle(.switch)
                    .labelsHidden()
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 14)
        }
    }

    // MARK: - Vision Subtitle

    private var visionSubtitle: String {
        guard let v = visionConfig else { return loc("settings.notSet") }
        return "\(v.provider) / \(v.model)"
    }

    /// 默认识图提示词（与 src/proxy/vision.ts 中的 DEFAULT_VISION_PROMPT 保持一致）
    private let defaultVisionPrompt = "请详细描述这张图片的内容，包括其中的文字、物体、场景、颜色等关键信息。"

    // MARK: - Load

    private func loadSettings() async {
        do {
            if let p = try await api.fetchPort() {
                originalPort = p
                port = String(p)
            }
        } catch {}
        do {
            hasProxyKey = try await api.fetchProxyKey()
        } catch {}
        do {
            visionConfig = try await api.fetchVision()
        } catch {}
        do {
            visionProviders = try await api.fetchProviders()
        } catch {}
    }

    // MARK: - Port

    private func savePort() async {
        guard let portNum = Int(port), portNum >= 1, portNum <= 65535 else {
            showToast(loc("settings.portInvalid"), type: "error")
            return
        }
        do {
            try await api.setPort(portNum)
            api.updatePort(portNum)
            originalPort = portNum
            showToast(loc("settings.portSaved"), type: "success")
            NotificationCenter.default.post(name: .configDidChange, object: nil)
        } catch {
            showToast(error.localizedDescription, type: "error")
        }
    }

    // MARK: - Proxy Key

    private var proxyKeySheet: some View {
        VStack(spacing: 0) {
            HStack {
                Text(loc("settings.proxyKey")).font(.headline)
                Spacer()
            }
            .padding()

            Divider()

            VStack(spacing: 16) {
                SecureField(loc("settings.proxyKeyPlaceholder"), text: $proxyKeyInput)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 280)
            }
            .padding(20)

            if let toast = toastMessage {
                Text(toast)
                    .font(.caption)
                    .foregroundColor(toastType == "success" ? .green : .red)
                    .padding(.horizontal)
            }

            Divider()

            HStack {
                Spacer()
                Button(loc("action.cancel")) { showProxyKeySheet = false }
                    .keyboardShortcut(.cancelAction)
                Button(loc("action.save")) {
                    Task { await saveProxyKey() }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(proxyKeyInput.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .padding()
        }
        .frame(width: 340, height: 180)
    }

    private func saveProxyKey() async {
        do {
            try await api.setProxyKey(proxyKeyInput)
            hasProxyKey = true
            showToast(loc("settings.proxyKeySaved"), type: "success")
            proxyKeyInput = ""
            NotificationCenter.default.post(name: .configDidChange, object: nil)
        } catch {
            showToast(error.localizedDescription, type: "error")
        }
    }

    private func removeProxyKey() async {
        do {
            try await api.setProxyKey(nil)
            hasProxyKey = false
            showToast(loc("settings.proxyKeyRemoved"), type: "success")
            proxyKeyInput = ""
            NotificationCenter.default.post(name: .configDidChange, object: nil)
        } catch {
            showToast(error.localizedDescription, type: "error")
        }
    }

    // MARK: - Vision

    private var visionSheet: some View {
        let visionCapableProviders = visionProviders.filter { p in
            p.models.contains { ($0.input ?? []).contains("image") }
        }
        let modelsForSelectedProvider: [ProviderModelDetail] = {
            guard let p = visionCapableProviders.first(where: { $0.name == visionProvider }) else { return [] }
            return p.models.filter { ($0.input ?? []).contains("image") }
        }()

        return VStack(spacing: 0) {
            // 标题栏
            HStack {
                Text(loc("settings.vision")).font(.headline)
                Spacer()
            }
            .padding(.horizontal, 20)
            .padding(.top, 16)
            .padding(.bottom, 12)

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    // 提示
                    Text(loc("settings.visionSheetHint"))
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .fixedSize(horizontal: false, vertical: true)

                    // 没有任何可用识图 provider 的提示
                    if visionCapableProviders.isEmpty {
                        HStack(spacing: 6) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .foregroundColor(.orange)
                            Text(loc("settings.visionNoModel"))
                                .font(.callout)
                                .foregroundColor(.secondary)
                        }
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 6))
                    } else {
                        // Provider 下拉
                        VStack(alignment: .leading, spacing: 4) {
                            Text(loc("settings.visionProvider"))
                                .font(.caption)
                                .foregroundColor(.secondary)
                            Picker("", selection: $visionProvider) {
                                Text(loc("settings.visionProviderPlaceholder")).tag("")
                                ForEach(visionCapableProviders, id: \.name) { p in
                                    Text("\(p.name)  ·  \(p.type)").tag(p.name)
                                }
                            }
                            .labelsHidden()
                            .onChange(of: visionProvider) { _, newValue in
                                let valid = visionCapableProviders
                                    .first(where: { $0.name == newValue })?
                                    .models.contains(where: { ($0.input ?? []).contains("image") && $0.id == visionModel }) ?? false
                                if !valid { visionModel = "" }
                            }
                        }

                        // 模型下拉
                        VStack(alignment: .leading, spacing: 4) {
                            Text(loc("settings.visionModel"))
                                .font(.caption)
                                .foregroundColor(.secondary)
                            Picker("", selection: $visionModel) {
                                Text(loc("settings.visionModelPlaceholder")).tag("")
                                ForEach(modelsForSelectedProvider, id: \.id) { m in
                                    Text(m.id).tag(m.id)
                                }
                            }
                            .labelsHidden()
                            .disabled(visionProvider.isEmpty)
                        }

                        // 提示词
                        VStack(alignment: .leading, spacing: 4) {
                            Text(loc("settings.visionPrompt"))
                                .font(.caption)
                                .foregroundColor(.secondary)
                            TextEditor(text: $visionPrompt)
                                .font(.callout)
                                .frame(minHeight: 70, maxHeight: 100)
                                .padding(6)
                                .overlay(
                                    RoundedRectangle(cornerRadius: 5)
                                        .stroke(Color.secondary.opacity(0.3), lineWidth: 1)
                                )
                        }

                        // 警告：选中的模型未声明支持图片（后端会拒绝保存）
                        if !visionModel.isEmpty,
                           let m = modelsForSelectedProvider.first(where: { $0.id == visionModel }),
                           !(m.input ?? []).contains("image") {
                            HStack(alignment: .top, spacing: 6) {
                                Image(systemName: "exclamationmark.triangle.fill")
                                    .foregroundColor(.orange)
                                Text(loc("settings.visionModelNotImageCapable"))
                                    .font(.caption)
                                    .foregroundColor(.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            .padding(8)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Color.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 6))
                        }
                    }
                }
                .padding(20)
            }

            if let toast = toastMessage {
                Text(toast)
                    .font(.caption)
                    .foregroundColor(toastType == "success" ? .green : .red)
                    .padding(.horizontal, 20)
                    .padding(.bottom, 8)
            }

            Divider()

            HStack {
                Spacer()
                Button(loc("action.cancel")) { showVisionSheet = false }
                    .keyboardShortcut(.cancelAction)
                Button(loc("action.save")) {
                    Task { await saveVision() }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(visionProvider.isEmpty || visionModel.isEmpty)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
        }
        .frame(width: 460, height: 380)
        .onAppear {
            // 每次打开 sheet 都重新拉一次 provider 列表，确保拿到最新数据（SettingsView 启动时可能 llm-proxy 还未就绪）
            Task { await loadVisionProviders() }
            if let v = visionConfig {
                visionProvider = v.provider
                visionModel = v.model
                // 显示后端实际存储的 prompt；如果为空，显示默认提示词让用户知道“默认”是什么
                visionPrompt = v.prompt ?? defaultVisionPrompt
            } else {
                // 未设置过：预填默认提示词，避免用户对“默认”无感知
                visionPrompt = defaultVisionPrompt
            }
        }
    }

    private func loadVisionProviders() async {
        do {
            let providers = try await api.fetchProviders()
            await MainActor.run {
                self.visionProviders = providers
            }
        } catch {
            // 留空列表，sheet 中会显示“暂无可用 Provider”提示
        }
    }

    private func saveVision() async {
        do {
            // 提示词如果是默认值或空，传 nil 让后端走默认逻辑（避免冗余保存）
            let trimmedPrompt = visionPrompt.trimmingCharacters(in: .whitespaces)
            let promptToSave: String? = (trimmedPrompt.isEmpty || trimmedPrompt == defaultVisionPrompt) ? nil : trimmedPrompt
            try await api.setVision(
                provider: visionProvider.trimmingCharacters(in: .whitespaces),
                model: visionModel.trimmingCharacters(in: .whitespaces),
                prompt: promptToSave
            )
            visionConfig = VisionConfig(
                provider: visionProvider,
                model: visionModel,
                prompt: promptToSave
            )
            showToast(loc("settings.visionSaved"), type: "success")
            showVisionSheet = false
            NotificationCenter.default.post(name: .configDidChange, object: nil)
        } catch {
            showToast(error.localizedDescription, type: "error")
        }
    }

    private func removeVision() async {
        do {
            try await api.setVision(provider: nil, model: nil, prompt: nil)
            visionConfig = nil
            visionProvider = ""
            visionModel = ""
            visionPrompt = ""
            showToast(loc("settings.visionRemoved"), type: "success")
            NotificationCenter.default.post(name: .configDidChange, object: nil)
        } catch {
            showToast(error.localizedDescription, type: "error")
        }
    }

    // MARK: - Reload Config

    private func reloadConfig() async {
        isReloading = true
        do {
            try await api.reloadConfig()
            showToast(loc("status.configReloaded"), type: "success")
            NotificationCenter.default.post(name: .configDidChange, object: nil)
        } catch {
            showToast(error.localizedDescription, type: "error")
        }
        isReloading = false
    }

    // MARK: - Toast

    private func showToast(_ msg: String?, type: String = "info") {
        toastMessage = msg
        toastType = type
        if msg != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                if toastMessage == msg { toastMessage = nil }
            }
        }
    }
}
