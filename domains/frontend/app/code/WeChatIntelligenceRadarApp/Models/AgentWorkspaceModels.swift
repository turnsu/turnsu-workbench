import Foundation

struct AgentDaemonStatus: Codable, Hashable {
    struct DaemonInfo: Codable, Hashable {
        let pid: Int?
        let host: String
        let port: Int
        let startedAt: String?
        let runtimeRoot: String?
    }

    struct ProviderStatus: Codable, Hashable, Identifiable {
        var id: String { provider }
        let provider: String
        let role: String?
        let ready: Bool
        let missingEnv: [String]
        let apiKeyEnv: String?
        let baseUrlConfigured: Bool?
        let model: String?
        let state: String?
        let connectionState: String?
        let configured: Bool?
        let connected: Bool?
        let degraded: Bool?
        let providerType: String?
        let rawSecretsReturned: Bool?
        let requestBodyReturned: Bool?
    }

    let schemaVersion: String?
    let status: String
    let daemon: DaemonInfo?
    let providers: [ProviderStatus]
    let capabilities: [AgentCapabilityManifest]
    let skills: [AgentSkillManifest]?
    let extensions: [AgentExtensionManifest]?
    let templates: [AgentSurfaceTemplateManifest]?
    let tools: [AgentToolManifest]
    let internalToolsExposed: Bool?
    let policy: [String: String]?

    static let unavailable = AgentDaemonStatus(
        schemaVersion: "agent-runtime-host-health-v1",
        status: "unavailable",
        daemon: nil,
        providers: [],
        capabilities: [],
        skills: [],
        extensions: [],
        templates: [],
        tools: [],
        internalToolsExposed: false,
        policy: [
            "liveWechat": "read_only_auto_refresh_when_enabled",
            "liveWechatCLI": "raw_cli_command_blocked",
            "trade": "blocked",
            "sendMessage": "blocked",
            "publishExternal": "blocked",
            "computerUse": "needs_confirmation"
        ]
    )
}

struct AgentCapabilityManifest: Codable, Hashable, Identifiable {
    var id: String { capabilityId }
    let capabilityId: String
    let title: String?
    let description: String
    let toolIntents: [String]
    let policy: [String]
    let observability: [String]
    let installState: String
    let status: String
}

struct AgentToolManifest: Codable, Hashable, Identifiable {
    var id: String { name }
    let name: String
    let permission: String
    let description: String
}

struct AgentSkillManifest: Codable, Hashable, Identifiable {
    var id: String { skillID }
    let skillID: String
    let title: String
    let description: String
    let category: String?
    let defaultSelected: Bool?
    let status: String
    let permissionSummary: String?
}

struct AgentExtensionManifest: Codable, Hashable, Identifiable {
    var id: String { extensionID }
    let extensionID: String
    let title: String
    let description: String
    let category: String?
    let defaultSelected: Bool?
    let status: String
    let permissionSummary: String?
}

struct AgentSurfaceTemplateManifest: Codable, Hashable, Identifiable {
    var id: String { templateID }
    let templateID: String
    let title: String
    let skillIDs: [String]
    let extensionIDs: [String]
}

struct AgentSession: Codable, Hashable, Identifiable {
    var id: String { sessionID }
    let schemaVersion: String?
    let sessionID: String
    let title: String
    let createdAt: String
    let updatedAt: String
    let status: String
    let activeRunID: String?
    let messages: [AgentMessage]
}

struct AgentMessage: Codable, Hashable, Identifiable {
    let id: String
    let role: String
    let content: [AgentContentPart]
    let attachments: [AgentAttachment]?
    let contextRefs: [RuntimeObjectReference]?
    let runID: String?
    let createdAt: String

    var plainText: String {
        content.map(\.text).joined(separator: "\n")
    }
}

struct AgentContentPart: Codable, Hashable {
    let type: String
    let text: String
}

