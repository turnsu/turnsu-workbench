import Foundation

enum RuntimeObjectReferenceKind: String, Hashable, Codable, CaseIterable {
    case evidence
    case message
    case token
    case artifact
    case marketSnapshot
    case onchainSnapshot
    case memory
    case crystal
    case proposal
    case handoff
    case session
    case task
    case alert
    case watchlist
    case moduleRun
    case subagentRun
    case policyDecision
    case source
}

enum ProactiveFreshness: String, Hashable, Codable, CaseIterable {
    case fresh
    case fixture
    case currentRun = "current_run"
    case stale
    case degraded
    case blocked
    case notRun = "not_run"
    case unknown
}

enum ProactiveRiskLevel: String, Hashable, Codable, CaseIterable {
    case none
    case low
    case medium
    case high
    case critical
    case unknown
}

enum ProactiveRuntimeStatus: String, Hashable, Codable, CaseIterable {
    case idle
    case planned
    case running
    case completed
    case degraded
    case failed
    case blocked
    case notRun = "not_run"
    case archived
}

enum CrystalStatus: String, Hashable, Codable, CaseIterable {
    case new
    case watching
    case acted
    case dismissed
    case falsePositive = "false_positive"
    case archived
}

enum ProactiveNextActionType: String, Hashable, Codable, CaseIterable {
    case inspectEvidence = "inspect_evidence"
    case createTask = "create_task"
    case addToWatchlist = "add_to_watchlist"
    case createAlert = "create_alert"
    case requestBridgeRefresh = "request_bridge_refresh"
    case createHandoff = "create_handoff"
    case saveMemory = "save_memory"
    case review = "review"
    case noAction = "no_action"
}

enum ProposalAction: String, Hashable, Codable, CaseIterable {
    case createTask = "create_task"
    case addToWatchlist = "add_to_watchlist"
    case createAlert = "create_alert"
    case createHandoffDraft = "create_handoff_draft"
    case requestBridgeRefresh = "request_bridge_refresh"
    case saveMemory = "save_memory"
    case markReview = "mark_review"
    case noOp = "no_op"
}

enum ProposalPermission: String, Hashable, Codable, CaseIterable {
    case none
    case localRead = "local_read"
    case localWrite = "local_write"
    case userConfirmation = "user_confirmation"
    case externalBridge = "external_bridge"
    case exportOutsideProject = "export_outside_project"
    case blocked
}

enum ProposalStatus: String, Hashable, Codable, CaseIterable {
    case proposed
    case accepted
    case rejected
    case converted
    case blocked
    case expired
    case archived
}

enum MemoryEntryKind: String, Hashable, Codable, CaseIterable {
    case sourceQuality = "source_quality"
    case groupNarrative = "group_narrative"
    case knownAddress = "known_address"
    case userPreference = "user_preference"
    case falsePositive = "false_positive"
    case teamDecision = "team_decision"
    case reviewNote = "review_note"
}

enum MemoryEntryStatus: String, Hashable, Codable, CaseIterable {
    case active
    case needsReview = "needs_review"
    case superseded
    case purged
    case archived
}

enum HandoffPurpose: String, Hashable, Codable, CaseIterable {
    case meeting
    case shiftChange = "shift_change"
    case investmentReview = "investment_review"
    case teamUpdate = "team_update"
    case incidentReview = "incident_review"
}

enum HandoffStatus: String, Hashable, Codable, CaseIterable {
    case draft
    case ready
    case exported
    case archived
}

enum HandoffRedactionPolicy: String, Hashable, Codable, CaseIterable {
    case metadataOnly = "metadata_only"
    case privatePreviewRedacted = "private_preview_redacted"
    case localOnly = "local_only"
    case unredactedLocal = "unredacted_local"
}

enum RuntimeBridgeKind: String, Hashable, Codable, CaseIterable {
    case wechatImport = "wechat_import"
    case marketData = "market_data"
    case onchainData = "onchain_data"
    case externalAgent = "external_agent"
    case export
}

struct RuntimeObjectReference: Identifiable, Hashable, Codable {
    let id: String
    let kind: RuntimeObjectReferenceKind
    let label: String
    let path: String?
    let value: String?
    let source: String
    let freshness: ProactiveFreshness
    let confidence: Double?
    let privacyLevel: String?
    let redactionStatus: String?
    let generatedAt: String?
    let runID: String?
}

struct ProactiveNextAction: Hashable, Codable {
    let type: ProactiveNextActionType
    let title: String
    let detail: String
    let targetRefs: [RuntimeObjectReference]
    let permissionRequired: ProposalPermission
    let status: ProactiveRuntimeStatus
}

struct ProactiveProvenance: Hashable, Codable {
    let runID: String?
    let sessionID: UUID?
    let parentRunID: String?
    let moduleRunIDs: [String]
    let subagentRunIDs: [String]
    let policyDecisionRefs: [RuntimeObjectReference]
    let source: String
    let generatedAt: String
}

struct ProposalPermissionRequirement: Hashable, Codable {
    let permission: ProposalPermission
    let reason: String
    let policyDecisionRefs: [RuntimeObjectReference]
    let blockedReason: String?
}

struct IntelligenceCrystal: Identifiable, Hashable, Codable {
    let id: UUID
    let title: String
    let rationale: String
    let detail: String
    let sourceMix: [String]
    let evidenceRefs: [RuntimeObjectReference]
    let messageRefs: [RuntimeObjectReference]
    let tokenRefs: [RuntimeObjectReference]
    let artifactRefs: [RuntimeObjectReference]
    let memoryRefs: [RuntimeObjectReference]
    let freshness: ProactiveFreshness
    let sourceFreshness: [String: ProactiveFreshness]
    let risk: ProactiveRiskLevel
    let confidence: Double
    let nextAction: ProactiveNextAction
    let status: CrystalStatus
    let createdAt: String
    let updatedAt: String
    let provenance: ProactiveProvenance
}

