import Foundation

enum TimeWindow: String, CaseIterable, Identifiable, Hashable, Codable {
    case day = "日"
    case week = "周"
    case month = "月"
    case quarter = "季"
    case year = "年"

    var id: String { rawValue }

    func range(endingAt end: Date) -> DateInterval {
        let calendar = Calendar(identifier: .gregorian)
        let component: Calendar.Component
        let value: Int

        switch self {
        case .day:
            component = .day
            value = -1
        case .week:
            component = .day
            value = -7
        case .month:
            component = .day
            value = -30
        case .quarter:
            component = .day
            value = -90
        case .year:
            component = .day
            value = -365
        }

        let start = calendar.date(byAdding: component, value: value, to: end) ?? end
        return DateInterval(start: start, end: end)
    }
}

enum TagStyle: String, Hashable, Codable {
    case product
    case demand
    case link
    case action
    case risk
    case web3
}

struct SignalTag: Identifiable, Hashable, Codable {
    var id = UUID()
    let label: String
    let style: TagStyle
}

struct ChatGroup: Identifiable, Hashable, Codable {
    let id: UUID
    let name: String
    let memberCount: Int
    let unreadCount: Int
    let collection: String
    let colorHex: UInt
}

struct IntelligenceMessage: Identifiable, Hashable, Codable {
    let id: UUID
    let title: String
    let excerpt: String
    let groupName: String
    let sender: String
    let timestamp: String
    let sentAt: Date
    let sourceDateText: String
    let weight: Int
    let tags: [SignalTag]
}

struct MetricCardModel: Identifiable, Hashable, Codable {
    var id = UUID()
    let icon: String
    let title: String
    let value: String
    let footnote: String
    let tintHex: UInt
}

struct BriefingNote: Hashable, Codable {
    let title: String
    let body: String
    let generatedAt: String
}

struct ActionItem: Identifiable, Hashable, Codable {
    var id = UUID()
    let category: String
    let title: String
    let detail: String
    let dueTime: String
    let priority: Int
}

struct SourceRank: Identifiable, Hashable, Codable {
    var id = UUID()
    let name: String
    let context: String
    let score: Int
    let hits: Int
}

enum LogLevel: String, Hashable, Codable {
    case info = "INFO"
    case policy = "POLICY"
    case planner = "PLAN"
    case warning = "WARN"
}

struct AgentRunLog: Identifiable, Hashable, Codable {
    var id = UUID()
    let level: LogLevel
    let message: String
    let timestamp: String
}

struct Capability: Identifiable, Hashable, Codable {
    let id: String
    let title: String
    let state: String
    let detail: String
}

struct PolicyDecision: Identifiable, Hashable, Codable {
    var id = UUID()
    let action: String
    let status: String
    let reason: String
}

struct PlannerEnvelope: Hashable, Codable {
    let goal: String
    let taskType: String
    let capabilitiesNeeded: [String]
    let toolPlan: [String]
    let stopConditions: [String]
}

struct MarketAsset: Identifiable, Hashable, Codable {
    var id: String { symbol }

    let symbol: String
    let name: String
    let priceUSD: Double
    let percentChange24h: Double
    let volume24hUSD: Double
    let marketCapUSD: Double
    let source: String
    let isLive: Bool
    var observedAt: String? = nil
}

struct MarketDataSnapshot: Hashable, Codable {
    var schemaVersion: String? = nil
    let status: String
    let sourceName: String
    var provider: String? = nil
    let generatedAt: String
    var observedAt: String? = nil
    let expiresAt: String
    let freshness: String
    let lastVerifiedAt: String
    let assets: [MarketAsset]
    let evidence: [String]
    let upstreamStatus: String

    static let blocked = MarketDataSnapshot(
        status: "blocked",
        sourceName: "CoinMarketCap MCP",
        provider: nil,
        generatedAt: "--",
        observedAt: nil,
        expiresAt: "--",
        freshness: "blocked",
        lastVerifiedAt: "--",
        assets: [],
        evidence: ["CMC MCP was not queried."],
        upstreamStatus: "unavailable"
    )
}