struct AgentAttachment: Codable, Hashable, Identifiable {
    var id: String { attachmentID }
    let attachmentID: String
    let fileName: String
    let originalPath: String
    let artifactPath: String
    let mimeType: String
    let sha256: String
    let sizeBytes: Int
    let status: String
    let analysisPath: String?
    let createdAt: String
}

struct AgentStreamEvent: Codable, Hashable, Identifiable {
    let eventID: String
    let timestamp: String
    let type: String
    let runID: String?
    let taskID: String?
    let sessionID: String?
    let stage: String?
    let action: String?
    let actionIntent: String?
    let riskLevel: String?
    let artifactKind: String?
    let contextSourceCount: Int?
    let contextChunkCount: Int?
    let delta: String?
    let toolName: String?
    let status: String?
    let permission: String?
    let reason: String?
    let provider: String?
    let model: String?
    let artifactPath: String?
    let errorPreview: String?
    var finalReadModelPath: String? = nil
    var finalText: String? = nil

    var id: String { eventID }
}

struct AgentToolCallRecord: Codable, Hashable, Identifiable {
    let id: String
    let toolName: String
    let status: String
    let permission: String
    let inputSummary: String
    let outputSummary: String
    let artifactPath: String
    let detailsArtifactPath: String?
    let redactionStatus: String?
    let createdAt: String
}

struct AgentLongTask: Codable, Hashable, Identifiable {
    var id: String { taskID }
    let taskID: String
    let sessionID: String
    let runID: String
    let prompt: String
    let status: String
    let selectedToolNames: [String]
    let selectedSkillIDs: [String]?
    let selectedExtensionIDs: [String]?
    let attachmentIDs: [String]
    let artifactPath: String
    let createdAt: String
    let updatedAt: String
}

struct AgentMessageResponse: Codable, Hashable {
    let session: AgentSession
    let task: AgentLongTask
    let runID: String
    let toolCalls: [AgentToolCallRecord]
    let policies: [AgentPolicyDecision]
}

struct AgentAsyncMessageResponse: Codable, Hashable {
    let schemaVersion: String?
    let session: AgentSession
    let task: AgentLongTask
    let runID: String
    let taskID: String
    let eventsURL: String
    let artifactPath: String
    let acceptedAt: String
}

struct AgentPolicyDecision: Codable, Hashable, Identifiable {
    let id: String
    let action: String
    let status: String
    let reason: String
    let displayTitle: String?
    let displayReason: String?
    let severity: String?
    let publicSummary: String?
    let createdAt: String
}

enum AgentRuntimeStage: String, Codable, Hashable {
    case start
    case intent
    case profile
    case context
    case planner
    case policy
    case approval
    case modelRoute = "model_route"
    case toolExecution = "tool_execution"
    case modelStream = "model_stream"
    case qa
    case metrics
    case checkpoint
    case finalOutput = "final_output"
    case control
    case paused
    case cancelled
    case failed
    case unknown
}

struct AgentArtifactIndexItem: Codable, Hashable, Identifiable {
    var id: String { artifactPath }
    let name: String
    let kind: String
    let stage: String?
    let artifactPath: String
}

struct AgentContextPlaneSummary: Codable, Hashable {
    let schemaVersion: String?
    let runID: String
    let taskID: String
    let status: String
    let sourceCount: Int
    let chunkCount: Int
    let selectedChunkCount: Int?
    let missingSourceCount: Int
    let staleChunkCount: Int
    let artifactPath: String?
    let updatedAt: String?
}

struct AgentControlPlaneSummary: Codable, Hashable {
    let schemaVersion: String?
    let runID: String
    let taskID: String
    let taskType: String
    let profileID: String
    let stage: String
    let toolIntentCount: Int
    let policyDecisionCount: Int
    let blockedPolicyCount: Int
    let approvalDecisionCount: Int
    let qaStatus: String
    let modelReadinessStatus: String
    let artifactPath: String?
    let updatedAt: String?
}

