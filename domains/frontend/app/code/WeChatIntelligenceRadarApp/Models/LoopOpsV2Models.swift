import Foundation

enum LoopOpsDomain: String, Codable, CaseIterable, Hashable, Identifiable {
    case crypto
    case markets
    case office

    var id: String { rawValue }

    var title: String {
        switch self {
        case .crypto:
            return "Crypto"
        case .markets:
            return "Markets"
        case .office:
            return "Office"
        }
    }

    init(workbenchDomain: WorkbenchDomain) {
        switch workbenchDomain {
        case .crypto:
            self = .crypto
        case .markets:
            self = .markets
        case .office:
            self = .office
        }
    }

    var workbenchDomain: WorkbenchDomain {
        switch self {
        case .crypto:
            return .crypto
        case .markets:
            return .markets
        case .office:
            return .office
        }
    }
}

enum LoopOpsVisibility: String, Codable, CaseIterable, Hashable {
    case `private`
    case shared
    case imported
}

enum LoopOpsContractStatus: String, Codable, CaseIterable, Hashable {
    case draft
    case saved
    case archived
}

enum LoopOpsScheduleMode: String, Codable, CaseIterable, Hashable {
    case manual
    case scheduled
}

enum LoopOpsInputKind: String, Codable, CaseIterable, Hashable {
    case prompt
    case file
    case image
    case audio
    case video
    case marketSymbol
    case loopContext
    case freeform
}

struct LoopOpsInputBinding: Codable, Hashable, Identifiable {
    let id: String
    let label: String
    let kind: LoopOpsInputKind
    let required: Bool
    let valueHint: String?

    init(
        id: String,
        label: String,
        kind: LoopOpsInputKind,
        required: Bool = false,
        valueHint: String? = nil
    ) {
        self.id = id
        self.label = label
        self.kind = kind
        self.required = required
        self.valueHint = valueHint
    }
}

enum LoopOpsCapabilityCategory: String, Codable, CaseIterable, Hashable {
    case marketData
    case research
    case review
    case drafting
    case transcription
    case deliveryPreview
    case context
}

struct LoopOpsCapabilityReference: Codable, Hashable, Identifiable {
    let id: String
    let title: String
    let summary: String
    let category: LoopOpsCapabilityCategory

    init(
        id: String,
        title: String,
        summary: String,
        category: LoopOpsCapabilityCategory
    ) {
        self.id = id
        self.title = title
        self.summary = summary
        self.category = category
    }
}

struct LoopOpsTemplateMigrationSource: Codable, Hashable {
    let sourceTemplateID: String
    let sourceTemplateTitle: String
    let launchPrompt: String
    let legacySkillIDs: [String]
    let legacyExtensionIDs: [String]

    init(
        sourceTemplateID: String,
        sourceTemplateTitle: String,
        launchPrompt: String,
        legacySkillIDs: [String],
        legacyExtensionIDs: [String]
    ) {
        self.sourceTemplateID = sourceTemplateID
        self.sourceTemplateTitle = sourceTemplateTitle
        self.launchPrompt = launchPrompt
        self.legacySkillIDs = legacySkillIDs
        self.legacyExtensionIDs = legacyExtensionIDs
    }
}

struct LoopOpsLoopContract: Codable, Hashable, Identifiable {
    static let schemaVersion = "loopops-loop-contract-v1"

    let schemaVersion: String
    let id: String
    let name: String
    let domain: LoopOpsDomain
    let goal: String
    let trigger: String
    let inputBindings: [LoopOpsInputBinding]
    let userFacingCapabilityChain: [LoopOpsCapabilityReference]
    let stepSummary: [String]
    let feedbackGate: String
    let exitCondition: String
    let reviewBoundary: String
    let outputShape: String
    let scheduleMode: LoopOpsScheduleMode
    let version: Int
    let owner: String
    let visibility: LoopOpsVisibility
    let status: LoopOpsContractStatus
    let knowledgeSourceIDs: [String]
    let skillStackID: String?
    let createdAt: String
    let updatedAt: String
    let templateMigration: LoopOpsTemplateMigrationSource?

