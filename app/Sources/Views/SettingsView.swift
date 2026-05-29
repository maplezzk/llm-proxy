import SwiftUI

/// 侧边栏底部设置区：端口、代理密钥、语言、配置重载
struct SettingsView: View {
    @State private var port: String = ""
    @State private var originalPort: Int?
    @State private var hasProxyKey: Bool = false
    @State private var proxyKeyInput: String = ""
    @State private var selectedLang: String = currentLang()
    @State private var showPortSheet: Bool = false
    @State private var showProxyKeySheet: Bool = false
    @State private var isReloading: Bool = false
    @State private var toastMessage: String?
    @State private var toastType: String = "info"

    private let api = APIClient()

    var body: some View {
        VStack(spacing: 0) {
            Divider()

            DisclosureGroup {
                VStack(alignment: .leading, spacing: 8) {
                    // 端口
                    settingsRow(icon: "network", label: "settings.port") {
                        Button(action: { openPortSheet() }) {
                            HStack {
                                Text(portLabel)
                                    .font(.caption)
                                    .foregroundColor(.secondary)
                                Spacer()
                                Image(systemName: "chevron.right")
                                    .font(.system(size: 9, weight: .bold))
                                    .foregroundColor(.secondary)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.borderless)
                    }

                    // 代理密钥
                    settingsRow(icon: "key", label: "settings.proxyKey") {
                        Button(action: { openProxyKeySheet() }) {
                            HStack {
                                Text(hasProxyKey ? loc("settings.set") : loc("settings.notSet"))
                                    .font(.caption)
                                    .foregroundColor(hasProxyKey ? .green : .secondary)
                                Spacer()
                                Image(systemName: "chevron.right")
                                    .font(.system(size: 9, weight: .bold))
                                    .foregroundColor(.secondary)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.borderless)
                    }

                    // 语言
                    settingsRow(icon: "globe", label: "action.language") {
                        Picker("", selection: $selectedLang) {
                            Text("中文").tag("zh")
                            Text("English").tag("en")
                        }
                        .pickerStyle(.segmented)
                        .labelsHidden()
                        .onChange(of: selectedLang) { _, newLang in
                            switchLang(newLang)
                        }
                    }

                    // 配置重载
                    settingsRow(icon: "arrow.clockwise", label: "action.reloadConfig") {
                        Button(action: { Task { await reloadConfig() } }) {
                            HStack {
                                if isReloading {
                                    ProgressView()
                                        .scaleEffect(0.6)
                                        .frame(width: 14, height: 14)
                                }
                                Text(loc("action.reloadConfig"))
                                    .font(.caption)
                                Spacer()
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.borderless)
                        .disabled(isReloading)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            } label: {
                Label(loc("settings.title"), systemImage: "gearshape")
                    .font(.subheadline)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
            }
        }
        .padding(.bottom, 6)
        .sheet(isPresented: $showPortSheet) {
            portSheet
        }
        .sheet(isPresented: $showProxyKeySheet) {
            proxyKeySheet
        }
        .task {
            await loadSettings()
        }
    }

    // MARK: - Labels

    private var portLabel: String {
        if let p = originalPort {
            return "\(p)"
        }
        return loc("settings.notSet")
    }

    // MARK: - Settings Row

    private func settingsRow<Content: View>(icon: String, label: String, @ViewBuilder content: () -> Content) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 10))
                .foregroundColor(.secondary)
                .frame(width: 14)
            Text(loc(label))
                .font(.caption)
                .foregroundColor(.secondary)
            Spacer()
            content()
        }
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

    // MARK: - Port Sheet

    private func openPortSheet() {
        showPortSheet = true
        showToast(nil)
    }

    private var portSheet: some View {
        VStack(spacing: 0) {
            HStack {
                Text(loc("action.port"))
                    .font(.headline)
                Spacer()
            }
            .padding()

            Divider()

            VStack(spacing: 16) {
                TextField(loc("settings.portPlaceholder"), text: $port)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 200)
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
                Button(loc("action.cancel")) { showPortSheet = false }
                    .keyboardShortcut(.cancelAction)
                Button(loc("action.save")) {
                    Task { await savePort() }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(port.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .padding()
        }
        .frame(width: 320, height: 180)
    }

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

    // MARK: - Proxy Key Sheet

    private func openProxyKeySheet() {
        proxyKeyInput = ""
        showToast(nil)
        showProxyKeySheet = true
    }

    private var proxyKeySheet: some View {
        VStack(spacing: 0) {
            HStack {
                Text(loc("settings.proxyKey"))
                    .font(.headline)
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
                if hasProxyKey {
                    Button(loc("settings.remove"), role: .destructive) {
                        Task { await removeProxyKey() }
                    }
                }
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

    // MARK: - Toast (inline)

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
