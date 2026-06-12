import Foundation

@MainActor
final class AgentRunCompletionCoordinator {
    typealias ActiveCheck = () -> Bool
    typealias LocalReadModelLoader = () -> AgentFinalReadModel?
    typealias ProductMutationImporter = () -> Void
    typealias RemoteRefresh = () async -> Void
    typealias StatusHandler = (_ status: String, _ finalizingRunIDs: Set<String>) -> Void

    private let retryLimit: Int
    private let retryDelayNanoseconds: UInt64
    private var finalizationTasks: [String: Task<Void, Never>] = [:]
    private var importedRunIDs: Set<String> = []

    private(set) var finalizingRunIDs: Set<String> = []

    init(retryLimit: Int = 12, retryDelayNanoseconds: UInt64 = 250_000_000) {
        self.retryLimit = retryLimit
        self.retryDelayNanoseconds = retryDelayNanoseconds
    }

    func cancel(runID: String) {
        finalizationTasks[runID]?.cancel()
        finalizationTasks[runID] = nil
        finalizingRunIDs.remove(runID)
    }

    func cancelAll() {
        for task in finalizationTasks.values {
            task.cancel()
        }
        finalizationTasks.removeAll()
        finalizingRunIDs.removeAll()
    }

    func start(
        runID: String,
        terminal: AgentStreamEvent,
        isRunActive: @escaping ActiveCheck,
        loadLocalReadModels: @escaping LocalReadModelLoader,
        importProductMutations: @escaping ProductMutationImporter,
        refreshRemoteState: @escaping RemoteRefresh,
        updateStatus: @escaping StatusHandler
    ) {
        cancel(runID: runID)
        finalizingRunIDs.insert(runID)
        updateStatus("run_\(terminal.status ?? "completed"):\(runID):finalizing", finalizingRunIDs)
        performAttempt(
            runID: runID,
            terminal: terminal,
            remainingAttempts: retryLimit,
            isRunActive: isRunActive,
            loadLocalReadModels: loadLocalReadModels,
            importProductMutations: importProductMutations,
            refreshRemoteState: refreshRemoteState,
            updateStatus: updateStatus
        )
    }

    private func performAttempt(
        runID: String,
        terminal: AgentStreamEvent,
        remainingAttempts: Int,
        isRunActive: @escaping ActiveCheck,
        loadLocalReadModels: @escaping LocalReadModelLoader,
        importProductMutations: @escaping ProductMutationImporter,
        refreshRemoteState: @escaping RemoteRefresh,
        updateStatus: @escaping StatusHandler
    ) {
        guard isRunActive() else {
            cancel(runID: runID)
            updateStatus("run_inactive:\(runID)", finalizingRunIDs)
            return
        }

        let finalReadModel = loadLocalReadModels()
        if Self.hasAuthoritativeFinal(finalReadModel) || remainingAttempts <= 0 {
            if Self.hasAuthoritativeFinal(finalReadModel), !importedRunIDs.contains(runID) {
                importedRunIDs.insert(runID)
                importProductMutations()
            }
        finalizationTasks[runID] = Task { [weak self] in
            await refreshRemoteState()
            await MainActor.run {
                guard let self else { return }
                self.finish(runID: runID, terminal: terminal, updateStatus: updateStatus)
            }
            }
            return
        }

        let delay = retryDelayNanoseconds
        finalizationTasks[runID] = Task { [weak self] in
            try? await Task.sleep(nanoseconds: delay)
            await MainActor.run {
                guard let self else { return }
                self.performAttempt(
                    runID: runID,
                    terminal: terminal,
                    remainingAttempts: remainingAttempts - 1,
                    isRunActive: isRunActive,
                    loadLocalReadModels: loadLocalReadModels,
                    importProductMutations: importProductMutations,
                    refreshRemoteState: refreshRemoteState,
                    updateStatus: updateStatus
                )
            }
        }
    }

    private func finish(runID: String, terminal: AgentStreamEvent, updateStatus: StatusHandler) {
        finalizingRunIDs.remove(runID)
        finalizationTasks[runID]?.cancel()
        finalizationTasks[runID] = nil
        updateStatus("run_\(terminal.status ?? "completed"):\(runID)", finalizingRunIDs)
    }

    private static func hasAuthoritativeFinal(_ model: AgentFinalReadModel?) -> Bool {
        guard let model else { return false }
        return !model.finalText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}
