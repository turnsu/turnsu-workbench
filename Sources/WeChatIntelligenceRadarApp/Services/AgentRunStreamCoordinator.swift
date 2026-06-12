import Foundation

@MainActor
final class AgentRunStreamCoordinator {
    typealias FlushHandler = (_ events: [AgentStreamEvent], _ terminal: AgentStreamEvent?) -> Void
    typealias FailureHandler = (_ error: Error) -> Void

    private let eventClient: AgentEventStreamClient
    private var streamTask: Task<Void, Never>?
    private var flushTask: Task<Void, Never>?
    private var pendingEvents: [AgentStreamEvent] = []
    private var seenEventIDs: Set<String> = []
    private var pendingTerminalEvent: AgentStreamEvent?

    private(set) var activeRunID: String?

    init(eventClient: AgentEventStreamClient = AgentEventStreamClient()) {
        self.eventClient = eventClient
    }

    func start(
        runID: String,
        onFlush: @escaping FlushHandler,
        onFailure: @escaping FailureHandler
    ) {
        cancel()
        activeRunID = runID
        let client = eventClient
        streamTask = Task { [weak self] in
            guard let self else { return }
            do {
                for try await event in client.events(runID: runID) {
                    await MainActor.run {
                        self.ingest(event, runID: runID, onFlush: onFlush)
                    }
                }
            } catch {
                await MainActor.run {
                    guard self.activeRunID == runID else { return }
                    self.flushTask?.cancel()
                    self.flushTask = nil
                    onFailure(error)
                }
            }
        }
    }

    func cancel() {
        streamTask?.cancel()
        flushTask?.cancel()
        streamTask = nil
        flushTask = nil
        pendingEvents.removeAll(keepingCapacity: true)
        seenEventIDs.removeAll(keepingCapacity: true)
        pendingTerminalEvent = nil
        activeRunID = nil
    }

    private func ingest(_ event: AgentStreamEvent, runID: String, onFlush: @escaping FlushHandler) {
        guard activeRunID == runID else { return }
        guard seenEventIDs.insert(event.eventID).inserted else { return }
        pendingEvents.append(event)
        if Self.isTerminalEvent(event) {
            pendingTerminalEvent = event
            flush(runID: runID, onFlush: onFlush)
        } else {
            scheduleFlush(runID: runID, onFlush: onFlush)
        }
    }

    private func scheduleFlush(runID: String, onFlush: @escaping FlushHandler) {
        guard flushTask == nil else { return }
        flushTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 120_000_000)
            await MainActor.run {
                guard let self else { return }
                self.flush(runID: runID, onFlush: onFlush)
            }
        }
    }

    private func flush(runID: String, onFlush: FlushHandler) {
        flushTask?.cancel()
        flushTask = nil
        guard activeRunID == runID else {
            pendingEvents.removeAll(keepingCapacity: true)
            pendingTerminalEvent = nil
            return
        }
        let events = pendingEvents
        let terminal = pendingTerminalEvent
        pendingEvents.removeAll(keepingCapacity: true)
        pendingTerminalEvent = nil
        guard !events.isEmpty || terminal != nil else { return }
        onFlush(events, terminal)
    }

    private static func isTerminalEvent(_ event: AgentStreamEvent) -> Bool {
        ["run.completed", "run.failed", "run.cancelled"].contains(event.type)
    }
}
