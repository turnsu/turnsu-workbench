// swift-tools-version: 6.0

import PackageDescription

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
            path: "Sources/WeChatIntelligenceRadarApp",
            resources: [
                .process("Fixtures")
            ]
        ),
        .testTarget(
            name: "WeChatIntelligenceRadarAppTests",
            dependencies: ["WeChatIntelligenceRadarApp"]
        )
    ]
)
