import Foundation

struct NormalizedWeChatStore {
    let url: URL
    let fileManager: FileManager

    init(pathResolver: RuntimePathResolver = RuntimePathResolver(), fileManager: FileManager = .default) {
        self.url = pathResolver.runtimeDirectory
            .appendingPathComponent("wechat", isDirectory: true)
            .appendingPathComponent("messages.normalized.json")
        self.fileManager = fileManager
    }

    func write(_ messages: [NormalizedWeChatMessage]) throws -> URL {
        try fileManager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder.agentArtifactEncoder().encode(messages).write(to: url, options: [.atomic])
        return url
    }
}

struct TokenEntityStore {
    let url: URL
    let fileManager: FileManager

    init(pathResolver: RuntimePathResolver = RuntimePathResolver(), fileManager: FileManager = .default) {
        self.url = pathResolver.runtimeDirectory
            .appendingPathComponent("entities", isDirectory: true)
            .appendingPathComponent("token-entities.json")
        self.fileManager = fileManager
    }

    func write(_ entities: [TokenEntity]) throws -> URL {
        try fileManager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder.agentArtifactEncoder().encode(entities).write(to: url, options: [.atomic])
        return url
    }
}

struct OnchainSnapshotStore {
    let root: URL
    let fileManager: FileManager

    init(pathResolver: RuntimePathResolver = RuntimePathResolver(), fileManager: FileManager = .default) {
        self.root = pathResolver.runtimeDirectory.appendingPathComponent("onchain", isDirectory: true)
        self.fileManager = fileManager
    }

    func write(_ snapshots: [OnchainSnapshot]) throws -> [URL] {
        try fileManager.createDirectory(at: root, withIntermediateDirectories: true)
        var urls: [URL] = []
        for snapshot in snapshots {
            let chainDir = root.appendingPathComponent(safeSegment(snapshot.chain), isDirectory: true)
            try fileManager.createDirectory(at: chainDir, withIntermediateDirectories: true)
            let name = safeSegment(snapshot.contractAddress ?? snapshot.tokenID)
            let url = chainDir.appendingPathComponent("\(name).json")
            try JSONEncoder.agentArtifactEncoder().encode(snapshot).write(to: url, options: [.atomic])
            urls.append(url)
        }
        return urls
    }
}

struct AlertStore {
    let url: URL
    let fileManager: FileManager

    init(pathResolver: RuntimePathResolver = RuntimePathResolver(), fileManager: FileManager = .default) {
        self.url = pathResolver.runtimeDirectory
            .appendingPathComponent("alerts", isDirectory: true)
            .appendingPathComponent("alerts.json")
        self.fileManager = fileManager
    }

    func write(_ alerts: [AlertRecord]) throws -> URL {
        try fileManager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder.agentArtifactEncoder().encode(alerts).write(to: url, options: [.atomic])
        return url
    }
}

struct EvidenceStore {
    let url: URL
    let fileManager: FileManager

    init(pathResolver: RuntimePathResolver = RuntimePathResolver(), fileManager: FileManager = .default) {
        self.url = pathResolver.runtimeDirectory
            .appendingPathComponent("evidence", isDirectory: true)
            .appendingPathComponent("evidence.json")
        self.fileManager = fileManager
    }

    func write(_ items: [EvidenceItem]) throws -> URL {
        try fileManager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder.agentArtifactEncoder().encode(items).write(to: url, options: [.atomic])
        return url
    }
}

struct TaskStore {
    let url: URL
    let fileManager: FileManager

    init(pathResolver: RuntimePathResolver = RuntimePathResolver(), fileManager: FileManager = .default) {
        self.url = pathResolver.runtimeDirectory
            .appendingPathComponent("tasks", isDirectory: true)
            .appendingPathComponent("tasks.json")
        self.fileManager = fileManager
    }

    func write(_ tasks: [UserTask]) throws -> URL {
        try fileManager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder.agentArtifactEncoder().encode(tasks).write(to: url, options: [.atomic])
        return url
    }
}

struct WatchlistStore {
    let url: URL
    let fileManager: FileManager

    init(pathResolver: RuntimePathResolver = RuntimePathResolver(), fileManager: FileManager = .default) {
        self.url = pathResolver.runtimeDirectory
            .appendingPathComponent("watchlist", isDirectory: true)
            .appendingPathComponent("watchlist.json")
        self.fileManager = fileManager
    }

    func write(_ items: [WatchlistItem]) throws -> URL {
        try fileManager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder.agentArtifactEncoder().encode(items).write(to: url, options: [.atomic])
        return url
    }
}

