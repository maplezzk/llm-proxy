// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "LLMProxy",
    defaultLocalization: "en",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "LLMProxy",
            path: "Sources",
            resources: [
                .process("en.lproj"),
                .process("zh.lproj"),
                .process("Assets"),
            ]
        )
    ]
)