struct Web3Enrichment: Identifiable, Hashable, Codable {
    var id = UUID()
    let symbol: String
    let tokenName: String
    let messageTitle: String
    let groupName: String
    let marketContext: String
    let sourceStatus: String
    let confidence: Double
}

struct Web3Snapshot: Hashable, Codable {
    let status: String
    let sourceStatus: String
    let detectedSymbols: [String]
    let keywords: [String]
    let market: MarketDataSnapshot
    let enrichments: [Web3Enrichment]
    let note: String

    static let empty = Web3Snapshot(
        status: "not_run",
        sourceStatus: "not_run",
        detectedSymbols: [],
        keywords: [],
        market: .blocked,
        enrichments: [],
        note: "Web3 enrichment has not run."
    )
}

enum AgentSyncStatus: String, Hashable, Codable {
    case idle
    case running
    case completed
    case degraded
    case failed
}

struct AgentSyncState: Hashable, Codable {
    let status: AgentSyncStatus
    let runID: String
    let lastRunAt: String
    let lastSuccessAt: String?
    let sourceFreshness: String
    let errorMessage: String?
    let artifactPath: String?

    static let idle = AgentSyncState(
        status: .idle,
        runID: "--",
        lastRunAt: "--",
        lastSuccessAt: nil,
        sourceFreshness: "not_run",
        errorMessage: nil,
        artifactPath: nil
    )
}

struct IntelligenceSnapshot: Hashable, Codable {
    let groups: [ChatGroup]
    let metrics: [MetricCardModel]
    let briefing: BriefingNote
    let signals: [IntelligenceMessage]
    let actions: [ActionItem]
    let sources: [SourceRank]
    let web3: Web3Snapshot
    let sourceMode: String

    static let empty = IntelligenceSnapshot(
        groups: [],
        metrics: [],
        briefing: BriefingNote(
            title: "等待生成",
            body: "Agent 尚未运行。",
            generatedAt: "--"
        ),
        signals: [],
        actions: [],
        sources: [],
        web3: .empty,
        sourceMode: "mock"
    )
}

enum TerminalWorkspace: String, CaseIterable, Identifiable, Hashable, Codable {
    case home = "Home"
    case inbox = "WeChat Inbox"
    case token = "Token Terminal"
    case watchlist = "Watchlist"
    case skills = "Skill OS"
    case workforce = "Workforce"
    case knowledge = "Knowledge"
    case chat = "Global Chat"
    case studio = "Loop Studio"
    case agents = "Agent Console"
    case ops = "Data/Ops"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .home:
            return "工作台"
        case .inbox:
            return "Loop Library"
        case .token:
            return "Token 详情"
        case .watchlist:
            return "观察列表"
        case .skills:
            return "Skill OS"
        case .workforce:
            return "Workforce"
        case .knowledge:
            return "Knowledge"
        case .chat:
            return "Chat"
        case .studio:
            return "Studio"
        case .agents:
            return "Agent Console"
        case .ops:
            return "设置"
        }
    }

    var icon: String {
        switch self {
        case .home:
            return "rectangle.grid.2x2"
        case .inbox:
            return "books.vertical"
        case .token:
            return "bitcoinsign.circle"
        case .watchlist:
            return "bell.badge"
        case .skills:
            return "square.stack.3d.up"
        case .workforce:
            return "person.3.sequence"
        case .knowledge:
            return "tray.full"
        case .chat:
            return "bubble.left.and.text.bubble.right"
        case .studio:
            return "slider.horizontal.3"
        case .agents:
            return "terminal"
        case .ops:
            return "externaldrive.badge.gearshape"
        }
    }
}