struct AlertRuleStore {
    let url: URL
    let fileManager: FileManager

    init(pathResolver: RuntimePathResolver = RuntimePathResolver(), fileManager: FileManager = .default) {
        self.url = pathResolver.runtimeDirectory
            .appendingPathComponent("alerts", isDirectory: true)
            .appendingPathComponent("alert-rules.json")
        self.fileManager = fileManager
    }

    func write(_ rules: [AlertRule]) throws -> URL {
        try fileManager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder.agentArtifactEncoder().encode(rules).write(to: url, options: [.atomic])
        return url
    }
}

struct ArtifactManifestStore {
    let url: URL
    let fileManager: FileManager

    init(pathResolver: RuntimePathResolver = RuntimePathResolver(), fileManager: FileManager = .default) {
        self.url = pathResolver.runtimeDirectory
            .appendingPathComponent("artifacts", isDirectory: true)
            .appendingPathComponent("manifest.json")
        self.fileManager = fileManager
    }

    func write(_ manifest: RuntimeStoreManifest) throws -> URL {
        try fileManager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder.agentArtifactEncoder().encode(manifest).write(to: url, options: [.atomic])
        return url
    }
}

struct RuntimeHealthStore {
    let url: URL
    let fileManager: FileManager

    init(pathResolver: RuntimePathResolver = RuntimePathResolver(), fileManager: FileManager = .default) {
        self.url = pathResolver.runtimeDirectory
            .appendingPathComponent("health", isDirectory: true)
            .appendingPathComponent("latest-health.json")
        self.fileManager = fileManager
    }

    func write(_ report: RuntimeHealthReport) throws -> URL {
        try fileManager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder.agentArtifactEncoder().encode(report).write(to: url, options: [.atomic])
        return url
    }
}

struct CrystalStore {
    let url: URL
    let fileManager: FileManager

    init(pathResolver: RuntimePathResolver = RuntimePathResolver(), fileManager: FileManager = .default) {
        self.url = pathResolver.runtimeDirectory
            .appendingPathComponent("crystals", isDirectory: true)
            .appendingPathComponent("crystals.json")
        self.fileManager = fileManager
    }

    func write(_ crystals: [IntelligenceCrystal]) throws -> URL {
        try fileManager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder.agentArtifactEncoder().encode(crystals).write(to: url, options: [.atomic])
        return url
    }

    func read() -> [IntelligenceCrystal] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        return (try? JSONDecoder.agentArtifactDecoder().decode([IntelligenceCrystal].self, from: data)) ?? []
    }
}

struct ProposalStore {
    let url: URL
    let fileManager: FileManager

    init(pathResolver: RuntimePathResolver = RuntimePathResolver(), fileManager: FileManager = .default) {
        self.url = pathResolver.runtimeDirectory
            .appendingPathComponent("proposals", isDirectory: true)
            .appendingPathComponent("proposals.json")
        self.fileManager = fileManager
    }

    func write(_ proposals: [AgentProposal]) throws -> URL {
        try fileManager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder.agentArtifactEncoder().encode(proposals).write(to: url, options: [.atomic])
        return url
    }

    func read() -> [AgentProposal] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        return (try? JSONDecoder.agentArtifactDecoder().decode([AgentProposal].self, from: data)) ?? []
    }
}

struct MemoryStore {
    let url: URL
    let fileManager: FileManager

    init(pathResolver: RuntimePathResolver = RuntimePathResolver(), fileManager: FileManager = .default) {
        self.url = pathResolver.runtimeDirectory
            .appendingPathComponent("memory", isDirectory: true)
            .appendingPathComponent("memory.json")
        self.fileManager = fileManager
    }

    func write(_ entries: [MemoryEntry]) throws -> URL {
        try fileManager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder.agentArtifactEncoder().encode(entries).write(to: url, options: [.atomic])
        return url
    }

    func read() -> [MemoryEntry] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        return (try? JSONDecoder.agentArtifactDecoder().decode([MemoryEntry].self, from: data)) ?? []
    }
}

struct HandoffStore {
    let root: URL
    let indexURL: URL
    let fileManager: FileManager

    init(pathResolver: RuntimePathResolver = RuntimePathResolver(), fileManager: FileManager = .default) {
        self.root = pathResolver.runtimeDirectory.appendingPathComponent("handoffs", isDirectory: true)
        self.indexURL = root.appendingPathComponent("index.json")
        self.fileManager = fileManager
    }

    func write(_ packet: HandoffPacket) throws -> [URL] {
        try write([packet])
    }

