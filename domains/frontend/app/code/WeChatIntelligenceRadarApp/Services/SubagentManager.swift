import Foundation

struct SubagentManager {
    func buildRuns(
        parentRunID: String,
        messageCount: Int,
        entityCount: Int,
        marketStatus: String,
        onchainSnapshots: [OnchainSnapshot],
        alertCount: Int,
        artifactRoot: String,
        now: Date
    ) -> [SubagentRun] {
        let started = AgentDateFormatting.isoString(now)
        let completed = AgentDateFormatting.isoString(Date())
        let onchainDegraded = onchainSnapshots.contains { $0.freshness == "degraded" }
        let runRoot = "\(artifactRoot)/runs/\(parentRunID)"

        return [
            run(parentRunID, .ingestion, "Normalize fixture/export WeChat messages", .completed, started, completed, "fixture messages", "\(messageCount) normalized message(s)", "\(artifactRoot)/wechat/messages.normalized.json", nil),
            run(parentRunID, .entityResolver, "Extract symbols/contracts and link token entities", entityCount > 0 ? .completed : .degraded, started, completed, "normalized messages", "\(entityCount) token entity/entities", "\(artifactRoot)/entities/token-entities.json", entityCount > 0 ? nil : "no token entity detected"),
            run(parentRunID, .marketData, "Attach CMC/local market snapshot with freshness", marketStatus == "enabled" ? .completed : .degraded, started, completed, "token entities", "market status \(marketStatus)", "\(artifactRoot)/market/latest-market-snapshot.json", marketStatus == "enabled" ? nil : "market provider degraded"),
            run(parentRunID, .onchain, "Build on-chain context for CA-backed entities", onchainDegraded ? .degraded : .completed, started, completed, "token entities with CA", "\(onchainSnapshots.count) onchain snapshot(s)", "\(artifactRoot)/onchain", onchainDegraded ? "some entities missing CA/provider" : nil),
            run(parentRunID, .briefing, "Synthesize daily brief and ranked intelligence", .completed, started, completed, "intelligence snapshot", "brief generated", "\(runRoot)/intelligence-snapshot.json", nil),
            run(parentRunID, .alert, "Create watchlist alerts from mentions and entity state", alertCount > 0 ? .completed : .degraded, started, completed, "token entities and messages", "\(alertCount) alert(s)", "\(artifactRoot)/alerts/alerts.json", alertCount > 0 ? nil : "no alert candidate generated"),
            run(parentRunID, .qaPolicy, "Verify policy/capability boundaries and artifacts", .completed, started, completed, "policy decisions", "mock/live boundaries checked", "\(runRoot)/policy-decisions.json", nil)
        ]
    }

    private func run(
        _ parent: String,
        _ type: SubagentType,
        _ taskScope: String,
        _ status: SubagentStatus,
        _ started: String,
        _ completed: String,
        _ input: String,
        _ output: String,
        _ artifact: String,
        _ error: String?
    ) -> SubagentRun {
        SubagentRun(
            runID: "\(parent)-\(type.rawValue)",
            parentRunID: parent,
            agentType: type,
            taskScope: taskScope,
            status: status,
            startedAt: started,
            completedAt: completed,
            inputSummary: input,
            outputSummary: output,
            artifact: artifact,
            error: error
        )
    }
}
