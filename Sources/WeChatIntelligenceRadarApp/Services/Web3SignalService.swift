import Foundation

struct Web3SignalService {
    private let tokenAliases: [String: [String]] = [
        "BTC": ["BTC", "Bitcoin", "比特币"],
        "ETH": ["ETH", "Ethereum", "以太坊", "L2"],
        "SOL": ["SOL", "Solana"],
    ]

    private let keywords = ["Web3", "DeFi", "ETF", "token", "链上", "L2", "meme", "crypto"]

    func detectedSymbols(in messages: [IntelligenceMessage]) -> [String] {
        let joinedMessages = messages
            .map { "\($0.title) \($0.excerpt) \($0.tags.map(\.label).joined(separator: " "))" }
            .joined(separator: " ")
            .lowercased()

        return tokenAliases
            .filter { _, aliases in
                aliases.contains { joinedMessages.contains($0.lowercased()) }
            }
            .map(\.key)
            .sorted()
    }

    func enrich(
        messages: [IntelligenceMessage],
        cmcMarket: MarketDataSnapshot,
        fallbackMarket: MarketDataSnapshot
    ) -> Web3Snapshot {
        let symbols = detectedSymbols(in: messages)
        let market = cmcMarket.assets.isEmpty ? fallbackMarket : cmcMarket
        let keywordHits = detectedKeywords(in: messages)
        let enrichments = buildEnrichments(messages: messages, symbols: symbols, market: market)
        let status: String
        let note: String

        if cmcMarket.status == "blocked" {
            status = fallbackMarket.status
            note = "CMC MCP blocked; using mock market fixture for local enrichment only."
        } else if cmcMarket.status == "degraded" {
            status = "degraded"
            note = "CMC MCP degraded; enrichment may be incomplete."
        } else {
            status = cmcMarket.status
            note = "Market context normalized from primary provider."
        }

        return Web3Snapshot(
            status: status,
            sourceStatus: cmcMarket.status,
            detectedSymbols: symbols,
            keywords: keywordHits,
            market: market,
            enrichments: enrichments,
            note: note
        )
    }

    private func detectedKeywords(in messages: [IntelligenceMessage]) -> [String] {
        let joinedMessages = messages
            .map { "\($0.title) \($0.excerpt)" }
            .joined(separator: " ")
            .lowercased()

        return keywords
            .filter { joinedMessages.contains($0.lowercased()) }
            .sorted()
    }

    private func buildEnrichments(
        messages: [IntelligenceMessage],
        symbols: [String],
        market: MarketDataSnapshot
    ) -> [Web3Enrichment] {
        let assetsBySymbol = Dictionary(uniqueKeysWithValues: market.assets.map { ($0.symbol, $0) })

        return messages.compactMap { message in
            let content = "\(message.title) \(message.excerpt)".lowercased()
            guard let symbol = symbols.first(where: { symbol in
                guard let aliases = tokenAliases[symbol] else { return false }
                return aliases.contains { content.contains($0.lowercased()) }
            }) else {
                return nil
            }

            let asset = assetsBySymbol[symbol]
            let marketContext: String
            if let asset {
                marketContext = "\(asset.symbol) \(formatPrice(asset.priceUSD)) · 24h \(formatPercent(asset.percentChange24h)) · \(market.status)"
            } else {
                marketContext = "\(symbol) detected; no normalized market asset available."
            }

            return Web3Enrichment(
                symbol: symbol,
                tokenName: asset?.name ?? symbol,
                messageTitle: message.title,
                groupName: message.groupName,
                marketContext: marketContext,
                sourceStatus: market.status,
                confidence: asset == nil ? 0.62 : 0.84
            )
        }
    }

    private func formatPrice(_ value: Double) -> String {
        if value >= 1_000 {
            return "$\(String(format: "%.0f", value))"
        }
        return "$\(String(format: "%.2f", value))"
    }

    private func formatPercent(_ value: Double) -> String {
        let sign = value >= 0 ? "+" : ""
        return "\(sign)\(String(format: "%.2f", value))%"
    }
}
