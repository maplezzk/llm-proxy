import SwiftUI

/// 控制台根视图——macOS 侧边栏导航
struct ConsoleRootView: View {
    @State private var selectedTab: ConsoleTab = .dashboard
    @State private var testCoordinator = TestCoordinator()

    var body: some View {
        NavigationSplitView {
            sidebar
                .navigationSplitViewColumnWidth(min: 140, ideal: 180, max: 220)
        } detail: {
            tabContent
        }
        .environment(testCoordinator)
        .onChange(of: testCoordinator.shouldSwitchToTestTab) { _, newValue in
            if newValue { selectedTab = .test }
        }
    }

    // MARK: - Sidebar

    private var sidebar: some View {
        List(selection: $selectedTab) {
            // 标题——在 List 内部，不会越界遮盖 detail
            Text(loc("console.title"))
                .font(.headline)
                .padding(.horizontal, 8)
                .padding(.vertical, 10)
            
            Divider()
                .padding(.horizontal, 8)
            
            ForEach(ConsoleTab.allCases, id: \.self) { tab in
                Label(tab.title, systemImage: tab.iconName)
                    .tag(tab)
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
}
