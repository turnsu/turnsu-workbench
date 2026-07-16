import Foundation

struct LoopOpsLocalStoreSnapshot: Codable, Hashable {
    let contracts: [LoopOpsLoopContract]
    let chatThreads: [LoopOpsChatThread]
    let runLedgers: [LoopOpsRunLedger]
    let reviewPackets: [LoopOpsReviewPacket]
    let shareSafeLogs: [LoopOpsShareSafeLog]
    let skillStacks: [LoopOpsSkillStack]
    let knowledgeSources: [LoopOpsKnowledgeSource]
    let toolDrafts: [LoopOpsToolDraft]
    let toolLogs: [LoopOpsToolLog]
    let builderPackets: [LoopOpsBuilderPacket]

    init(
        contracts: [LoopOpsLoopContract] = [],
        chatThreads: [LoopOpsChatThread] = [],
        runLedgers: [LoopOpsRunLedger] = [],
        reviewPackets: [LoopOpsReviewPacket] = [],
        shareSafeLogs: [LoopOpsShareSafeLog] = [],
        skillStacks: [LoopOpsSkillStack] = [],
        knowledgeSources: [LoopOpsKnowledgeSource] = [],
        toolDrafts: [LoopOpsToolDraft] = [],
        toolLogs: [LoopOpsToolLog] = [],
        builderPackets: [LoopOpsBuilderPacket] = []
    ) {
        self.contracts = contracts
        self.chatThreads = chatThreads
        self.runLedgers = runLedgers
        self.reviewPackets = reviewPackets
        self.shareSafeLogs = shareSafeLogs
        self.skillStacks = skillStacks
        self.knowledgeSources = knowledgeSources
        self.toolDrafts = toolDrafts
        self.toolLogs = toolLogs
        self.builderPackets = builderPackets
    }
}

struct LoopOpsLocalJSONStore {
    let root: URL
    let fileManager: FileManager

    init(pathResolver: RuntimePathResolver = RuntimePathResolver(), fileManager: FileManager = .default) {
        self.init(
            root: pathResolver.runtimeDirectory.appendingPathComponent("loopops-v2", isDirectory: true),
            fileManager: fileManager
        )
    }

    init(root: URL, fileManager: FileManager = .default) {
        self.root = root
        self.fileManager = fileManager
    }

    var contractsURL: URL {
        root.appendingPathComponent("contracts.json")
    }

    var chatThreadsURL: URL {
        root.appendingPathComponent("chat-threads.json")
    }

    var runLedgersURL: URL {
        root.appendingPathComponent("run-ledgers.json")
    }

    var reviewPacketsURL: URL {
        root.appendingPathComponent("review-packets.json")
    }

    var shareSafeLogsURL: URL {
        root.appendingPathComponent("share-safe-logs.json")
    }

    var skillStacksURL: URL {
        root.appendingPathComponent("skill-stacks.json")
    }

    var knowledgeSourcesURL: URL {
        root.appendingPathComponent("knowledge-sources.json")
    }

    var toolDraftsURL: URL {
        root.appendingPathComponent("tool-drafts.json")
    }

    var toolLogsURL: URL {
        root.appendingPathComponent("tool-logs.json")
    }

    var builderPacketsURL: URL {
        root.appendingPathComponent("builder-packets.json")
    }

    func readSnapshot() -> LoopOpsLocalStoreSnapshot {
        LoopOpsLocalStoreSnapshot(
            contracts: readContracts(),
            chatThreads: readChatThreads(),
            runLedgers: readRunLedgers(),
            reviewPackets: readReviewPackets(),
            shareSafeLogs: readShareSafeLogs(),
            skillStacks: readSkillStacks(),
            knowledgeSources: readKnowledgeSources(),
            toolDrafts: readToolDrafts(),
            toolLogs: readToolLogs(),
            builderPackets: readBuilderPackets()
        )
    }

    func writeSnapshot(_ snapshot: LoopOpsLocalStoreSnapshot) throws -> [URL] {
        [
            try writeContracts(snapshot.contracts),
            try writeChatThreads(snapshot.chatThreads),
            try writeRunLedgers(snapshot.runLedgers),
            try writeReviewPackets(snapshot.reviewPackets),
            try writeShareSafeLogs(snapshot.shareSafeLogs),
            try writeSkillStacks(snapshot.skillStacks),
            try writeKnowledgeSources(snapshot.knowledgeSources),
            try writeToolDrafts(snapshot.toolDrafts),
            try writeToolLogs(snapshot.toolLogs),
            try writeBuilderPackets(snapshot.builderPackets)
        ]
    }

    func readContracts() -> [LoopOpsLoopContract] {
        readArray(from: contractsURL, as: LoopOpsLoopContract.self)
    }

    @discardableResult
    func writeContracts(_ contracts: [LoopOpsLoopContract]) throws -> URL {
        try writeArray(contracts, to: contractsURL)
    }

    @discardableResult
    func upsertContract(_ contract: LoopOpsLoopContract) throws -> URL {
        try upsert(contract, read: readContracts, write: writeContracts, id: \.id)
    }

    func readChatThreads() -> [LoopOpsChatThread] {
        readArray(from: chatThreadsURL, as: LoopOpsChatThread.self)
    }

    @discardableResult
    func writeChatThreads(_ threads: [LoopOpsChatThread]) throws -> URL {
        try writeArray(threads, to: chatThreadsURL)
    }