struct AgentRunManifest: Codable, Hashable {
    let schemaVersion: String?
    let runID: String
    let taskID: String
    let sessionID: String?
    let status: String
    let currentStage: String
    let publicSurfaceOnly: Bool
    let internalToolsExposed: Bool
    let selectedSkillIDs: [String]?
    let selectedExtensionIDs: [String]?
    let contextSummary: AgentContextPlaneSummary?
    let controlSummary: AgentControlPlaneSummary?
    let artifacts: [AgentArtifactIndexItem]
    let redactionStatus: String?
    let finalOutputPath: String?
    var finalReadModelPath: String? = nil
    var productMutationPolicy: ProductMutationPolicy? = nil
    let toolCallCount: Int?
    let updatedAt: String?
    let completedAt: String?
}

struct AgentFinalReadModel: Codable, Hashable {
    let schemaVersion: String
    let runID: String
    let taskID: String
    let sessionID: String?
    let status: String
    let finalText: String
    let finalTextSource: String
    let outputGuardStatus: String
    let outputGuardReason: String?
    let cmcGateSummary: CMCGateSummary?
    let productMutationPolicy: ProductMutationPolicy?
    var workspaceMutationPolicy: ProductMutationPolicy? = nil
    var modelRouteSummary: AgentModelRouteSummary? = nil
    let generatedAt: String
    let artifactPath: String?
}

struct AgentModelRouteSummary: Codable, Hashable {
    let schemaVersion: String?
    let selectedTextProvider: String?
    let selectedTextModel: String?
    let selectionSource: String?
    let finalModel: String?
    let fallbackUsed: Bool?
    let userVisibleNoteRequired: Bool?
    let attemptCount: Int?
}

struct AgentModelPreference: Codable, Hashable {
    let mode: String
    let textModel: String?
    let fallbackPolicy: String
}

enum AgentModelPreferenceOption: String, CaseIterable, Identifiable {
    case auto = "auto"
    case deepseekV4Pro = "deepseek-v4-pro"
    case deepseekV4Flash = "deepseek-v4-flash"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .auto: return "自动"
        case .deepseekV4Pro: return "deepseek-v4-pro"
        case .deepseekV4Flash: return "deepseek-v4-flash"
        }
    }

    var requestPayload: AgentModelPreference {
        switch self {
        case .auto:
            return AgentModelPreference(mode: "auto", textModel: nil, fallbackPolicy: "continue_with_eligible_models")
        case .deepseekV4Pro:
            return AgentModelPreference(mode: "explicit", textModel: rawValue, fallbackPolicy: "continue_with_eligible_models")
        case .deepseekV4Flash:
            return AgentModelPreference(mode: "explicit", textModel: rawValue, fallbackPolicy: "continue_with_eligible_models")
        }
    }
}

struct CMCGateSummary: Codable, Hashable {
    let status: String
    let provider: String?
    let freshness: String?
    let transportStatus: String?
    var skillHubDisplay: CMCSkillHubDisplaySummary? = nil
    var skillHubDisplayStatus: String? = nil
    var allowSkillHubResultDisplay: Bool? = nil
    var displayableResultText: String? = nil
    var displayableResultSource: String? = nil
    var parserEvidenceStatus: String? = nil
    var allowSkillHubReturnedPrices: Bool? = nil
    var skillHubReturnedPriceTokenCount: Int? = nil
    var skillHubReturnedTextSource: String? = nil
    var skillHubReturnedTextCharCount: Int? = nil
    var researchEvidence: CMCResearchEvidenceSummary? = nil
    let researchEvidenceStatus: String?
    let readableEvidenceCount: Int?
    let emptyEvidenceReason: String?
    var priceSnapshot: CMCPriceSnapshotSummary? = nil
    let priceSnapshotStatus: String?
    let assetCount: Int?
    let allowResearchConclusion: Bool?
    let allowConcretePrices: Bool?
    let reason: String?
}

