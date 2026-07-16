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