    init(
        schemaVersion: String = LoopOpsLoopContract.schemaVersion,
        id: String,
        name: String,
        domain: LoopOpsDomain,
        goal: String,
        trigger: String,
        inputBindings: [LoopOpsInputBinding],
        userFacingCapabilityChain: [LoopOpsCapabilityReference],
        stepSummary: [String],
        feedbackGate: String,
        exitCondition: String,
        reviewBoundary: String,
        outputShape: String,
        scheduleMode: LoopOpsScheduleMode = .manual,
        version: Int = 1,
        owner: String,
        visibility: LoopOpsVisibility = .private,
        status: LoopOpsContractStatus = .draft,
        knowledgeSourceIDs: [String] = [],
        skillStackID: String? = nil,
        createdAt: String,
        updatedAt: String,
        templateMigration: LoopOpsTemplateMigrationSource? = nil
    ) {
        self.schemaVersion = schemaVersion
        self.id = id
        self.name = name
        self.domain = domain
        self.goal = goal
        self.trigger = trigger
        self.inputBindings = inputBindings
        self.userFacingCapabilityChain = userFacingCapabilityChain
        self.stepSummary = stepSummary
        self.feedbackGate = feedbackGate
        self.exitCondition = exitCondition
        self.reviewBoundary = reviewBoundary
        self.outputShape = outputShape
        self.scheduleMode = scheduleMode
        self.version = version
        self.owner = owner
        self.visibility = visibility
        self.status = status
        self.knowledgeSourceIDs = knowledgeSourceIDs
        self.skillStackID = skillStackID
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.templateMigration = templateMigration
    }

    private enum CodingKeys: String, CodingKey {
        case schemaVersion
        case id
        case name
        case domain
        case goal
        case trigger
        case inputBindings
        case userFacingCapabilityChain
        case stepSummary
        case feedbackGate
        case exitCondition
        case reviewBoundary
        case outputShape
        case scheduleMode
        case version
        case owner
        case visibility
        case status
        case knowledgeSourceIDs
        case skillStackID
        case createdAt
        case updatedAt
        case templateMigration
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            schemaVersion: try container.decodeIfPresent(String.self, forKey: .schemaVersion) ?? Self.schemaVersion,
            id: try container.decode(String.self, forKey: .id),
            name: try container.decode(String.self, forKey: .name),
            domain: try container.decode(LoopOpsDomain.self, forKey: .domain),
            goal: try container.decode(String.self, forKey: .goal),
            trigger: try container.decode(String.self, forKey: .trigger),
            inputBindings: try container.decodeIfPresent([LoopOpsInputBinding].self, forKey: .inputBindings) ?? [],
            userFacingCapabilityChain: try container.decodeIfPresent([LoopOpsCapabilityReference].self, forKey: .userFacingCapabilityChain) ?? [],
            stepSummary: try container.decodeIfPresent([String].self, forKey: .stepSummary) ?? [],
            feedbackGate: try container.decode(String.self, forKey: .feedbackGate),
            exitCondition: try container.decode(String.self, forKey: .exitCondition),
            reviewBoundary: try container.decode(String.self, forKey: .reviewBoundary),
            outputShape: try container.decode(String.self, forKey: .outputShape),
            scheduleMode: try container.decodeIfPresent(LoopOpsScheduleMode.self, forKey: .scheduleMode) ?? .manual,
            version: try container.decodeIfPresent(Int.self, forKey: .version) ?? 1,
            owner: try container.decodeIfPresent(String.self, forKey: .owner) ?? "local-user",
            visibility: try container.decodeIfPresent(LoopOpsVisibility.self, forKey: .visibility) ?? .private,
            status: try container.decodeIfPresent(LoopOpsContractStatus.self, forKey: .status) ?? .draft,
            knowledgeSourceIDs: try container.decodeIfPresent([String].self, forKey: .knowledgeSourceIDs) ?? [],
            skillStackID: try container.decodeIfPresent(String.self, forKey: .skillStackID),
            createdAt: try container.decode(String.self, forKey: .createdAt),
            updatedAt: try container.decode(String.self, forKey: .updatedAt),
            templateMigration: try container.decodeIfPresent(LoopOpsTemplateMigrationSource.self, forKey: .templateMigration)
        )
    }

    static func fromTemplate(
        _ template: WorkbenchLoopTemplate,
        owner: String = "local-user",
        visibility: LoopOpsVisibility = .private,
        status: LoopOpsContractStatus = .draft,
        now: Date = Date()
    ) -> LoopOpsLoopContract {
        let timestamp = AgentDateFormatting.isoString(now)
        return LoopOpsLoopContract(
            id: "loop-contract-\(template.id)",
            name: template.title,
            domain: LoopOpsDomain(workbenchDomain: template.domain),
            goal: template.subtitle,
            trigger: template.trigger,
            inputBindings: Self.inputBindings(for: template),
            userFacingCapabilityChain: LoopOpsTemplateCapabilityNames.references(
                skillIDs: template.defaultSkillIDs,
                extensionIDs: template.defaultExtensionIDs
            ),
            stepSummary: template.stepsSummary,
            feedbackGate: template.feedbackGate,
            exitCondition: template.exitCondition,
            reviewBoundary: template.reviewBoundary,
            outputShape: template.outputShape,
            scheduleMode: .manual,
            version: 1,
            owner: owner,
            visibility: visibility,
            status: status,
            createdAt: timestamp,
            updatedAt: timestamp,
            templateMigration: LoopOpsTemplateMigrationSource(
                sourceTemplateID: template.id,
                sourceTemplateTitle: template.title,
                launchPrompt: template.prompt,
                legacySkillIDs: template.defaultSkillIDs,
                legacyExtensionIDs: template.defaultExtensionIDs
            )
        )
    }

    static func fromTemplates(
        _ templates: [WorkbenchLoopTemplate] = WorkbenchLoopTemplate.all,
        owner: String = "local-user",
        visibility: LoopOpsVisibility = .private,
        status: LoopOpsContractStatus = .draft,
        now: Date = Date()
    ) -> [LoopOpsLoopContract] {
        templates.map {
            fromTemplate($0, owner: owner, visibility: visibility, status: status, now: now)
        }
    }

    private static func inputBindings(for template: WorkbenchLoopTemplate) -> [LoopOpsInputBinding] {
        var bindings = [
            LoopOpsInputBinding(
                id: "\(template.id)-prompt",
                label: "Prompt",
                kind: .prompt,
                required: true,
                valueHint: template.prompt
            )
        ]

        if template.domain == .office {
            bindings.append(
                LoopOpsInputBinding(
                    id: "\(template.id)-source-material",
                    label: "Source material",
                    kind: .file,
                    required: false,
                    valueHint: "Files, images, audio, or video"
                )
            )
        }

        return bindings
    }
}