struct CMCSkillHubDisplaySummary: Codable, Hashable {
    let status: String?
    let allowSkillHubResultDisplay: Bool?
    let displayableResultText: String?
    let displayableResultSource: String?
    let parserEvidenceStatus: String?
    let allowSkillHubReturnedPrices: Bool?
    let skillHubReturnedPriceTokenCount: Int?
    let skillHubReturnedTextSource: String?
    let skillHubReturnedTextCharCount: Int?
}

struct CMCResearchEvidenceSummary: Codable, Hashable {
    let status: String?
    let readableEvidenceCount: Int?
    let emptyEvidenceReason: String?
    let source: String?
    let allowResearchConclusion: Bool?
}

struct CMCPriceSnapshotSummary: Codable, Hashable {
    let status: String?
    let assetCount: Int?
    let allowConcretePrices: Bool?
    let provider: String?
    let freshness: String?
}

struct CMCCapabilitySummary: Codable, Hashable {
    let schemaVersion: String?
    var renderSchemaVersion: String? = nil
    let capabilityID: String
    let displayName: String
    let packageTitle: String
    let runID: String?
    let mountStatus: String?
    let transportStatus: String?
    let provider: String?
    let skill: String?
    let status: String?
    let confidence: String?
    let summary: String?
    var returnedContent: CMCReturnedContent? = nil
    var renderBlocks: [CMCRenderBlock]? = nil
    var diagnostics: CMCRenderDiagnostics? = nil
    var claimPolicy: CMCRenderClaimPolicy? = nil
    let readableEvidence: [CMCCapabilityEvidenceSection]?
    let readableEvidenceCount: Int?
    var skillHubDisplayStatus: String? = nil
    var allowSkillHubResultDisplay: Bool? = nil
    var displayableResultText: String? = nil
    var displayableResultSource: String? = nil
    var parserEvidenceStatus: String? = nil
    var allowSkillHubReturnedPrices: Bool? = nil
    var skillHubReturnedPriceTokenCount: Int? = nil
    var skillHubReturnedTextSource: String? = nil
    var skillHubReturnedTextCharCount: Int? = nil
    let researchEvidenceStatus: String?
    let emptyEvidenceReason: String?
    let priceSnapshotStatus: String?
    let assetCount: Int?
    let allowResearchConclusion: Bool?
    let allowConcretePrices: Bool?
    let missingOrStaleInputs: [String]?
    let notableAnomalies: [String]?
    let generatedAt: String?
    let sourceObservationCount: Int?
    var workspaceMutationPolicy: CMCWorkspaceMutationPolicy? = nil
}

struct CMCReturnedContent: Codable, Hashable {
    let summary: String?
    let conclusion: String?
    let marketRead: String?
    let readableEvidence: [CMCCapabilityEvidenceSection]?
}

struct CMCRenderBlock: Codable, Hashable, Identifiable {
    var id: String { "\(type ?? "block"):\(title ?? ""):\(body.prefix(32))" }
    let type: String?
    let title: String?
    let body: String
    let source: String?
    let observedAt: String?
}

struct CMCRenderDiagnostics: Codable, Hashable {
    let parserEvidenceStatus: String?
    let researchEvidenceStatus: String?
    let priceSnapshotStatus: String?
    let assetCount: Int?
    let emptyEvidenceReason: String?
    let freshness: String?
    let confidence: String?
    let risk: String?
    let sourceTrust: String?
    let degraded: Bool?
}

struct CMCRenderClaimPolicy: Codable, Hashable {
    let appMayAddConcretePrices: Bool?
    let providerReturnedNumbersMayRender: Bool?
    let appMayAddTradingLevels: Bool?
}