enum OperationsDeckTab: String, CaseIterable, Identifiable, Hashable {
    case run = "Run"
    case proactive = "Proactive"
    case evidence = "Evidence"
    case tasks = "Tasks"
    case logs = "Logs"
    case artifacts = "Artifacts"
    case policy = "Policy"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .run:
            return "运行"
        case .proactive:
            return "情报"
        case .evidence:
            return "证据"
        case .tasks:
            return "任务"
        case .logs:
            return "日志"
        case .artifacts:
            return "记录"
        case .policy:
            return "安全"
        }
    }
}

struct NormalizedWeChatMessage: Identifiable, Hashable, Codable {
    let id: UUID
    let groupID: UUID?
    let groupName: String
    let sender: String
    let sentAt: Date
    let text: String
    let extractedSymbols: [String]
    let extractedContracts: [String]
    let linkedTokenIDs: [String]
    let sourceMode: String
    let privacyLevel: String
}

struct TokenEntity: Identifiable, Hashable, Codable {
    var id: String { tokenID }

    let tokenID: String
    let symbol: String
    let name: String
    let chain: String
    let contractAddress: String?
    let confidence: Double
    let aliases: [String]
    let firstSeenAt: String
    let lastMentionedAt: String
    let sourceMessages: [UUID]
    let source: String
    let freshness: String
}

struct OnchainSnapshot: Identifiable, Hashable, Codable {
    var id: String { tokenID }

    let tokenID: String
    let chain: String
    let contractAddress: String?
    let holders: Int?
    let poolLiquidityUSD: Double?
    let pairAddress: String?
    let whaleActivity: String
    let contractRisk: String
    let source: String
    let freshness: String
    let confidence: Double
    let generatedAt: String
}

struct AlertRecord: Identifiable, Hashable, Codable {
    let id: UUID
    let tokenID: String
    let title: String
    let severity: String
    let status: String
    let reason: String
    let createdAt: String
}

enum AlertStatus: String, Hashable, Codable {
    case open
    case acknowledged
    case muted
    case resolved
}

struct EvidenceItem: Identifiable, Hashable, Codable {
    let id: UUID
    let evidenceType: String
    let title: String
    let summary: String
    let messageIDs: [UUID]
    let tokenIDs: [String]
    let source: String
    let freshness: String
    let confidence: Double
    let generatedAt: String
    let artifactPath: String?
    let privacyLevel: String
}

struct UserTask: Identifiable, Hashable, Codable {
    let id: UUID
    let title: String
    let detail: String
    let status: String
    let priority: Int
    let source: String
    let evidenceID: UUID?
    let tokenID: String?
    let messageID: UUID?
    let generatedAt: String
    let artifactPath: String?
}

struct WatchlistItem: Identifiable, Hashable, Codable {
    let id: UUID
    let tokenID: String
    let symbol: String
    let chain: String
    let contractAddress: String?
    let status: String
    let source: String
    let freshness: String
    let createdAt: String
    let reason: String
}

struct AlertRule: Identifiable, Hashable, Codable {
    let id: UUID
    let tokenID: String
    let ruleType: String
    let thresholdDescription: String
    let status: String
    let source: String
    let generatedAt: String
    let artifactPath: String?
}

struct ArtifactReference: Identifiable, Hashable, Codable {
    let id: UUID
    let label: String
    let kind: String
    let path: String
    let status: String
    let source: String
    let freshness: String
    let generatedAt: String
    let runID: String?
}

struct RuntimeStoreManifest: Hashable, Codable {
    let runID: String
    let generatedAt: String
    let references: [ArtifactReference]
    let requiredPaths: [String]
    let missingRequiredPaths: [String]
    let completenessStatus: String

    static let empty = RuntimeStoreManifest(
        runID: "--",
        generatedAt: "--",
        references: [],
        requiredPaths: [],
        missingRequiredPaths: [],
        completenessStatus: "not_run"
    )
}

struct RuntimeHealthCheck: Identifiable, Hashable, Codable {
    let id: UUID
    let name: String
    let status: String
    let source: String
    let detail: String
    let generatedAt: String
    let artifactPath: String?
}

