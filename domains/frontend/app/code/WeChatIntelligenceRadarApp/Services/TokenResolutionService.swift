import Foundation

struct TokenResolutionService {
    private let knownTokens: [String: (name: String, chain: String, contract: String?, aliases: [String])] = [
        "BTC": ("Bitcoin", "Bitcoin", nil, ["Bitcoin", "比特币"]),
        "ETH": ("Ethereum", "Ethereum", "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", ["Ethereum", "以太坊", "L2"]),
        "SOL": ("Solana", "Solana", "So11111111111111111111111111111111111111112", ["Solana"])
    ]

    func normalize(messages: [IntelligenceMessage], groups: [ChatGroup], sourceMode: String) -> [NormalizedWeChatMessage] {
        messages.map { message in
            let text = "\(message.title)\n\(message.excerpt)"
            let symbols = extractSymbols(text: text)
            let contracts = extractContracts(text: text)
            let linked = symbols.map { tokenID(symbol: $0, contract: contracts.first) }
            return NormalizedWeChatMessage(
                id: message.id,
                groupID: groups.first(where: { $0.name == message.groupName })?.id,
                groupName: message.groupName,
                sender: message.sender,
                sentAt: message.sentAt,
                text: text,
                extractedSymbols: symbols,
                extractedContracts: contracts,
                linkedTokenIDs: linked,
                sourceMode: sourceMode,
                privacyLevel: "fixture"
            )
        }
    }

    func resolve(messages: [NormalizedWeChatMessage]) -> [TokenEntity] {
        let now = Date()
        var entities: [String: TokenEntity] = [:]

        for message in messages {
            let symbols = message.extractedSymbols.isEmpty && !message.extractedContracts.isEmpty ? ["UNKNOWN"] : message.extractedSymbols
            for symbol in symbols {
                let contract = message.extractedContracts.first ?? knownTokens[symbol]?.contract
                let id = tokenID(symbol: symbol, contract: contract)
                let existing = entities[id]
                let sourceMessages = Array(Set((existing?.sourceMessages ?? []) + [message.id]))
                let firstSeen = min(existing.flatMap { AgentDateFormatting.parse($0.firstSeenAt) } ?? message.sentAt, message.sentAt)
                let lastSeen = max(existing.flatMap { AgentDateFormatting.parse($0.lastMentionedAt) } ?? message.sentAt, message.sentAt)
                let known = knownTokens[symbol]

                entities[id] = TokenEntity(
                    tokenID: id,
                    symbol: symbol,
                    name: known?.name ?? symbol,
                    chain: inferChain(symbol: symbol, contract: contract),
                    contractAddress: contract,
                    confidence: confidence(symbol: symbol, contract: contract),
                    aliases: known?.aliases ?? [],
                    firstSeenAt: AgentDateFormatting.isoString(firstSeen),
                    lastMentionedAt: AgentDateFormatting.isoString(lastSeen),
                    sourceMessages: sourceMessages.sorted { $0.uuidString < $1.uuidString },
                    source: "wechat_fixture_entity_resolver",
                    freshness: Calendar.current.dateComponents([.day], from: lastSeen, to: now).day ?? 0 > 30 ? "stale" : "fresh"
                )
            }
        }

        return entities.values.sorted { first, second in
            if first.sourceMessages.count == second.sourceMessages.count {
                return first.symbol < second.symbol
            }
            return first.sourceMessages.count > second.sourceMessages.count
        }
    }

    func extractSymbols(text: String) -> [String] {
        let upper = text.uppercased()
        let candidates = knownTokens.keys.filter { symbol in
            upper.contains(symbol)
        }
        return Array(Set(candidates)).sorted()
    }

    func extractContracts(text: String) -> [String] {
        var results: [String] = []
        let patterns = [
            #"0x[a-fA-F0-9]{40}"#,
            #"[1-9A-HJ-NP-Za-km-z]{32,44}"#
        ]

        for pattern in patterns {
            guard let regex = try? NSRegularExpression(pattern: pattern) else { continue }
            let range = NSRange(text.startIndex..<text.endIndex, in: text)
            for match in regex.matches(in: text, range: range) {
                if let swiftRange = Range(match.range, in: text) {
                    let value = String(text[swiftRange])
                    if hasTokenBoundaries(text: text, range: swiftRange) {
                        results.append(value)
                    }
                }
            }
        }

        return Array(Set(results)).sorted()
    }

    private func tokenID(symbol: String, contract: String?) -> String {
        let normalizedSymbol = symbol.uppercased()
        guard let contract, !contract.isEmpty else {
            return "symbol:\(normalizedSymbol)"
        }
        return "\(inferChain(symbol: normalizedSymbol, contract: contract).lowercased()):\(contract.lowercased())"
    }

    private func inferChain(symbol: String, contract: String?) -> String {
        if contract?.hasPrefix("0x") == true {
            return "Ethereum"
        }
        if symbol == "SOL" || contract?.hasPrefix("So111") == true {
            return "Solana"
        }
        if symbol == "BTC" {
            return "Bitcoin"
        }
        return "Unknown"
    }

    private func confidence(symbol: String, contract: String?) -> Double {
        if contract != nil {
            return 0.92
        }
        if knownTokens[symbol] != nil {
            return 0.78
        }
        return 0.46
    }

    private func hasTokenBoundaries(text: String, range: Range<String.Index>) -> Bool {
        let alphanumeric = CharacterSet.alphanumerics

        if range.lowerBound > text.startIndex {
            let previousIndex = text.index(before: range.lowerBound)
            if text[previousIndex].unicodeScalars.contains(where: { alphanumeric.contains($0) }) {
                return false
            }
        }

        if range.upperBound < text.endIndex {
            if text[range.upperBound].unicodeScalars.contains(where: { alphanumeric.contains($0) }) {
                return false
            }
        }

        return true
    }
}
