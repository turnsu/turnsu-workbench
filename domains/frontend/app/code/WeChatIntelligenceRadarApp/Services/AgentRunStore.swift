import Foundation

struct AgentRunArtifactStatus: Hashable, Codable {
    let runID: String
    let runDirectory: String
    let lastWrittenFile: String
    let errorMessage: String?

    static func failed(runID: String, error: Error) -> AgentRunArtifactStatus {
        AgentRunArtifactStatus(
            runID: runID,
            runDirectory: "--",
            lastWrittenFile: "--",
            errorMessage: String(describing: error)
        )
    }
}

struct AgentRunSummary: Hashable, Codable {
    let runID: String
    let startedAt: String
    let completedAt: String
    let sourceMode: String
    let syncStatus: AgentSyncStatus
    let marketFreshness: String
    let artifactFiles: [String]
}

struct AgentRunStore {
    let runsDirectory: URL
    let fileManager: FileManager

    init(pathResolver: RuntimePathResolver = RuntimePathResolver(), fileManager: FileManager = .default) {
        self.runsDirectory = pathResolver.runsDirectory
        self.fileManager = fileManager
    }

    init(runsDirectory: URL, fileManager: FileManager = .default) {
        self.runsDirectory = runsDirectory
        self.fileManager = fileManager
    }

    func runDirectory(for runID: String) -> URL {
        runsDirectory.appendingPathComponent(runID, isDirectory: true)
    }

    func writeRun(
        runID: String,
        startedAt: Date,
        completedAt: Date,
        envelope: PlannerEnvelope,
        policies: [PolicyDecision],
        marketSnapshot: MarketDataSnapshot,
        intelligenceSnapshot: IntelligenceSnapshot,
        logs: [AgentRunLog],
        syncStatus: AgentSyncStatus,
        terminalData: TerminalDataSnapshot
    ) throws -> AgentRunArtifactStatus {
        let directory = runDirectory(for: runID)
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)

        let files = [
            "run.json",
            "planner-envelope.json",
            "policy-decisions.json",
            "market-snapshot.json",
            "intelligence-snapshot.json",
            "terminal-data.json",
            "module-runs.json",
            "subagent-runs.json",
            "artifact-manifest.json",
            "logs.json"
        ]

        let summary = AgentRunSummary(
            runID: runID,
            startedAt: AgentDateFormatting.isoString(startedAt),
            completedAt: AgentDateFormatting.isoString(completedAt),
            sourceMode: intelligenceSnapshot.sourceMode,
            syncStatus: syncStatus,
            marketFreshness: marketSnapshot.freshness,
            artifactFiles: files
        )

        var lastWritten = ""
        try write(summary, to: directory.appendingPathComponent("run.json"))
        lastWritten = "run.json"
        try write(envelope, to: directory.appendingPathComponent("planner-envelope.json"))
        lastWritten = "planner-envelope.json"
        try write(policies, to: directory.appendingPathComponent("policy-decisions.json"))
        lastWritten = "policy-decisions.json"
        try write(marketSnapshot, to: directory.appendingPathComponent("market-snapshot.json"))
        lastWritten = "market-snapshot.json"
        try write(intelligenceSnapshot, to: directory.appendingPathComponent("intelligence-snapshot.json"))
        lastWritten = "intelligence-snapshot.json"
        try write(terminalData, to: directory.appendingPathComponent("terminal-data.json"))
        lastWritten = "terminal-data.json"
        try write(terminalData.moduleRuns, to: directory.appendingPathComponent("module-runs.json"))
        lastWritten = "module-runs.json"
        try write(terminalData.subagentRuns, to: directory.appendingPathComponent("subagent-runs.json"))
        lastWritten = "subagent-runs.json"
        try write(terminalData.artifactManifest, to: directory.appendingPathComponent("artifact-manifest.json"))
        lastWritten = "artifact-manifest.json"
        try write(logs, to: directory.appendingPathComponent("logs.json"))
        lastWritten = "logs.json"

        return AgentRunArtifactStatus(
            runID: runID,
            runDirectory: directory.path,
            lastWrittenFile: lastWritten,
            errorMessage: nil
        )
    }

    private func write<T: Encodable>(_ value: T, to url: URL) throws {
        let data = try JSONEncoder.agentArtifactEncoder().encode(value)
        try data.write(to: url, options: [.atomic])
    }
}
