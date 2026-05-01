// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "LLMProxyMenuBar",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "LLMProxyMenuBar",
            path: "Sources"
        )
    ]
)