struct AgentProposal: Identifiable, Hashable, Codable {
    let id: UUID
    let title: String
    let summary: String
    let rationale: String
    let action: ProposalAction
    let permission: ProposalPermissionRequirement
    let rejectionFallback: String
    let evidenceRefs: [RuntimeObjectReference]
    let messageRefs: [RuntimeObjectReference]
    let tokenRefs: [RuntimeObjectReference]
    let crystalRefs: [RuntimeObjectReference]
    let artifactRefs: [RuntimeObjectReference]
    let artifactsToWrite: [RuntimeObjectReference]
    let freshness: ProactiveFreshness
    let risk: ProactiveRiskLevel
    let confidence: Double
    let nextAction: ProactiveNextAction
    let status: ProposalStatus
    let createdAt: String
    let updatedAt: String
    let decidedAt: String?
    let decisionReason: String?
    let provenance: ProactiveProvenance
}

struct MemoryEntry: Identifiable, Hashable, Codable {
    let id: UUID
    let kind: MemoryEntryKind
    let title: String
    let content: String
    let subjectRef: RuntimeObjectReference?
    let sourceQualityScore: Double?
    let evidenceRefs: [RuntimeObjectReference]
    let messageRefs: [RuntimeObjectReference]
    let tokenRefs: [RuntimeObjectReference]
    let artifactRefs: [RuntimeObjectReference]
    let freshness: ProactiveFreshness
    let risk: ProactiveRiskLevel
    let confidence: Double
    let status: MemoryEntryStatus
    let createdAt: String
    let updatedAt: String
    let expiresAt: String?
    let purgeable: Bool
    let provenance: ProactiveProvenance
}

struct HandoffRedaction: Hashable, Codable {
    let policy: HandoffRedactionPolicy
    let redactedFields: [String]
    let privateContentIncluded: Bool
    let notes: String
}

struct HandoffPacket: Identifiable, Hashable, Codable {
    let id: UUID
    let title: String
    let purpose: HandoffPurpose
    let summaryText: String
    let selectedCrystalRefs: [RuntimeObjectReference]
    let evidenceRefs: [RuntimeObjectReference]
    let messageRefs: [RuntimeObjectReference]
    let tokenRefs: [RuntimeObjectReference]
    let artifactRefs: [RuntimeObjectReference]
    let openTaskRefs: [RuntimeObjectReference]
    let unresolvedQuestions: [String]
    let sourceFreshness: [String: ProactiveFreshness]
    let degradedBoundaries: [String]
    let redaction: HandoffRedaction
    let freshness: ProactiveFreshness
    let risk: ProactiveRiskLevel
    let confidence: Double
    let nextAction: ProactiveNextAction
    let status: HandoffStatus
    let generatedAt: String
    let artifactPath: String?
    let provenance: ProactiveProvenance
}

struct HandoffPacketIndexEntry: Identifiable, Hashable, Codable {
    let id: UUID
    let title: String
    let purpose: HandoffPurpose
    let status: HandoffStatus
    let generatedAt: String
    let artifactPath: String?
    let redactionPolicy: HandoffRedactionPolicy
    let crystalCount: Int
}

struct RuntimeBridgeStatus: Identifiable, Hashable, Codable {
    let id: String
    let name: String
    let kind: RuntimeBridgeKind
    let status: ProactiveRuntimeStatus
    let permission: ProposalPermission
    let freshness: ProactiveFreshness
    let lastRunAt: String?
    let lastSuccessAt: String?
    let artifactPath: String?
    let errorMessage: String?
    let provenance: ProactiveProvenance?
}

struct ProactiveSession: Identifiable, Hashable, Codable {
    let id: UUID
    let runID: String
    let parentRunID: String?
    let status: ProactiveRuntimeStatus
    let selectedWindow: TimeWindow
    let sourceScope: [String]
    let permissionBoundary: ProposalPermission
    let sourceFreshness: [String: ProactiveFreshness]
    let startedAt: String
    let completedAt: String?
    let lastSuccessAt: String?
    let nextRecommendedRun: String?
    let createdCrystalRefs: [RuntimeObjectReference]
    let generatedProposalRefs: [RuntimeObjectReference]
    let memoryRefs: [RuntimeObjectReference]
    let handoffRefs: [RuntimeObjectReference]
    let artifactRefs: [RuntimeObjectReference]
    let moduleRuns: [AgentModuleRun]
    let subagentRuns: [SubagentRun]
    let bridgeStatuses: [RuntimeBridgeStatus]
    let healthStatus: String
    let degradedReason: String?
    let provenance: ProactiveProvenance
}

struct ProactiveRuntimeData: Hashable, Codable {
    let status: ProactiveRuntimeStatus
    let generatedAt: String
    let freshness: ProactiveFreshness
    let risk: ProactiveRiskLevel
    let confidence: Double
    let nextAction: ProactiveNextAction?
    let crystals: [IntelligenceCrystal]
    let proposals: [AgentProposal]
    let memory: [MemoryEntry]
    let handoffs: [HandoffPacket]
    let latestSession: ProactiveSession?
    let bridgeStatuses: [RuntimeBridgeStatus]

    static let empty = ProactiveRuntimeData(
        status: .notRun,
        generatedAt: "--",
        freshness: .notRun,
        risk: .unknown,
        confidence: 0,
        nextAction: nil,
        crystals: [],
        proposals: [],
        memory: [],
        handoffs: [],
        latestSession: nil,
        bridgeStatuses: []
    )
}