struct DataRetentionPolicy: Hashable, Codable {
    let policyID: String
    let status: String
    let retentionWindowDays: Int
    let cleanupPlan: String
    let generatedAt: String
}

struct PrivacyRedactionPolicy: Hashable, Codable {
    let policyID: String
    let status: String
    let importBoundary: String
    let secretsBoundary: String
    let liveWeChatBoundary: String
    let generatedAt: String
}

struct RuntimeHealthReport: Hashable, Codable {
    let generatedAt: String
    let overallStatus: String
    let checks: [RuntimeHealthCheck]
    let retentionPolicy: DataRetentionPolicy
    let privacyPolicy: PrivacyRedactionPolicy

    static let empty = RuntimeHealthReport(
        generatedAt: "--",
        overallStatus: "not_run",
        checks: [],
        retentionPolicy: DataRetentionPolicy(
            policyID: "retention_default",
            status: "not_run",
            retentionWindowDays: 30,
            cleanupPlan: "No destructive cleanup is performed automatically.",
            generatedAt: "--"
        ),
        privacyPolicy: PrivacyRedactionPolicy(
            policyID: "privacy_default",
            status: "not_run",
            importBoundary: "fixture_only",
            secretsBoundary: "no_secrets_stored",
            liveWeChatBoundary: "blocked",
            generatedAt: "--"
        )
    )
}

enum AgentModuleID: String, Hashable, Codable, CaseIterable {
    case ingestion
    case entityResolver
    case marketData
    case onchain
    case memory
    case crystal
    case evidence
    case proposal
    case handoff
    case session
    case alert
    case task
    case briefing
    case qaPolicy
    case review
}

enum AgentModuleStatus: String, Hashable, Codable {
    case planned
    case running
    case completed
    case degraded
    case failed
    case skipped
}

struct AgentModuleRun: Identifiable, Hashable, Codable {
    var id: String { "\(runID)-\(moduleID.rawValue)" }

    let moduleID: AgentModuleID
    let runID: String
    let status: AgentModuleStatus
    let startedAt: String
    let completedAt: String?
    let inputSummary: String
    let outputSummary: String
    let producedArtifacts: [String]
    let evidenceIDs: [UUID]
    let error: String?
    let degradedReason: String?
}

enum SubagentStatus: String, Hashable, Codable {
    case created
    case planned
    case running
    case completed
    case degraded
    case failed
    case cancelled
    case archived
    case skipped
}

enum SubagentType: String, Hashable, Codable {
    case ingestion
    case entityResolver
    case marketData
    case onchain
    case memory
    case crystal
    case evidence
    case proposal
    case handoff
    case session
    case briefing
    case alert
    case task
    case qaPolicy
    case review
}

struct SubagentRun: Identifiable, Hashable, Codable {
    var id: String { runID }

    let runID: String
    let parentRunID: String
    let agentType: SubagentType
    let taskScope: String
    let status: SubagentStatus
    let startedAt: String
    let completedAt: String?
    let inputSummary: String
    let outputSummary: String
    let artifact: String
    let error: String?
}

struct SourceHealth: Identifiable, Hashable, Codable {
    var id: String { source }

    let source: String
    let status: String
    let freshness: String
    let lastSuccessfulRefresh: String?
    let artifactPath: String?
    let degradedReason: String?
}

struct TerminalDataSnapshot: Hashable, Codable {
    let normalizedMessages: [NormalizedWeChatMessage]
    let tokenEntities: [TokenEntity]
    let marketSnapshots: [MarketDataSnapshot]
    let onchainSnapshots: [OnchainSnapshot]
    let evidenceItems: [EvidenceItem]
    let tasks: [UserTask]
    let alerts: [AlertRecord]
    let watchlistItems: [WatchlistItem]
    let alertRules: [AlertRule]
    let artifactManifest: RuntimeStoreManifest
    let runtimeHealth: RuntimeHealthReport
    let moduleRuns: [AgentModuleRun]
    let subagentRuns: [SubagentRun]
    let sourceHealth: [SourceHealth]
    let proactive: ProactiveRuntimeData

