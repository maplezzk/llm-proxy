import SwiftUI

/// 控制台根视图——macOS 侧边栏导航
struct ConsoleRootView: View {
    @State private var selectedTab: ConsoleTab = .dashboard
    @State private var testCoordinator = TestCoordinator()
    @State private var langVersion: Int = 0  // 语言切换时递增，强制视图重建

    var body: some View {
        NavigationSplitView {
            sidebar
                .navigationSplitViewColumnWidth(min: 140, ideal: 180, max: 220)
        } detail: {
            tabContent
        }
        .id(langVersion)
        .environment(testCoordinator)
        .onChange(of: testCoordinator.shouldSwitchToTestTab) { _, newValue in
            if newValue { selectedTab = .test }
        }
        .onReceive(NotificationCenter.default.publisher(for: .openSettings)) { _ in
            selectedTab = .settings
        }
        .onReceive(NotificationCenter.default.publisher(for: .configDidChange)) { _ in
            langVersion += 1
        }
    }

    // MARK: - Sidebar

    private var sidebar: some View {
        List(selection: $selectedTab) {
            ForEach(ConsoleTab.Section.allCases, id: \.self) { section in
                Section(section.title) {
                    ForEach(section.tabs, id: \.self) { tab in
                        Label(tab.title, systemImage: tab.iconName)
                            .tag(tab)
                    }
                }
            }
        }
        .listStyle(.sidebar)
    }

    // MARK: - Tab Content

    @ViewBuilder
    private var tabContent: some View {
        switch selectedTab {
        case .dashboard:
            DashboardView()
        case .providers:
            ProvidersView()
        case .adapters:
            AdaptersView()
        case .logs:
            LogsView()
        case .capture:
            CaptureView()
        case .test:
            TestPanelView()
        case .settings:
            SettingsView()
        }
    }
}

// MARK: - Console Tab Enum

enum ConsoleTab: String, CaseIterable {
    case dashboard
    case providers
    case adapters
    case logs
    case capture
    case test
    case settings

    var title: String {
        switch self {
        case .dashboard: return loc("nav.dashboard")
        case .providers: return loc("nav.providers")
        case .adapters: return loc("nav.adapters")
        case .logs: return loc("nav.logs")
        case .capture: return loc("nav.capture")
        case .test: return loc("test.title")
        case .settings: return loc("settings.title")
        }
    }

    var iconName: String {
        switch self {
        case .dashboard: return "gauge.with.dots.needle.33percent"
        case .providers: return "server.rack"
        case .adapters: return "arrow.triangle.branch"
        case .logs: return "doc.text.magnifyingglass"
        case .capture: return "antenna.radiowaves.left.and.right"
        case .test: return "flask"
        case .settings: return "gearshape"
        }
    }

    /// 侧边栏分组
    enum Section: String, CaseIterable {
        case overview
        case proxy
        case tools

        var title: String {
            switch self {
            case .overview: return loc("nav.section.overview")
            case .proxy: return loc("nav.section.proxy")
            case .tools: return loc("nav.section.tools")
            }
        }

        var tabs: [ConsoleTab] {
            switch self {
            case .overview: return [.dashboard, .logs]
            case .proxy: return [.providers, .adapters]
            case .tools: return [.capture, .test, .settings]
            }
        }
    }
}
