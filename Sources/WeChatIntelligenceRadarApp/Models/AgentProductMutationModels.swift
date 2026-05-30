import Foundation

struct AgentProductMutationPayload: Codable, Hashable {
    let schemaVersion: String
    let runID: String
    let source: String
    let createdAt: String
    let updatedAt: String
    let idempotencyKeys: [String]
    let tasks: [UserTask]
    let watchlistItems: [WatchlistItem]
    let crystals: [IntelligenceCrystal]
    let proposals: [AgentProposal]
    let memory: [MemoryEntry]
    let handoffs: [HandoffPacket]
}
