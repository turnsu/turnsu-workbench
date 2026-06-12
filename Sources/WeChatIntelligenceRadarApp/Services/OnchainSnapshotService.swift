import Foundation

struct OnchainSnapshotService {
    func snapshots(for entities: [TokenEntity], generatedAt: Date) -> [OnchainSnapshot] {
        entities.map { entity in
            let hasContract = entity.contractAddress != nil
            return OnchainSnapshot(
                tokenID: entity.tokenID,
                chain: entity.chain,
                contractAddress: entity.contractAddress,
                holders: hasContract ? deterministicCount(seed: entity.tokenID, base: 8_000) : nil,
                poolLiquidityUSD: hasContract ? Double(deterministicCount(seed: entity.tokenID, base: 1_200_000)) : nil,
                pairAddress: hasContract ? "pair-\(abs(entity.tokenID.hashValue) % 100000)" : nil,
                whaleActivity: hasContract ? "fixture_whale_flow_neutral" : "not_available_without_contract",
                contractRisk: hasContract ? "fixture_medium_check_required" : "degraded_missing_contract",
                source: hasContract ? "fixture_onchain_snapshot" : "onchain_provider_not_configured",
                freshness: hasContract ? "fixture" : "degraded",
                confidence: hasContract ? 0.35 : 0.15,
                generatedAt: AgentDateFormatting.isoString(generatedAt)
            )
        }
    }

    private func deterministicCount(seed: String, base: Int) -> Int {
        base + abs(seed.hashValue % max(base, 1))
    }
}

struct AlertGenerationService {
    func alerts(for entities: [TokenEntity], messages: [NormalizedWeChatMessage], generatedAt: Date) -> [AlertRecord] {
        entities.compactMap { entity in
            let mentionCount = messages.filter { $0.linkedTokenIDs.contains(entity.tokenID) }.count
            guard mentionCount >= 1 else { return nil }
            return AlertRecord(
                id: UUID(),
                tokenID: entity.tokenID,
                title: "\(entity.symbol) mention watch",
                severity: mentionCount >= 2 ? "medium" : "low",
                status: "open",
                reason: "\(mentionCount) related WeChat message(s) in selected window.",
                createdAt: AgentDateFormatting.isoString(generatedAt)
            )
        }
    }
}