struct CloudASRSummary: Codable, Hashable {
    let schemaVersion: String?
    let runID: String
    let sessionID: String?
    let status: String
    let cloudASRStatus: String?
    let provider: String?
    let providerID: String?
    let model: String?
    let uploadProvider: String?
    let cloudUpload: Bool?
    let userVisibleLabel: String?
    let reason: String?
    let speakerDiarizationStatus: String?
    let needsTranscriptReview: Bool?
    let transcriptPath: String?
    let sourcePackPath: String?
    let segmentCount: Int?
    let boundedChunkCount: Int?
    let sourceAttachmentIDs: [String]?
    let rawAudioStored: Bool?
    let rawProviderRequestIncluded: Bool?
    let rawProviderResponseIncluded: Bool?
    let secretsIncluded: Bool?
    let generatedAt: String?
    let artifactPath: String?

    var displayStatus: String {
        "\(userVisibleLabel ?? "云端转写 · 阿里云百炼") · \(cloudASRStatus ?? status)"
    }
}

struct CMCWorkspaceMutationPolicy: Codable, Hashable {
    let scope: String?
    let displayEligibleEvenWhenDiscarded: Bool?
}

struct CMCCapabilityEvidenceSection: Codable, Hashable, Identifiable {
    var id: String { title }
    let title: String
    let bullets: [String]
}

struct ProductMutationPolicy: Codable, Hashable {
    let status: String
    let reason: String?
    let decidedAt: String?
}

struct HarnessSessionTreeReadModel: Codable, Hashable {
    let schemaVersion: String
    let sessionID: String
    let rootRunID: String
    let activeBranchID: String
    let branches: [HarnessBranchReadModel]
    let reviewBranches: [HarnessBranchReadModel]
    let terminalBranches: [String]
    let createdAt: String
    let updatedAt: String
    let artifactPath: String?
}

struct HarnessBranchReadModel: Codable, Hashable, Identifiable {
    var id: String { branchID }
    let branchID: String
    let runID: String
    let parentBranchID: String?
    let branchType: String
    let status: String
    let sourceStepID: String?
    let finalReadModelPath: String?
    let reviewReadModelPath: String?
    let createdAt: String
    let updatedAt: String
}

struct HarnessBranchLineageReadModel: Codable, Hashable {
    let schemaVersion: String
    let sessionID: String
    let runID: String
    let branchID: String
    let parentBranchID: String?
    let sourceRunID: String?
    let sourceStepID: String?
    let branchType: String
    let mergeTargetBranchID: String?
    let mergeDecision: String
    let mergeReason: String?
    let relatedBranches: [HarnessBranchLineageBranch]?
    let createdAt: String?
    let updatedAt: String?
    let artifactPath: String?
}

struct HarnessBranchLineageBranch: Codable, Hashable, Identifiable {
    var id: String { branchID }
    let runID: String
    let branchID: String
    let parentBranchID: String?
    let sourceRunID: String?
    let sourceStepID: String?
    let branchType: String
    let mergeTargetBranchID: String?
    let mergeDecision: String
    let mergeReason: String?
    let reviewReadModelPath: String?
    let createdAt: String?
}

struct ReviewReadModel: Codable, Hashable {
    let schemaVersion: String
    let reviewRunID: String
    let sourceRunID: String
    let sourceBranchID: String
    let status: String
    let findings: [ReviewFinding]
    let checkedArtifacts: [ReviewCheckedArtifact]
    let cmcGateSummary: CMCGateSummary?
    let outputGuardStatus: String
    let mutationPolicyAssessment: ReviewMutationPolicyAssessment?
    let mergeRecommendation: String
    let generatedAt: String
    let artifactPath: String?
}

struct ReviewFinding: Codable, Hashable, Identifiable {
    var id: String { findingID }
    let findingID: String
    let severity: String
    let title: String
    let detail: String
    let artifactPath: String?
}

struct ReviewCheckedArtifact: Codable, Hashable {
    let name: String
    let artifactPath: String
    let status: String
}

struct ReviewMutationPolicyAssessment: Codable, Hashable {
    let status: String
    let reason: String?
    let importAllowed: Bool
}

