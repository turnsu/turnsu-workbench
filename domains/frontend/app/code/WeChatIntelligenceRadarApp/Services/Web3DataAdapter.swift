import Foundation

protocol Web3DataAdapter {
    var providerName: String { get }
    var isLiveProvider: Bool { get }

    func fetchMarketData(for symbols: [String], date: Date) -> MarketDataSnapshot
}

struct CMCProviderConfiguration: Hashable {
    let mcpToolAvailable: Bool
    let apiKeyConfigured: Bool
    let networkPermissionKnown: Bool
    let skillsMarketplaceURL: String
    let skillHubCapability: CMCSkillHubCapability
    let discoveryEvidence: [String]

    static let currentEnvironment = CMCProviderConfiguration(
        mcpToolAvailable: false,
        apiKeyConfigured: false,
        networkPermissionKnown: false,
        skillsMarketplaceURL: "https://coinmarketcap.com/api/skills-marketplace/",
        skillHubCapability: .current,
        discoveryEvidence: [
            "Swift does not call CoinMarketCap, MCP, or external network providers directly.",
            "Live CMC evidence must be written by the backend daemon into runtime/market/latest-market-snapshot.json.",
            "Fixture/sample capability data is research UI fallback only and must not be labeled live."
        ]
    )
}

struct CMCMarketDataProvider: Web3DataAdapter {
    let providerName = "CoinMarketCap MCP"
    let isLiveProvider = false
    let configuration: CMCProviderConfiguration
    let refreshBridge: CMCRefreshBridge

    init(
        configuration: CMCProviderConfiguration = .currentEnvironment,
        refreshBridge: CMCRefreshBridge = CMCRefreshBridge()
    ) {
        self.configuration = configuration
        self.refreshBridge = refreshBridge
    }

    func fetchMarketData(for symbols: [String], date: Date) -> MarketDataSnapshot {
        let requested = Set(symbols.map { $0.uppercased() })
        if let storedSnapshot = refreshBridge.loadExternalSnapshot(now: date) {
            let assets = storedSnapshot.assets.filter {
                requested.isEmpty || requested.contains($0.symbol)
            }
            let missingRequestedAsset = !requested.isEmpty && !requested.isSubset(of: Set(storedSnapshot.assets.map(\.symbol)))
            if !missingRequestedAsset {
                return storedSnapshot.withAssets(
                    assets.isEmpty ? storedSnapshot.assets : assets,
                    evidenceSuffix: "Loaded from runtime/market/latest-market-snapshot.json."
                )
            }
        }

        return MarketDataSnapshot(
            status: "degraded",
            sourceName: providerName,
            provider: nil,
            generatedAt: AgentDateFormatting.isoString(date),
            observedAt: nil,
            expiresAt: AgentDateFormatting.isoString(date),
            freshness: "blocked",
            lastVerifiedAt: "--",
            assets: [],
            evidence: configuration.discoveryEvidence + [
                "No live CMC request was attempted from the Swift app.",
                "Run backend CMC refresh to populate a fresh cmcRestProvider/mcpProvider snapshot."
            ],
            upstreamStatus: configuration.apiKeyConfigured ? "backend_refresh_required_key_present" : "backend_refresh_required_key_missing"
        )
    }

    private func skillHubSnapshot(for symbols: [String], now: Date) -> MarketDataSnapshot {
        let requested = Set(symbols.map { $0.uppercased() })
        let normalizedAssets = configuration.skillHubCapability.normalizedAssets.filter {
            requested.isEmpty || requested.contains($0.symbol)
        }
        let lastVerifiedDate = AgentDateFormatting.parse(configuration.skillHubCapability.lastVerifiedAtUTC) ?? now
        let expiresAt = Calendar(identifier: .gregorian).date(byAdding: .hour, value: 24, to: lastVerifiedDate) ?? now
        let freshness = expiresAt < now ? "stale" : "fixture"

        return MarketDataSnapshot(
            status: "degraded",
            sourceName: "CMC Crypto Skill Hub Sample",
            provider: "fixtureProvider",
            generatedAt: AgentDateFormatting.isoString(lastVerifiedDate),
            observedAt: configuration.skillHubCapability.lastVerifiedAtUTC,
            expiresAt: AgentDateFormatting.isoString(expiresAt),
            freshness: freshness,
            lastVerifiedAt: configuration.skillHubCapability.lastVerifiedAtUTC,
            assets: normalizedAssets.isEmpty ? configuration.skillHubCapability.normalizedAssets : normalizedAssets,
            evidence: configuration.discoveryEvidence + configuration.skillHubCapability.evidence + [
                "Last verified at \(configuration.skillHubCapability.lastVerifiedAtUTC).",
                "Swift runtime uses a loaded normalized snapshot; live refresh still belongs to the external agent/MCP execution boundary."
            ],
            upstreamStatus: freshness == "fixture" ? "cmc_skill_hub_fixture_sample" : "cmc_skill_hub_fixture_stale"
        )
    }
}

extension MarketDataSnapshot {
    func withAssets(_ assets: [MarketAsset], evidenceSuffix: String? = nil) -> MarketDataSnapshot {
        MarketDataSnapshot(
            schemaVersion: schemaVersion,
            status: status,
            sourceName: sourceName,
            provider: provider,
            generatedAt: generatedAt,
            observedAt: observedAt,
            expiresAt: expiresAt,
            freshness: freshness,
            lastVerifiedAt: lastVerifiedAt,
            assets: assets,
            evidence: evidenceSuffix.map { evidence + [$0] } ?? evidence,
            upstreamStatus: upstreamStatus
        )
    }
}

struct MockWeb3MarketDataAdapter: Web3DataAdapter {
    let providerName = "Mock Web3 Market Fixture"
    let isLiveProvider = false

    func fetchMarketData(for symbols: [String], date: Date) -> MarketDataSnapshot {
        let requested = Set(symbols.map { $0.uppercased() })
        let expiresAt = Calendar(identifier: .gregorian).date(byAdding: .hour, value: 1, to: date) ?? date
        let catalog = [
            MarketAsset(
                symbol: "BTC",
                name: "Bitcoin",
                priceUSD: 68250.40,
                percentChange24h: 1.84,
                volume24hUSD: 31_200_000_000,
                marketCapUSD: 1_345_000_000_000,
                source: providerName,
                isLive: false
            ),
            MarketAsset(
                symbol: "ETH",
                name: "Ethereum",
                priceUSD: 3724.18,
                percentChange24h: -0.62,
                volume24hUSD: 14_850_000_000,
                marketCapUSD: 447_000_000_000,
                source: providerName,
                isLive: false
            ),
            MarketAsset(
                symbol: "SOL",
                name: "Solana",
                priceUSD: 168.74,
                percentChange24h: 3.21,
                volume24hUSD: 4_420_000_000,
                marketCapUSD: 78_600_000_000,
                source: providerName,
                isLive: false
            )
        ]

        let assets = catalog.filter { requested.isEmpty || requested.contains($0.symbol) }

        return MarketDataSnapshot(
            status: "mock",
            sourceName: providerName,
            generatedAt: AgentDateFormatting.isoString(date),
            expiresAt: AgentDateFormatting.isoString(expiresAt),
            freshness: "mock",
            lastVerifiedAt: "--",
            assets: assets.isEmpty ? catalog : assets,
            evidence: [
                "Static fixture used because CMC MCP is unavailable in the current environment.",
                "Values are not live CoinMarketCap market data."
            ],
            upstreamStatus: "cmc_blocked_mock_fallback"
        )
    }
}
