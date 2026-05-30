import Foundation

struct AgentDaemonClient {
    var baseURL: URL = URL(string: "http://127.0.0.1:8797")!
    var session: URLSession = .shared

    func health() async throws -> AgentDaemonStatus {
        try await get("/health", as: AgentDaemonStatus.self)
    }

    func capabilities() async throws -> AgentToolRegistryPayload {
        try await get("/capabilities", as: AgentToolRegistryPayload.self)
    }

    func createSession(title: String) async throws -> AgentSession {
        try await post("/sessions", body: ["title": title], as: AgentSession.self)
    }

    func getSession(_ sessionID: String) async throws -> AgentSession {
        try await get("/sessions/\(sessionID)", as: AgentSession.self)
    }

    func postMessage(
        sessionID: String,
        prompt: String,
        selectedSkillIDs: [String],
        selectedExtensionIDs: [String],
        attachments: [AgentAttachment],
        contextRefs: [RuntimeObjectReference]
    ) async throws -> AgentMessageResponse {
        let body = AgentMessageRequest(
            prompt: prompt,
            selectedSkillIDs: selectedSkillIDs,
            selectedExtensionIDs: selectedExtensionIDs,
            attachments: attachments,
            contextRefs: contextRefs
        )
        return try await post("/sessions/\(sessionID)/messages", body: body, as: AgentMessageResponse.self)
    }

    func postMessageAsync(
        sessionID: String,
        prompt: String,
        selectedSkillIDs: [String],
        selectedExtensionIDs: [String],
        attachments: [AgentAttachment],
        contextRefs: [RuntimeObjectReference]
    ) async throws -> AgentAsyncMessageResponse {
        let body = AgentMessageRequest(
            prompt: prompt,
            selectedSkillIDs: selectedSkillIDs,
            selectedExtensionIDs: selectedExtensionIDs,
            attachments: attachments,
            contextRefs: contextRefs
        )
        return try await post("/sessions/\(sessionID)/messages/async", body: body, as: AgentAsyncMessageResponse.self)
    }

    func control(runID: String, action: String) async throws -> AgentStreamEvent {
        try await post("/runs/\(runID)/\(action)", body: [String: String](), as: AgentStreamEvent.self)
    }

    private func get<T: Decodable>(_ path: String, as type: T.Type) async throws -> T {
        let url = endpoint(path)
        var request = URLRequest(url: url, timeoutInterval: 3)
        request.httpMethod = "GET"
        let (data, response) = try await session.data(for: request)
        try validate(response: response, data: data)
        return try JSONDecoder.agentArtifactDecoder().decode(T.self, from: data)
    }

    private func post<Body: Encodable, T: Decodable>(_ path: String, body: Body, as type: T.Type) async throws -> T {
        let url = endpoint(path)
        var request = URLRequest(url: url, timeoutInterval: 90)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder.agentArtifactEncoder().encode(body)
        let (data, response) = try await session.data(for: request)
        try validate(response: response, data: data)
        return try JSONDecoder.agentArtifactDecoder().decode(T.self, from: data)
    }

    private func endpoint(_ path: String) -> URL {
        let normalized = path.hasPrefix("/") ? path : "/\(path)"
        return URL(string: normalized, relativeTo: baseURL)!.absoluteURL
    }

    private func validate(response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let preview = String(data: data, encoding: .utf8)?.prefix(500) ?? ""
            throw AgentDaemonClientError.http(String(preview))
        }
    }
}

private struct AgentMessageRequest: Encodable {
    let prompt: String
    let selectedSkillIDs: [String]
    let selectedExtensionIDs: [String]
    let attachments: [AgentAttachment]
    let contextRefs: [RuntimeObjectReference]
}

enum AgentDaemonClientError: LocalizedError {
    case http(String)

    var errorDescription: String? {
        switch self {
        case let .http(message):
            return "Agent daemon HTTP error: \(message)"
        }
    }
}

struct AgentEventStreamClient {
    var baseURL: URL = URL(string: "http://127.0.0.1:8797")!
    var session: URLSession = .shared

    func events(runID: String) -> AsyncThrowingStream<AgentStreamEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let url = URL(string: "/runs/\(runID)/events", relativeTo: baseURL)!.absoluteURL
                    var request = URLRequest(url: url, timeoutInterval: 300)
                    request.httpMethod = "GET"
                    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    let (bytes, response) = try await session.bytes(for: request)
                    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                        throw AgentDaemonClientError.http("Agent event stream failed")
                    }
                    for try await rawLine in bytes.lines {
                        let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard line.hasPrefix("data:") else { continue }
                        let payload = line.dropFirst(5).trimmingCharacters(in: .whitespacesAndNewlines)
                        guard let data = payload.data(using: .utf8) else { continue }
                        let event = try JSONDecoder.agentArtifactDecoder().decode(AgentStreamEvent.self, from: data)
                        continuation.yield(event)
                        if ["run.completed", "run.failed", "run.cancelled"].contains(event.type) {
                            continuation.finish()
                            return
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in
                task.cancel()
            }
        }
    }
}
