// swift-tools-version: 6.0

import PackageDescription

// Historical Swift reference and contract-test closure only. The current Desktop direction is the
// TypeScript/Tauri client in the Master PRD; this executable must not become a second control plane.
let package = Package(
    name: "WeChatIntelligenceRadarMVP",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(
            name: "WeChatIntelligenceRadar",
            targets: ["WeChatIntelligenceRadarApp"]
        )
    ],
    targets: [
        .executableTarget(
            name: "WeChatIntelligenceRadarApp",
            path: "domains/frontend/app/code/WeChatIntelligenceRadarApp",
            resources: [
                .process("Fixtures"),
                .process("Resources")
            ]
        ),
        .testTarget(
            name: "WeChatIntelligenceRadarAppTests",
            dependencies: ["WeChatIntelligenceRadarApp"],
            path: "domains/frontend/app/code/Tests/WeChatIntelligenceRadarAppTests"
        )
    ]
)