struct CapabilityLoopReadModel: Codable, Hashable {
    let schemaVersion: String
    let runID: String
    let taskID: String
    let sessionID: String?
    let loopType: String
    let status: String
    let title: String
    let userGoal: String?
    let capabilityPackages: [CapabilityLoopPackage]
    let finalReadModelPath: String?
    let review: CapabilityLoopReviewSummary
    let followUpSuggestions: [CapabilityLoopSuggestion]
    let cmcCapabilitySummaryPath: String?
    let memoryReadModelPath: String?
    let subagentCoordinationReadModelPath: String?
    let generatedAt: String
    let artifactPath: String?
}

struct CapabilityLoopPackage: Codable, Hashable, Identifiable {
    var id: String { packageID }
    let packageID: String
    let displayName: String
    let domain: String
    let status: String
    let summary: String?
}

struct CapabilityLoopReviewSummary: Codable, Hashable {
    let status: String
    let ready: Bool
    let actionLabel: String?
    let reviewReadModelPath: String?
    let mergeRecommendation: String?
}

struct CapabilityLoopSuggestion: Codable, Hashable, Identifiable {
    var id: String { suggestionID }
    let suggestionID: String
    let title: String
    let prompt: String
}

struct AgentMemoryReadModel: Codable, Hashable {
    let schemaVersion: String
    let runID: String
    let taskID: String
    let sessionID: String?
    let status: String
    let adapter: String
    let adapterPath: String?
    let reason: String?
    let writePolicy: AgentMemoryWritePolicy
    let candidateMemories: [AgentMemoryCandidate]
    let redaction: AgentMemoryRedaction
    let generatedAt: String
    let artifactPath: String?
}

struct AgentMemoryWritePolicy: Codable, Hashable {
    let status: String
    let reason: String?
    let requiresHumanReview: Bool
}

struct AgentMemoryCandidate: Codable, Hashable, Identifiable {
    var id: String { memoryID }
    let memoryID: String
    let type: String
    let title: String
    let preview: String
    let sourceArtifactPath: String?
    let reviewRequired: Bool
}

struct AgentMemoryRedaction: Codable, Hashable {
    let rawProviderPayloadStored: Bool
    let secretsStored: Bool
    let privateTranscriptStored: Bool
}

struct SubagentCoordinationReadModel: Codable, Hashable {
    let schemaVersion: String
    let runID: String
    let taskID: String
    let sessionID: String?
    let status: String
    let coordinator: String
    let tmuxVersion: String?
    let namespace: String
    let mode: String
    let reason: String?
    let plannedRoles: [String]
    let allowedOperations: [String]
    let blockedOperations: [String]
    let sessions: [String]
    let generatedAt: String
    let artifactPath: String?
}

struct AgentToolRegistryPayload: Codable {
    let capabilities: [AgentCapabilityManifest]
    let skills: [AgentSkillManifest]
    let extensions: [AgentExtensionManifest]
    let templates: [AgentSurfaceTemplateManifest]?
    let providers: [AgentDaemonStatus.ProviderStatus]?
    let extensionPackages: [AgentExtensionPackageStatus]?
    let tools: [AgentToolManifest]
    let internalToolsExposed: Bool?
}

struct AgentExtensionPackageStatus: Codable, Hashable, Identifiable {
    var id: String { packageID }
    let packageID: String
    let extensionID: String?
    let title: String?
    let mountState: String?
    let configuredState: String?
    let publicStatus: String?
    let publicSummary: String?
    let manifestToolCount: Int?
    let registeredToolCount: Int?
    let missingInternalTools: [String]?
    let piInitialized: Bool?

    private enum CodingKeys: String, CodingKey {
        case packageID = "id"
        case extensionID
        case title
        case mountState
        case configuredState
        case publicStatus
        case publicSummary
        case manifestToolCount
        case registeredToolCount
        case missingInternalTools
        case piInitialized
    }
}
