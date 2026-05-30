import Foundation

enum RuntimeQuery: Hashable {
    case currentState
    case selectedMessage
    case selectedToken
    case selectedEvidence
    case selectedCrystal
    case selectedProposal
    case selectedMemory
    case selectedHandoff
    case proactiveSession
    case bridgeStatus
    case artifactManifest
    case runtimeHealth
}

struct RuntimeSelectionState: Hashable {
    var selectedMessageID: UUID?
    var selectedTokenID: String?
    var selectedEvidenceID: UUID?
    var selectedAlertID: UUID?
    var selectedArtifactPath: String?
    var selectedCrystalID: UUID?
    var selectedProposalID: UUID?
    var selectedMemoryID: UUID?
    var selectedHandoffID: UUID?

    static let empty = RuntimeSelectionState()
}

struct RuntimeBackendState: Hashable {
    var result: AgentRunResult
    var selection: RuntimeSelectionState
    var commandStatus: String

    static let empty = RuntimeBackendState(
        result: AgentRunResult(
            snapshot: .empty,
            logs: [],
            capabilities: [],
            policies: [],
            envelope: PlannerEnvelope(
                goal: "not_run",
                taskType: "not_run",
                capabilitiesNeeded: [],
                toolPlan: [],
                stopConditions: []
            ),
            syncState: .idle,
            artifactStatus: nil,
            terminalData: .empty
        ),
        selection: .empty,
        commandStatus: "idle"
    )
}
