import Foundation

struct CMCRefreshBridge {
    let store: MarketSnapshotStore

    init(store: MarketSnapshotStore = MarketSnapshotStore()) {
        self.store = store
    }

    func loadExternalSnapshot(now: Date) -> MarketDataSnapshot? {
        store.load(now: now)
    }

    @discardableResult
    func ingestNormalizedSnapshot(from url: URL) throws -> URL {
        let data = try Data(contentsOf: url)
        let snapshot = try JSONDecoder.agentArtifactDecoder().decode(MarketDataSnapshot.self, from: data)
        return try store.write(snapshot)
    }
}
