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
            "liveWechat": "blocked",
            "liveWechatCLI": "blocked",
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
    let toolCallCount: Int?
    let updatedAt: String?
    let completedAt: String?
}

struct AgentToolRegistryPayload: Codable {
    let capabilities: [AgentCapabilityManifest]
    let skills: [AgentSkillManifest]
    let extensions: [AgentExtensionManifest]
    let templates: [AgentSurfaceTemplateManifest]?
    let tools: [AgentToolManifest]
    let internalToolsExposed: Bool?
}