    func write(_ packets: [HandoffPacket]) throws -> [URL] {
        try fileManager.createDirectory(at: root, withIntermediateDirectories: true)
        let entries = packets.map { packet in
            HandoffPacketIndexEntry(
                id: packet.id,
                title: packet.title,
                purpose: packet.purpose,
                status: packet.status,
                generatedAt: packet.generatedAt,
                artifactPath: packetURL(for: packet).path,
                redactionPolicy: packet.redaction.policy,
                crystalCount: packet.selectedCrystalRefs.count
            )
        }
        let incomingIDs = Set(entries.map(\.id))
        let retained = readIndex().filter { !incomingIDs.contains($0.id) }
        let merged = entries + retained
        try JSONEncoder.agentArtifactEncoder().encode(merged).write(to: indexURL, options: [.atomic])

        var urls = [indexURL]
        for packet in packets {
            let url = packetURL(for: packet)
            try JSONEncoder.agentArtifactEncoder().encode(packet).write(to: url, options: [.atomic])
            urls.append(url)
        }
        return urls
    }

    private func packetURL(for packet: HandoffPacket) -> URL {
        root.appendingPathComponent("\(safeSegment(packet.id.uuidString)).json")
    }

    func readIndex() -> [HandoffPacketIndexEntry] {
        guard let data = try? Data(contentsOf: indexURL) else { return [] }
        return (try? JSONDecoder.agentArtifactDecoder().decode([HandoffPacketIndexEntry].self, from: data)) ?? []
    }

    func purgeArchived(preserving packets: [HandoffPacket]) throws -> [URL] {
        try fileManager.createDirectory(at: root, withIntermediateDirectories: true)
        let preservingIDs = Set(packets.map(\.id))
        let index = readIndex()
        let kept = index.filter { entry in
            entry.status != .archived || preservingIDs.contains(entry.id)
        }
        let purged = index.filter { entry in
            entry.status == .archived && !preservingIDs.contains(entry.id)
        }

        for entry in purged {
            if let path = entry.artifactPath, fileManager.fileExists(atPath: path) {
                try? fileManager.removeItem(atPath: path)
            }
            let fallback = root.appendingPathComponent("\(safeSegment(entry.id.uuidString)).json")
            if fileManager.fileExists(atPath: fallback.path) {
                try? fileManager.removeItem(at: fallback)
            }
        }

        try JSONEncoder.agentArtifactEncoder().encode(kept).write(to: indexURL, options: [.atomic])
        return [indexURL]
    }
}

struct ProactiveSessionStore {
    let url: URL
    let fileManager: FileManager

    init(pathResolver: RuntimePathResolver = RuntimePathResolver(), fileManager: FileManager = .default) {
        self.url = pathResolver.runtimeDirectory
            .appendingPathComponent("sessions", isDirectory: true)
            .appendingPathComponent("latest-session.json")
        self.fileManager = fileManager
    }

    func write(_ session: ProactiveSession) throws -> URL {
        try fileManager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder.agentArtifactEncoder().encode(session).write(to: url, options: [.atomic])
        return url
    }

    func read() -> ProactiveSession? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder.agentArtifactDecoder().decode(ProactiveSession.self, from: data)
    }
}

struct BridgeStatusStore {
    let root: URL
    let fileManager: FileManager

    init(pathResolver: RuntimePathResolver = RuntimePathResolver(), fileManager: FileManager = .default) {
        self.root = pathResolver.runtimeDirectory.appendingPathComponent("bridges", isDirectory: true)
        self.fileManager = fileManager
    }

    func write(_ status: RuntimeBridgeStatus) throws -> URL {
        try fileManager.createDirectory(at: root, withIntermediateDirectories: true)
        let url = root.appendingPathComponent("\(safeSegment(status.id)).json")
        try JSONEncoder.agentArtifactEncoder().encode(status).write(to: url, options: [.atomic])
        return url
    }

    func write(_ statuses: [RuntimeBridgeStatus]) throws -> [URL] {
        try fileManager.createDirectory(at: root, withIntermediateDirectories: true)
        var urls: [URL] = []
        for status in statuses {
            let url = root.appendingPathComponent("\(safeSegment(status.id)).json")
            try JSONEncoder.agentArtifactEncoder().encode(status).write(to: url, options: [.atomic])
            urls.append(url)
        }
        return urls
    }
}

private func safeSegment(_ value: String) -> String {
    let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_."))
    return String(value.unicodeScalars.map { allowed.contains($0) ? Character($0) : "_" }).prefix(120).description
}