enum LoopOpsChatScope: String, Codable, CaseIterable, Hashable {
    case global
    case run
    case builder
    case review
}

enum LoopOpsChatRole: String, Codable, CaseIterable, Hashable {
    case user
    case assistant
    case system
}

enum LoopOpsAttachmentKind: String, Codable, CaseIterable, Hashable {
    case file
    case image
    case audio
    case video
    case link
}

struct LoopOpsChatAttachment: Codable, Hashable, Identifiable {
    let id: String
    let kind: LoopOpsAttachmentKind
    let fileName: String
    let localPath: String?
    let artifactPath: String?
    let sha256: String?
    let sizeBytes: Int?

    init(
        id: String = "attachment-\(UUID().uuidString)",
        kind: LoopOpsAttachmentKind,
        fileName: String,
        localPath: String? = nil,
        artifactPath: String? = nil,
        sha256: String? = nil,
        sizeBytes: Int? = nil
    ) {
        self.id = id
        self.kind = kind
        self.fileName = fileName
        self.localPath = localPath
        self.artifactPath = artifactPath
        self.sha256 = sha256
        self.sizeBytes = sizeBytes
    }
}

struct LoopOpsChatMessage: Codable, Hashable, Identifiable {
    let id: String
    let role: LoopOpsChatRole
    let text: String
    let attachments: [LoopOpsChatAttachment]
    let controlMetadata: LoopOpsChatControlMetadata?
    let referencedContractID: String?
    let referencedRunID: String?
    let referencedReviewPacketID: String?
    let createdAt: String

    init(
        id: String = "message-\(UUID().uuidString)",
        role: LoopOpsChatRole,
        text: String,
        attachments: [LoopOpsChatAttachment] = [],
        controlMetadata: LoopOpsChatControlMetadata? = nil,
        referencedContractID: String? = nil,
        referencedRunID: String? = nil,
        referencedReviewPacketID: String? = nil,
        createdAt: String = AgentDateFormatting.isoString(Date())
    ) {
        self.id = id
        self.role = role
        self.text = text
        self.attachments = attachments
        self.controlMetadata = controlMetadata
        self.referencedContractID = referencedContractID
        self.referencedRunID = referencedRunID
        self.referencedReviewPacketID = referencedReviewPacketID
        self.createdAt = createdAt
    }
}