    init(
        normalizedMessages: [NormalizedWeChatMessage],
        tokenEntities: [TokenEntity],
        marketSnapshots: [MarketDataSnapshot],
        onchainSnapshots: [OnchainSnapshot],
        evidenceItems: [EvidenceItem],
        tasks: [UserTask],
        alerts: [AlertRecord],
        watchlistItems: [WatchlistItem],
        alertRules: [AlertRule],
        artifactManifest: RuntimeStoreManifest,
        runtimeHealth: RuntimeHealthReport,
        moduleRuns: [AgentModuleRun],
        subagentRuns: [SubagentRun],
        sourceHealth: [SourceHealth],
        proactive: ProactiveRuntimeData = .empty
    ) {
        self.normalizedMessages = normalizedMessages
        self.tokenEntities = tokenEntities
        self.marketSnapshots = marketSnapshots
        self.onchainSnapshots = onchainSnapshots
        self.evidenceItems = evidenceItems
        self.tasks = tasks
        self.alerts = alerts
        self.watchlistItems = watchlistItems
        self.alertRules = alertRules
        self.artifactManifest = artifactManifest
        self.runtimeHealth = runtimeHealth
        self.moduleRuns = moduleRuns
        self.subagentRuns = subagentRuns
        self.sourceHealth = sourceHealth
        self.proactive = proactive
    }

    static let empty = TerminalDataSnapshot(
        normalizedMessages: [],
        tokenEntities: [],
        marketSnapshots: [],
        onchainSnapshots: [],
        evidenceItems: [],
        tasks: [],
        alerts: [],
        watchlistItems: [],
        alertRules: [],
        artifactManifest: .empty,
        runtimeHealth: .empty,
        moduleRuns: [],
        subagentRuns: [],
        sourceHealth: [],
        proactive: .empty
    )

    private enum CodingKeys: String, CodingKey {
        case normalizedMessages
        case tokenEntities
        case marketSnapshots
        case onchainSnapshots
        case evidenceItems
        case tasks
        case alerts
        case watchlistItems
        case alertRules
        case artifactManifest
        case runtimeHealth
        case moduleRuns
        case subagentRuns
        case sourceHealth
        case proactive
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.normalizedMessages = try container.decode([NormalizedWeChatMessage].self, forKey: .normalizedMessages)
        self.tokenEntities = try container.decode([TokenEntity].self, forKey: .tokenEntities)
        self.marketSnapshots = try container.decode([MarketDataSnapshot].self, forKey: .marketSnapshots)
        self.onchainSnapshots = try container.decode([OnchainSnapshot].self, forKey: .onchainSnapshots)
        self.evidenceItems = try container.decode([EvidenceItem].self, forKey: .evidenceItems)
        self.tasks = try container.decode([UserTask].self, forKey: .tasks)
        self.alerts = try container.decode([AlertRecord].self, forKey: .alerts)
        self.watchlistItems = try container.decode([WatchlistItem].self, forKey: .watchlistItems)
        self.alertRules = try container.decode([AlertRule].self, forKey: .alertRules)
        self.artifactManifest = try container.decode(RuntimeStoreManifest.self, forKey: .artifactManifest)
        self.runtimeHealth = try container.decode(RuntimeHealthReport.self, forKey: .runtimeHealth)
        self.moduleRuns = try container.decode([AgentModuleRun].self, forKey: .moduleRuns)
        self.subagentRuns = try container.decode([SubagentRun].self, forKey: .subagentRuns)
        self.sourceHealth = try container.decode([SourceHealth].self, forKey: .sourceHealth)
        self.proactive = try container.decodeIfPresent(ProactiveRuntimeData.self, forKey: .proactive) ?? .empty
    }
}
