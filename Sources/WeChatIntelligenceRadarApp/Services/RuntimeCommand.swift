import Foundation

enum RuntimeCommand: Hashable {
    case refreshRun(reason: String, selectedGroupID: UUID?, window: TimeWindow, date: Date)
    case selectMessage(UUID)
    case openToken(String)
    case createTaskFromMessage(UUID)
    case addTokenToWatchlist(String)
    case acknowledgeAlert(UUID)
    case muteAlert(UUID)
    case resolveAlert(UUID)
    case copyEvidence(UUID)
    case openArtifactReference(String)
    case selectCrystal(UUID)
    case selectProposal(UUID)
    case acceptProposal(UUID)
    case rejectProposal(UUID, reason: String)
    case createHandoff(crystalIDs: [UUID])
    case archiveHandoff(UUID)
    case purgeArchivedHandoffs
    case markCrystalUseful(UUID)
    case markCrystalFalsePositive(UUID, reason: String)
    case saveMemory(MemoryEntry)
    case purgeMemory(UUID)
    case loadBridgeArtifact(String)
    case importAgentProductMutations(runID: String)
}
