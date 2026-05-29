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
                .frame(minWidth: 400)
        }
        .navigationSplitViewStyle(.prominentDetail)
        .environment(testCoordinator)
        .onChange(of: testCoordinator.shouldSwitchToTestTab) { _, newValue in
            if newValue { selectedTab = .test }
        }
    }

    // MARK: - Sidebar

    private var sidebar: some View {
        List(ConsoleTab.allCases, id: \.self, selection: $selectedTab) { tab in
            Label(tab.title, systemImage: tab.iconName)
                .tag(tab)
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .top) {
            VStack(spacing: 0) {
                Text(loc("console.title"))
                    .font(.headline)
                    .padding(.horizontal)
                    .padding(.top, 20)
                    .padding(.bottom, 10)
                Divider()
                    .padding(.horizontal)
            }
        }
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
