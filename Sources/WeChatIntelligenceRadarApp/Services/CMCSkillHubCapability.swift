import Foundation

struct CMCSkillHubCapability: Hashable {
    let sourceURL: String
    let uniqueName: String
    let inputSchemaSummary: String
    let lastVerifiedAtUTC: String
    let symbols: [String]
    let evidence: [String]
    let normalizedAssets: [MarketAsset]

    static let current = CMCSkillHubCapability(
        sourceURL: "https://coinmarketcap.com/api/skills-marketplace/",
        uniqueName: "altcoin_token_profile",
        inputSchemaSummary: #"{"symbol":"BTC|ETH|SOL","convert":"USD"}"#,
        lastVerifiedAtUTC: "2026-05-23T23:27:41Z",
        symbols: ["BTC", "ETH", "SOL"],
        evidence: [
            "crypto_skill_hub.find_skill selected altcoin_token_profile for token market profiles.",
            "Historical sample output for BTC, ETH, and SOL was normalized for UI fallback only.",
            "These values are fixture/sample evidence and must not be labeled live."
        ],
        normalizedAssets: [
            MarketAsset(
                symbol: "BTC",
                name: "Bitcoin",
                priceUSD: 76_564.662284,
                percentChange24h: 1.18,
                volume24hUSD: 30_401_539_817.26,
                marketCapUSD: 1_533_858_391_564.59,
                source: "CMC Crypto Skill Hub sample / altcoin_token_profile",
                isLive: false
            ),
            MarketAsset(
                symbol: "ETH",
                name: "Ethereum",
                priceUSD: 2_113.979146,
                percentChange24h: 2.16,
                volume24hUSD: 16_749_840_846.65,
                marketCapUSD: 255_126_762_125.61,
                source: "CMC Crypto Skill Hub sample / altcoin_token_profile",
                isLive: false
            ),
            MarketAsset(
                symbol: "SOL",
                name: "Solana",
                priceUSD: 85.656062,
                percentChange24h: 1.00,
                volume24hUSD: 4_087_431_606.62,
                marketCapUSD: 49_517_711_572.82,
                source: "CMC Crypto Skill Hub sample / altcoin_token_profile",
                isLive: false
            )
        ]
    )
}
