import SwiftUI

struct DashboardView: View {
    @State private var viewModel = DashboardViewModel()

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                if viewModel.isLoading && viewModel.config == nil {
                    loadingView
                } else {
                    serviceStatusCard
                    statsCards
                    if viewModel.tokenStats != nil {
                        tokenUsageSection
                    }
                }
            }
            .padding(24)
        }
        .onAppear {
            viewModel.startPolling()
        }
        .onDisappear {
            viewModel.stopPolling()
        }
    }

    // MARK: - Loading

    private var loadingView: some View {
        VStack(spacing: 12) {
            ProgressView()
                .scaleEffect(0.8)
            Text(loc("dashboard.loading"))
                .foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.top, 60)
    }

    // MARK: - Service Status Card

    private var serviceStatusCard: some View {
        HStack(spacing: 12) {
            Circle()
                .fill(viewModel.health ? Color.green : Color.red)
                .frame(width: 12, height: 12)
            Text(loc("dashboard.serviceStatus"))
                .font(.headline)
            Spacer()
            Text(viewModel.health ? loc("dashboard.online") : loc("dashboard.offline"))
                .font(.title3)
                .fontWeight(.semibold)
                .foregroundColor(viewModel.health ? .green : .red)
        }
        .padding(16)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(Color(nsColor: .controlBackgroundColor))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(viewModel.health ? Color.green.opacity(0.3) : Color.red.opacity(0.3), lineWidth: 1)
        )
    }

    // MARK: - Stats Cards

    private var statsCards: some View {
        HStack(spacing: 12) {
            statCard(
                title: loc("dashboard.providerCount"),
                value: "\(viewModel.providerCount)",
                icon: "server.rack",
                color: .blue
            )
            statCard(
                title: loc("dashboard.modelCount"),
                value: "\(viewModel.modelCount)",
                icon: "cube",
                color: .purple
            )
            statCard(
                title: loc("dashboard.adapterCount"),
                value: "\(viewModel.adapterCount)",
                icon: "arrow.triangle.branch",
                color: .orange
            )
        }
    }

    private func statCard(title: String, value: String, icon: String, color: Color) -> some View {
        VStack(spacing: 8) {
            Image(systemName: icon)
                .font(.title2)
                .foregroundColor(color)
            Text(value)
                .font(.largeTitle)
                .fontWeight(.bold)
                .fontDesign(.rounded)
            Text(title)
                .font(.caption)
                .foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 20)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(Color(nsColor: .controlBackgroundColor))
        )
    }

    // MARK: - Token Usage Section

    private var tokenUsageSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(loc("dashboard.tokenUsage"))
                .font(.headline)

            if let today = viewModel.tokenStats?.today {
                let input = today.input_tokens
                let output = today.output_tokens
                let cacheRead = today.cache_read_input_tokens
                let cacheCreate = today.cache_creation_input_tokens
                let total = input + output
                let hitRate = DashboardViewModel.pct(cacheRead, input)

                LazyVGrid(columns: [
                    GridItem(.flexible()),
                    GridItem(.flexible())
                ], spacing: 12) {
                    tokenCard(
                        title: loc("dashboard.requests"),
                        value: "\(today.request_count)",
                        desc: "",
                        color: .primary
                    )
                    tokenCard(
                        title: loc("dashboard.inputTokens"),
                        value: DashboardViewModel.fmtNum(input),
                        desc: "\(loc("dashboard.outputTokens")) \(DashboardViewModel.fmtNum(output))",
                        color: .blue
                    )
                    tokenCard(
                        title: loc("dashboard.cacheHits"),
                        value: DashboardViewModel.fmtNum(cacheRead),
                        desc: "\(loc("dashboard.hitRate")) \(hitRate)",
                        color: .green
                    )
                    tokenCard(
                        title: loc("dashboard.cacheCreation"),
                        value: DashboardViewModel.fmtNum(cacheCreate),
                        desc: "\(loc("dashboard.totalTokens")) \(DashboardViewModel.fmtNum(total))",
                        color: .orange
                    )
                }
            } else {
                Text(loc("dashboard.empty"))
                    .foregroundColor(.secondary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 20)
            }
        }
    }

    private func tokenCard(title: String, value: String, desc: String, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption)
                .foregroundColor(.secondary)
            Text(value)
                .font(.title2)
                .fontWeight(.bold)
                .fontDesign(.rounded)
                .foregroundColor(color)
            if !desc.isEmpty {
                Text(desc)
                    .font(.caption2)
                    .foregroundColor(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(Color(nsColor: .controlBackgroundColor))
        )
    }
}