    @discardableResult
    func upsertChatThread(_ thread: LoopOpsChatThread) throws -> URL {
        try upsert(thread, read: readChatThreads, write: writeChatThreads, id: \.id)
    }

    func readRunLedgers() -> [LoopOpsRunLedger] {
        readArray(from: runLedgersURL, as: LoopOpsRunLedger.self)
    }

    @discardableResult
    func writeRunLedgers(_ ledgers: [LoopOpsRunLedger]) throws -> URL {
        try writeArray(ledgers, to: runLedgersURL)
    }

    @discardableResult
    func upsertRunLedger(_ ledger: LoopOpsRunLedger) throws -> URL {
        try upsert(ledger, read: readRunLedgers, write: writeRunLedgers, id: \.id)
    }

    func readReviewPackets() -> [LoopOpsReviewPacket] {
        readArray(from: reviewPacketsURL, as: LoopOpsReviewPacket.self)
    }

    @discardableResult
    func writeReviewPackets(_ packets: [LoopOpsReviewPacket]) throws -> URL {
        try writeArray(packets, to: reviewPacketsURL)
    }

    @discardableResult
    func upsertReviewPacket(_ packet: LoopOpsReviewPacket) throws -> URL {
        try upsert(packet, read: readReviewPackets, write: writeReviewPackets, id: \.id)
    }

    func readShareSafeLogs() -> [LoopOpsShareSafeLog] {
        readArray(from: shareSafeLogsURL, as: LoopOpsShareSafeLog.self)
    }

    @discardableResult
    func writeShareSafeLogs(_ logs: [LoopOpsShareSafeLog]) throws -> URL {
        try writeArray(logs, to: shareSafeLogsURL)
    }

    @discardableResult
    func upsertShareSafeLog(_ log: LoopOpsShareSafeLog) throws -> URL {
        try upsert(log, read: readShareSafeLogs, write: writeShareSafeLogs, id: \.id)
    }

    func readKnowledgeSources() -> [LoopOpsKnowledgeSource] {
        readArray(from: knowledgeSourcesURL, as: LoopOpsKnowledgeSource.self)
    }

    func readSkillStacks() -> [LoopOpsSkillStack] {
        readArray(from: skillStacksURL, as: LoopOpsSkillStack.self)
    }

    @discardableResult
    func writeSkillStacks(_ stacks: [LoopOpsSkillStack]) throws -> URL {
        try writeArray(stacks, to: skillStacksURL)
    }

    @discardableResult
    func upsertSkillStack(_ stack: LoopOpsSkillStack) throws -> URL {
        try upsert(stack, read: readSkillStacks, write: writeSkillStacks, id: \.id)
    }

    @discardableResult
    func writeKnowledgeSources(_ sources: [LoopOpsKnowledgeSource]) throws -> URL {
        try writeArray(sources, to: knowledgeSourcesURL)
    }

    @discardableResult
    func upsertKnowledgeSource(_ source: LoopOpsKnowledgeSource) throws -> URL {
        try upsert(source, read: readKnowledgeSources, write: writeKnowledgeSources, id: \.id)
    }

    func readToolDrafts() -> [LoopOpsToolDraft] {
        readArray(from: toolDraftsURL, as: LoopOpsToolDraft.self)
    }

    @discardableResult
    func writeToolDrafts(_ drafts: [LoopOpsToolDraft]) throws -> URL {
        try writeArray(drafts, to: toolDraftsURL)
    }

    @discardableResult
    func upsertToolDraft(_ draft: LoopOpsToolDraft) throws -> URL {
        try upsert(draft, read: readToolDrafts, write: writeToolDrafts, id: \.id)
    }

    func readToolLogs() -> [LoopOpsToolLog] {
        readArray(from: toolLogsURL, as: LoopOpsToolLog.self)
    }

    @discardableResult
    func writeToolLogs(_ logs: [LoopOpsToolLog]) throws -> URL {
        try writeArray(logs, to: toolLogsURL)
    }

    @discardableResult
    func upsertToolLog(_ log: LoopOpsToolLog) throws -> URL {
        try upsert(log, read: readToolLogs, write: writeToolLogs, id: \.id)
    }

    func readBuilderPackets() -> [LoopOpsBuilderPacket] {
        readArray(from: builderPacketsURL, as: LoopOpsBuilderPacket.self)
    }

    @discardableResult
    func writeBuilderPackets(_ packets: [LoopOpsBuilderPacket]) throws -> URL {
        try writeArray(packets, to: builderPacketsURL)
    }

    @discardableResult
    func upsertBuilderPacket(_ packet: LoopOpsBuilderPacket) throws -> URL {
        try upsert(packet, read: readBuilderPackets, write: writeBuilderPackets, id: \.id)
    }

    private func readArray<T: Decodable>(from url: URL, as type: T.Type) -> [T] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        return (try? JSONDecoder.agentArtifactDecoder().decode([T].self, from: data)) ?? []
    }

    @discardableResult
    private func writeArray<T: Encodable>(_ values: [T], to url: URL) throws -> URL {
        try fileManager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder.agentArtifactEncoder().encode(values).write(to: url, options: [.atomic])
        return url
    }

    @discardableResult
    private func upsert<T>(
        _ value: T,
        read: () -> [T],
        write: ([T]) throws -> URL,
        id: (T) -> String
    ) throws -> URL {
        var values = read()
        if let index = values.firstIndex(where: { id($0) == id(value) }) {
            values[index] = value
        } else {
            values.append(value)
        }
        return try write(values)
    }
}
