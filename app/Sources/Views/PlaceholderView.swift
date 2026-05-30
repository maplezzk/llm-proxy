import SwiftUI

/// 通用占位视图——未实现 tab 显示"即将推出"
struct PlaceholderView: View {
    let title: String
    let iconName: String

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: iconName)
                .font(.system(size: 48))
                .foregroundColor(.secondary)
            Text(title)
                .font(.title2)
                .fontWeight(.semibold)
            Text(loc("console.comingSoon"))
                .foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