struct LoopOpsMemoryCandidate: Codable, Hashable, Identifiable {
    let id: String
    let summary: String
    let sourceMessageID: String?

    init(
        id: String = "memory-\(UUID().uuidString)",
        summary: String,
        sourceMessageID: String? = nil
    ) {
        self.id = id
        self.summary = summary
        self.sourceMessageID = sourceMessageID
    }
}

struct LoopOpsChatThread: Codable, Hashable, Identifiable {
    static let schemaVersion = "loopops-chat-thread-v1"

    let schemaVersion: String
    let id: String
    let scope: LoopOpsChatScope
    let title: String
    let messages: [LoopOpsChatMessage]
    let attachments: [LoopOpsChatAttachment]
    let generatedLoopDraftID: String?
    let followUpRunReferences: [String]
    let memoryCandidates: [LoopOpsMemoryCandidate]
    let loopContractID: String?
    let runID: String?
    let reviewPacketID: String?
    let createdAt: String
    let updatedAt: String

    init(
        schemaVersion: String = LoopOpsChatThread.schemaVersion,
        id: String = "chat-thread-\(UUID().uuidString)",
        scope: LoopOpsChatScope,
        title: String,
        messages: [LoopOpsChatMessage] = [],
        attachments: [LoopOpsChatAttachment] = [],
        generatedLoopDraftID: String? = nil,
        followUpRunReferences: [String] = [],
        memoryCandidates: [LoopOpsMemoryCandidate] = [],
        loopContractID: String? = nil,
        runID: String? = nil,
        reviewPacketID: String? = nil,
        createdAt: String = AgentDateFormatting.isoString(Date()),
        updatedAt: String = AgentDateFormatting.isoString(Date())
    ) {
        self.schemaVersion = schemaVersion
        self.id = id
        self.scope = scope
        self.title = title
        self.messages = messages
        self.attachments = attachments
        self.generatedLoopDraftID = generatedLoopDraftID
        self.followUpRunReferences = followUpRunReferences
        self.memoryCandidates = memoryCandidates
        self.loopContractID = loopContractID
        self.runID = runID
        self.reviewPacketID = reviewPacketID
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

enum LoopOpsRunStatus: String, Codable, CaseIterable, Hashable {
    case queued
    case running
    case completed
    case reviewNeeded
    case blocked
    case failed
    case cancelled
}

struct LoopOpsStatusTimelineEvent: Codable, Hashable, Identifiable {
    let id: String
    let status: LoopOpsRunStatus
    let title: String
    let detail: String?
    let occurredAt: String

    init(
        id: String = "timeline-\(UUID().uuidString)",
        status: LoopOpsRunStatus,
        title: String,
        detail: String? = nil,
        occurredAt: String = AgentDateFormatting.isoString(Date())
    ) {
        self.id = id
        self.status = status
        self.title = title
        self.detail = detail
        self.occurredAt = occurredAt
    }
}

enum LoopOpsEvidenceGapSeverity: String, Codable, CaseIterable, Hashable {
    case info
    case warning
    case blocking
}

struct LoopOpsEvidenceGap: Codable, Hashable, Identifiable {
    let id: String
    let title: String
    let detail: String
    let severity: LoopOpsEvidenceGapSeverity

    init(
        id: String = "evidence-gap-\(UUID().uuidString)",
        title: String,
        detail: String,
        severity: LoopOpsEvidenceGapSeverity = .info
    ) {
        self.id = id
        self.title = title
        self.detail = detail
        self.severity = severity
    }
}

struct LoopOpsBlockedAction: Codable, Hashable, Identifiable {
    let id: String
    let label: String
    let reason: String

    init(
        id: String = "blocked-action-\(UUID().uuidString)",
        label: String,
        reason: String
    ) {
        self.id = id
        self.label = label
        self.reason = reason
    }
}

struct LoopOpsFinalAnswerPointer: Codable, Hashable, Identifiable {
    let id: String
    let title: String
    let artifactPath: String?
    let excerpt: String?

    init(
        id: String = "final-answer-\(UUID().uuidString)",
        title: String = "Final answer",
        artifactPath: String? = nil,
        excerpt: String? = nil
    ) {
        self.id = id
        self.title = title
        self.artifactPath = artifactPath
        self.excerpt = excerpt
    }
}

struct LoopOpsCloneReplayMetadata: Codable, Hashable {
    let canClone: Bool
    let canReplay: Bool
    let sourceRunID: String?
    let clonedFromRunID: String?
    let replayReason: String?

    init(
        canClone: Bool = true,
        canReplay: Bool = true,
        sourceRunID: String? = nil,
        clonedFromRunID: String? = nil,
        replayReason: String? = nil
    ) {
        self.canClone = canClone
        self.canReplay = canReplay
        self.sourceRunID = sourceRunID
        self.clonedFromRunID = clonedFromRunID
        self.replayReason = replayReason
    }
}

enum LoopOpsReviewDecisionKind: String, Codable, CaseIterable, Hashable {
    case pending
    case approved
    case needsFollowUp
    case rejected
    case blocked
}

struct LoopOpsReviewDecision: Codable, Hashable, Identifiable {
    let id: String
    let decision: LoopOpsReviewDecisionKind
    let reviewer: String
    let decidedAt: String?
    let notes: String
    let nextAction: String?

    init(
        id: String = "review-decision-\(UUID().uuidString)",
        decision: LoopOpsReviewDecisionKind = .pending,
        reviewer: String = "local-user",
        decidedAt: String? = nil,
        notes: String = "",
        nextAction: String? = nil
    ) {
        self.id = id
        self.decision = decision
        self.reviewer = reviewer
        self.decidedAt = decidedAt
        self.notes = notes
        self.nextAction = nextAction
    }
}

enum LoopOpsClaimSupportLevel: String, Codable, CaseIterable, Hashable {
    case supported
    case mixed
    case weak
    case contradicted
    case unreviewed
}

struct LoopOpsReviewClaim: Codable, Hashable, Identifiable {
    let id: String
    let text: String
    let supportLevel: LoopOpsClaimSupportLevel
    let evidenceReferences: [String]

    init(
        id: String = "claim-\(UUID().uuidString)",
        text: String,
        supportLevel: LoopOpsClaimSupportLevel = .unreviewed,
        evidenceReferences: [String] = []
    ) {
        self.id = id
        self.text = text
        self.supportLevel = supportLevel
        self.evidenceReferences = evidenceReferences
    }
}

struct LoopOpsReviewPacketEvent: Codable, Hashable, Identifiable {
    let id: String
    let kind: String
    let title: String
    let detail: String
    let actor: String
    let occurredAt: String

    init(
        id: String = "review-event-\(UUID().uuidString)",
        kind: String = "note",
        title: String,
        detail: String = "",
        actor: String = "local-user",
        occurredAt: String = AgentDateFormatting.isoString(Date())
    ) {
        self.id = id
        self.kind = kind
        self.title = title
        self.detail = detail
        self.actor = actor
        self.occurredAt = occurredAt
    }
}

struct LoopOpsReviewPacket: Codable, Hashable, Identifiable {
    static let schemaVersion = "loopops-review-packet-v1"

    let schemaVersion: String
    let id: String
    let runID: String
    let loopContractID: String?
    let finalAnswer: String
    let domainSummary: String
    let claims: [LoopOpsReviewClaim]
    let evidenceGaps: [LoopOpsEvidenceGap]
    let uncertainty: String
    let blockedActions: [LoopOpsBlockedAction]
    let nextQuestions: [String]
    let reviewDecision: LoopOpsReviewDecision
    let reviewNotes: String
    let eventHistory: [LoopOpsReviewPacketEvent]
    let createdAt: String
    let updatedAt: String

    init(
        schemaVersion: String = LoopOpsReviewPacket.schemaVersion,
        id: String = "review-packet-\(UUID().uuidString)",
        runID: String,
        loopContractID: String? = nil,
        finalAnswer: String,
        domainSummary: String,
        claims: [LoopOpsReviewClaim] = [],
        evidenceGaps: [LoopOpsEvidenceGap] = [],
        uncertainty: String = "",
        blockedActions: [LoopOpsBlockedAction] = [],
        nextQuestions: [String] = [],
        reviewDecision: LoopOpsReviewDecision = LoopOpsReviewDecision(),
        reviewNotes: String = "",
        eventHistory: [LoopOpsReviewPacketEvent] = [],
        createdAt: String = AgentDateFormatting.isoString(Date()),
        updatedAt: String = AgentDateFormatting.isoString(Date())
    ) {
        self.schemaVersion = schemaVersion
        self.id = id
        self.runID = runID
        self.loopContractID = loopContractID
        self.finalAnswer = finalAnswer
        self.domainSummary = domainSummary
        self.claims = claims
        self.evidenceGaps = evidenceGaps
        self.uncertainty = uncertainty
        self.blockedActions = blockedActions
        self.nextQuestions = nextQuestions
        self.reviewDecision = reviewDecision
        self.reviewNotes = reviewNotes
        self.eventHistory = eventHistory
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    private enum CodingKeys: String, CodingKey {
        case schemaVersion
        case id
        case runID
        case loopContractID
        case finalAnswer
        case domainSummary
        case claims
        case evidenceGaps
        case uncertainty
        case blockedActions
        case nextQuestions
        case reviewDecision
        case reviewNotes
        case eventHistory
        case createdAt
        case updatedAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let decision = try container.decodeIfPresent(LoopOpsReviewDecision.self, forKey: .reviewDecision) ?? LoopOpsReviewDecision()
        self.init(
            schemaVersion: try container.decodeIfPresent(String.self, forKey: .schemaVersion) ?? Self.schemaVersion,
            id: try container.decode(String.self, forKey: .id),
            runID: try container.decode(String.self, forKey: .runID),
            loopContractID: try container.decodeIfPresent(String.self, forKey: .loopContractID),
            finalAnswer: try container.decode(String.self, forKey: .finalAnswer),
            domainSummary: try container.decode(String.self, forKey: .domainSummary),
            claims: try container.decodeIfPresent([LoopOpsReviewClaim].self, forKey: .claims) ?? [],
            evidenceGaps: try container.decodeIfPresent([LoopOpsEvidenceGap].self, forKey: .evidenceGaps) ?? [],
            uncertainty: try container.decodeIfPresent(String.self, forKey: .uncertainty) ?? "",
            blockedActions: try container.decodeIfPresent([LoopOpsBlockedAction].self, forKey: .blockedActions) ?? [],
            nextQuestions: try container.decodeIfPresent([String].self, forKey: .nextQuestions) ?? [],
            reviewDecision: decision,
            reviewNotes: try container.decodeIfPresent(String.self, forKey: .reviewNotes) ?? decision.notes,
            eventHistory: try container.decodeIfPresent([LoopOpsReviewPacketEvent].self, forKey: .eventHistory) ?? [],
            createdAt: try container.decodeIfPresent(String.self, forKey: .createdAt) ?? AgentDateFormatting.isoString(Date()),
            updatedAt: try container.decodeIfPresent(String.self, forKey: .updatedAt) ?? AgentDateFormatting.isoString(Date())
        )
    }
}

struct LoopOpsRunLedger: Codable, Hashable, Identifiable {
    static let schemaVersion = "loopops-run-ledger-v1"

    let schemaVersion: String
    let id: String
    let loopContractSnapshot: LoopOpsLoopContract
    let runID: String
    let startedAt: String
    let completedAt: String?
    let inputsUsed: [LoopOpsInputBinding]
    let statusTimeline: [LoopOpsStatusTimelineEvent]
    let finalAnswerPointer: LoopOpsFinalAnswerPointer?
    let evidenceGaps: [LoopOpsEvidenceGap]
    let blockedActions: [LoopOpsBlockedAction]
    let reviewDecision: LoopOpsReviewDecision?
    let followUpPrompts: [String]
    let cloneReplayMetadata: LoopOpsCloneReplayMetadata

    init(
        schemaVersion: String = LoopOpsRunLedger.schemaVersion,
        id: String = "run-ledger-\(UUID().uuidString)",
        loopContractSnapshot: LoopOpsLoopContract,
        runID: String,
        startedAt: String = AgentDateFormatting.isoString(Date()),
        completedAt: String? = nil,
        inputsUsed: [LoopOpsInputBinding] = [],
        statusTimeline: [LoopOpsStatusTimelineEvent] = [],
        finalAnswerPointer: LoopOpsFinalAnswerPointer? = nil,
        evidenceGaps: [LoopOpsEvidenceGap] = [],
        blockedActions: [LoopOpsBlockedAction] = [],
        reviewDecision: LoopOpsReviewDecision? = nil,
        followUpPrompts: [String] = [],
        cloneReplayMetadata: LoopOpsCloneReplayMetadata = LoopOpsCloneReplayMetadata()
    ) {
        self.schemaVersion = schemaVersion
        self.id = id
        self.loopContractSnapshot = loopContractSnapshot
        self.runID = runID
        self.startedAt = startedAt
        self.completedAt = completedAt
        self.inputsUsed = inputsUsed
        self.statusTimeline = statusTimeline
        self.finalAnswerPointer = finalAnswerPointer
        self.evidenceGaps = evidenceGaps
        self.blockedActions = blockedActions
        self.reviewDecision = reviewDecision
        self.followUpPrompts = followUpPrompts
        self.cloneReplayMetadata = cloneReplayMetadata
    }
}

struct LoopOpsRedactedLoopSummary: Codable, Hashable {
    let contractID: String
    let name: String
    let domain: LoopOpsDomain
    let goal: String
    let trigger: String
    let outputShape: String
    let reviewBoundary: String

    init(contract: LoopOpsLoopContract) {
        self.contractID = contract.id
        self.name = contract.name
        self.domain = contract.domain
        self.goal = contract.goal
        self.trigger = contract.trigger
        self.outputShape = contract.outputShape
        self.reviewBoundary = contract.reviewBoundary
    }
}

struct LoopOpsRedactedTimelineItem: Codable, Hashable, Identifiable {
    let id: String
    let status: LoopOpsRunStatus
    let title: String
    let occurredAt: String

    init(event: LoopOpsStatusTimelineEvent) {
        self.id = event.id
        self.status = event.status
        self.title = event.title
        self.occurredAt = event.occurredAt
    }
}

struct LoopOpsShareSafeLog: Codable, Hashable, Identifiable {
    static let schemaVersion = "loopops-share-safe-log-v1"

    let schemaVersion: String
    let id: String
    let sourceRunID: String?
    let sourceContractID: String?
    let redactedLoopSummary: LoopOpsRedactedLoopSummary
    let redactedRunTimeline: [LoopOpsRedactedTimelineItem]
    let finalAnswerExcerpt: String
    let reviewNotes: String
    let cloneInstructions: String
    let omittedSensitiveFieldsSummary: [String]
    let createdAt: String

    init(
        schemaVersion: String = LoopOpsShareSafeLog.schemaVersion,
        id: String = "share-safe-log-\(UUID().uuidString)",
        sourceRunID: String?,
        sourceContractID: String?,
        redactedLoopSummary: LoopOpsRedactedLoopSummary,
        redactedRunTimeline: [LoopOpsRedactedTimelineItem],
        finalAnswerExcerpt: String,
        reviewNotes: String,
        cloneInstructions: String,
        omittedSensitiveFieldsSummary: [String],
        createdAt: String = AgentDateFormatting.isoString(Date())
    ) {
        self.schemaVersion = schemaVersion
        self.id = id
        self.sourceRunID = sourceRunID
        self.sourceContractID = sourceContractID
        self.redactedLoopSummary = redactedLoopSummary
        self.redactedRunTimeline = redactedRunTimeline
        self.finalAnswerExcerpt = finalAnswerExcerpt
        self.reviewNotes = reviewNotes
        self.cloneInstructions = cloneInstructions
        self.omittedSensitiveFieldsSummary = omittedSensitiveFieldsSummary
        self.createdAt = createdAt
    }

    static func from(
        runLedger: LoopOpsRunLedger,
        reviewPacket: LoopOpsReviewPacket? = nil,
        id: String = "share-safe-log-\(UUID().uuidString)",
        createdAt: String = AgentDateFormatting.isoString(Date())
    ) -> LoopOpsShareSafeLog {
        let finalAnswer = reviewPacket?.finalAnswer
            ?? runLedger.finalAnswerPointer?.excerpt
            ?? ""
        let packetNotes = reviewPacket?.reviewNotes.trimmingCharacters(in: .whitespacesAndNewlines)
        let reviewNotes = packetNotes?.isEmpty == false ? packetNotes! : reviewPacket?.reviewDecision.notes
            ?? runLedger.reviewDecision?.notes
            ?? ""

        return LoopOpsShareSafeLog(
            id: id,
            sourceRunID: runLedger.runID,
            sourceContractID: runLedger.loopContractSnapshot.id,
            redactedLoopSummary: LoopOpsRedactedLoopSummary(contract: runLedger.loopContractSnapshot),
            redactedRunTimeline: runLedger.statusTimeline.map(LoopOpsRedactedTimelineItem.init(event:)),
            finalAnswerExcerpt: Self.excerpt(finalAnswer),
            reviewNotes: reviewNotes,
            cloneInstructions: "Clone the loop contract, review inputs, then run manually.",
            omittedSensitiveFieldsSummary: [
                "local setup selections",
                "raw execution files and connector payloads",
                "local attachment paths",
                "secrets and credentials"
            ],
            createdAt: createdAt
        )
    }

    private static func excerpt(_ value: String, limit: Int = 800) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count > limit else { return trimmed }
        let index = trimmed.index(trimmed.startIndex, offsetBy: limit)
        return String(trimmed[..<index])
    }
}

private enum LoopOpsTemplateCapabilityNames {
    static func references(skillIDs: [String], extensionIDs: [String]) -> [LoopOpsCapabilityReference] {
        var references: [LoopOpsCapabilityReference] = []
        for skillID in skillIDs {
            references.append(reference(for: skillID, position: references.count + 1, source: .skill))
        }
        for extensionID in extensionIDs {
            references.append(reference(for: extensionID, position: references.count + 1, source: .extension))
        }
        return references
    }

    private enum Source {
        case skill
        case `extension`
    }

    private static func reference(for identifier: String, position: Int, source: Source) -> LoopOpsCapabilityReference {
        let mapped = mappedCapability(identifier)
        return LoopOpsCapabilityReference(
            id: "capability-\(position)",
            title: mapped.title,
            summary: mapped.summary(source),
            category: mapped.category
        )
    }

    private static func mappedCapability(_ identifier: String) -> (title: String, category: LoopOpsCapabilityCategory, summary: (Source) -> String) {
        switch identifier {
        case "cmc-market-radar":
            return ("CoinMarketCap market radar", .marketData, { _ in "Market evidence and candidate scanning." })
        case "market-regime-review":
            return ("Market regime review", .review, { _ in "Risk stance, missing inputs, and review conditions." })
        case "social-price-divergence":
            return ("Social and price divergence review", .review, { _ in "Checks discussion signals against price behavior." })
        case "equity-company-deep-dive":
            return ("Company deep dive", .research, { _ in "Business quality, thesis, and contradiction review." })
        case "equity-thesis-tracker":
            return ("Equity thesis tracker", .research, { _ in "Tracks support, contradiction, and follow-up research." })
        case "equity-earnings-review":
            return ("Earnings review", .review, { _ in "Revenue quality, margin, guidance, and management tone." })
        case "macro-cross-asset-readthrough":
            return ("Cross-asset read-through", .research, { _ in "Connects macro, equity, and crypto risk signals." })
        case "equity-sector-scan":
            return ("Sector scan", .research, { _ in "Finds sector-level research candidates and gaps." })
        case "meeting-cloud-asr":
            return ("Cloud transcription", .transcription, { _ in "Turns meeting media into reviewable transcript material." })
        case "meeting-minutes":
            return ("Meeting minutes", .drafting, { _ in "Creates structured notes, action items, and open questions." })
        case "document-generation":
            return ("Document drafting", .drafting, { _ in "Turns source material into a readable draft." })
        case "document-revision":
            return ("Document revision", .drafting, { _ in "Refines wording, structure, and unresolved questions." })
        case "feishu-agent-bridge":
            return ("Feishu delivery preview", .deliveryPreview, { _ in "Prepares a preview before any confirmed delivery." })
        case "markets-research":
            return ("Markets research capability", .research, { _ in "Research workflow support for markets loops." })
        case "cmc-skill-hub":
            return ("CMC Skill Hub capability", .marketData, { _ in "Read-only crypto market evidence capability." })
        case "wechat-cli-export-bridge":
            return ("WeChat context bridge", .context, { _ in "Local message context when explicitly selected." })
        case "office-meeting-agent":
            return ("Office meeting agent", .drafting, { _ in "Meeting, document, and delivery preview support." })
        default:
            let title = identifier
                .split(separator: "-")
                .map { $0.capitalized }
                .joined(separator: " ")
            return (title, .research, { source in
                switch source {
                case .skill:
                    return "User-facing loop capability."
                case .extension:
                    return "User-facing capability package."
                }
            })
        }
    }
}
