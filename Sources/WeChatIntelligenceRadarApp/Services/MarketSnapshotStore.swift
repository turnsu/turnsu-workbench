import Foundation

struct MarketSnapshotStore {
    let snapshotURL: URL
    let fileManager: FileManager

    init(pathResolver: RuntimePathResolver = RuntimePathResolver(), fileManager: FileManager = .default) {
        self.snapshotURL = pathResolver.marketSnapshotURL
        self.fileManager = fileManager
    }

    init(snapshotURL: URL, fileManager: FileManager = .default) {
        self.snapshotURL = snapshotURL
        self.fileManager = fileManager
    }

    func load(now: Date) -> MarketDataSnapshot? {
        guard fileManager.fileExists(atPath: snapshotURL.path),
              let data = try? Data(contentsOf: snapshotURL),
              let snapshot = try? JSONDecoder.agentArtifactDecoder().decode(MarketDataSnapshot.self, from: data)
        else {
            return nil
        }

        return normalizeFreshness(snapshot, now: now)
    }

    @discardableResult
    func write(_ snapshot: MarketDataSnapshot) throws -> URL {
        try fileManager.createDirectory(
            at: snapshotURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let data = try JSONEncoder.agentArtifactEncoder().encode(snapshot)
        try data.write(to: snapshotURL, options: [.atomic])
        return snapshotURL
    }

    private func normalizeFreshness(_ snapshot: MarketDataSnapshot, now: Date) -> MarketDataSnapshot {
        guard let expiresAt = AgentDateFormatting.parse(snapshot.expiresAt) else {
            return snapshot.withStatus(status: "degraded", freshness: "unknown_expiry")
        }

        if expiresAt < now {
            return snapshot.withStatus(status: "degraded", freshness: "stale")
        }

        return snapshot.withStatus(
            status: snapshot.status == "enabled" ? "enabled" : snapshot.status,
            freshness: "fresh"
        )
    }
}

extension MarketDataSnapshot {
    func withStatus(status: String, freshness: String) -> MarketDataSnapshot {
        MarketDataSnapshot(
            status: status,
            sourceName: sourceName,
            generatedAt: generatedAt,
            expiresAt: expiresAt,
            freshness: freshness,
            lastVerifiedAt: lastVerifiedAt,
            assets: assets,
            evidence: evidence,
            upstreamStatus: upstreamStatus
        )
    }
}
