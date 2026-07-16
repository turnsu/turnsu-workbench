import Foundation

struct RuntimeRepository {
    private let orchestrator: AgentOrchestrator
    private let taskStore: TaskStore
    private let watchlistStore: WatchlistStore
    private let alertStore: AlertStore
    private let crystalStore: CrystalStore
    private let proposalStore: ProposalStore
    private let memoryStore: MemoryStore
    private let handoffStore: HandoffStore

    init(
        orchestrator: AgentOrchestrator = AgentOrchestrator(adapter: WeChatFixtureFileAdapter()),
        taskStore: TaskStore = TaskStore(),
        watchlistStore: WatchlistStore = WatchlistStore(),
        alertStore: AlertStore = AlertStore(),
        crystalStore: CrystalStore = CrystalStore(),
        proposalStore: ProposalStore = ProposalStore(),
        memoryStore: MemoryStore = MemoryStore(),
        handoffStore: HandoffStore = HandoffStore()
    ) {
        self.orchestrator = orchestrator
        self.taskStore = taskStore
        self.watchlistStore = watchlistStore
        self.alertStore = alertStore
        self.crystalStore = crystalStore
        self.proposalStore = proposalStore
        self.memoryStore = memoryStore
        self.handoffStore = handoffStore
    }

    func refresh(date: Date, selectedGroupID: UUID?, window: TimeWindow) -> AgentRunResult {
        orchestrator.run(date: date, selectedGroupID: selectedGroupID, window: window)
    }

    @discardableResult
    func persistTasks(_ tasks: [UserTask]) throws -> URL {
        try taskStore.write(tasks)
    }

    @discardableResult
    func persistWatchlist(_ items: [WatchlistItem]) throws -> URL {
        try watchlistStore.write(items)
    }

    @discardableResult
    func persistAlerts(_ alerts: [AlertRecord]) throws -> URL {
        try alertStore.write(alerts)
    }

    @discardableResult
    func persistCrystals(_ crystals: [IntelligenceCrystal]) throws -> URL {
        try crystalStore.write(crystals)
    }

    @discardableResult
    func persistProposals(_ proposals: [AgentProposal]) throws -> URL {
        try proposalStore.write(proposals)
    }

    @discardableResult
    func persistMemory(_ entries: [MemoryEntry]) throws -> URL {
        try memoryStore.write(entries)
    }

    @discardableResult
    func persistHandoffs(_ handoffs: [HandoffPacket]) throws -> [URL] {
        try handoffStore.write(handoffs)
    }

    @discardableResult
    func purgeArchivedHandoffs(preserving handoffs: [HandoffPacket]) throws -> [URL] {
        try handoffStore.purgeArchived(preserving: handoffs)
    }
}
