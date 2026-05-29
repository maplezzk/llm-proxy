import SwiftUI

/// 设置页面——侧边栏独立 tab，完整详情区域展示
struct SettingsView: View {
    @State private var port: String = ""
    @State private var originalPort: Int?
    @State private var hasProxyKey: Bool = false
    @State private var proxyKeyInput: String = ""
    @State private var selectedLang: String = currentLang()
    @State private var showProxyKeySheet: Bool = false
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

                // 语言
                settingsSection {
                    settingsRow(
                        icon: "globe",
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
                    HStack {
                        Image(systemName: "arrow.clockwise")
                            .font(.title3)
                            .foregroundColor(.accentColor)
                            .frame(width: 28)
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
        title: String,
        subtitle: String,
        @ViewBuilder controls: () -> Controls
    ) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.title3)
                .foregroundColor(.accentColor)
                .frame(width: 28)

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
