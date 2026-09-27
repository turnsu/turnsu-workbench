import Foundation

struct AgentDaemonClient {
    private let baseURL: URL
    private let session: URLSession
    private let authToken: String?
    private let contractTestAccess: Bool

    init(session: URLSession = .shared) {
        self.baseURL = URL(string: "https://legacy-agent-disabled.invalid")!
        self.session = session
        self.authToken = nil
        self.contractTestAccess = false
    }

    private init(baseURL: URL, session: URLSession, authToken: String?) {
        self.baseURL = baseURL
        self.session = session
        self.authToken = authToken
        self.contractTestAccess = true
    }

    static func contractTest(
        baseURL: URL,
        session: URLSession,
        authToken: String? = nil
    ) throws -> AgentDaemonClient {
        guard ProcessInfo.processInfo.environment["WORKBENCH_TEST_MODE"] == "1" else {
            throw AgentDaemonClientError.contractTestModeRequired
        }
        guard isContractTestURL(baseURL) else {
            throw AgentDaemonClientError.contractTestURLRequired
        }
        return AgentDaemonClient(baseURL: baseURL, session: session, authToken: authToken)
    }

    func health() async throws -> AgentDaemonStatus {
        try await get("/health", as: AgentDaemonStatus.self)
    }

    func capabilities() async throws -> AgentToolRegistryPayload {
        try await get("/capabilities", as: AgentToolRegistryPayload.self)
    }

    func createSession(title: String) async throws -> AgentSession {
        try await post("/sessions", body: ["title": title], as: AgentSession.self)
    }

    func listSessions() async throws -> [AgentSession] {
        try await get("/sessions", as: AgentSessionListResponse.self).sessions
    }

    func getSession(_ sessionID: String) async throws -> AgentSession {
        try await get("/sessions/\(sessionID)", as: AgentSession.self)
    }

    func renameSession(_ sessionID: String, title: String) async throws -> AgentSession {
        try await patch("/sessions/\(sessionID)", body: ["title": title], as: AgentSession.self)
    }

    func deleteSession(_ sessionID: String) async throws -> AgentDeleteResult {
        try await delete("/sessions/\(sessionID)", as: AgentDeleteResult.self)
    }

    func listTasks() async throws -> [AgentLongTask] {
        try await get("/tasks", as: AgentTaskListResponse.self).tasks
    }

    func deleteTask(_ taskID: String) async throws -> AgentDeleteResult {
        try await delete("/tasks/\(taskID)", as: AgentDeleteResult.self)
    }

    func deleteRun(_ runID: String) async throws -> AgentDeleteResult {
        try await delete("/runs/\(runID)", as: AgentDeleteResult.self)
    }

    func resetRuntime() async throws -> AgentRuntimeResetResult {
        try await post("/admin/runtime/reset", body: [String: String](), as: AgentRuntimeResetResult.self)
    }

    func postMessage(
        sessionID: String,
        prompt: String,
        selectedSkillIDs: [String],
        selectedExtensionIDs: [String],
        attachments: [AgentAttachment],
        contextRefs: [RuntimeObjectReference],
        modelPreference: AgentModelPreference = AgentModelPreferenceOption.auto.requestPayload
    ) async throws -> AgentMessageResponse {
        let body = AgentMessageRequest(
            prompt: prompt,
            selectedSkillIDs: selectedSkillIDs,
            selectedExtensionIDs: selectedExtensionIDs,
            attachments: attachments,
            contextRefs: contextRefs,
            modelPreference: modelPreference
        )
        return try await post("/sessions/\(sessionID)/messages", body: body, as: AgentMessageResponse.self)
    }

    func postMessageAsync(
        sessionID: String,
        prompt: String,
        selectedSkillIDs: [String],
        selectedExtensionIDs: [String],
        attachments: [AgentAttachment],
        contextRefs: [RuntimeObjectReference],
        modelPreference: AgentModelPreference = AgentModelPreferenceOption.auto.requestPayload
    ) async throws -> AgentAsyncMessageResponse {
        let body = AgentMessageRequest(
            prompt: prompt,
            selectedSkillIDs: selectedSkillIDs,
            selectedExtensionIDs: selectedExtensionIDs,
            attachments: attachments,
            contextRefs: contextRefs,
            modelPreference: modelPreference
        )
        return try await post("/sessions/\(sessionID)/messages/async", body: body, as: AgentAsyncMessageResponse.self)
    }

    func control(runID: String, action: String) async throws -> AgentStreamEvent {
        try await post("/runs/\(runID)/\(action)", body: [String: String](), as: AgentStreamEvent.self)
    }

    /// Ask the daemon to pull fresh local WeChat via wechat-cli (read-only) and write
    /// runtime/wechat/messages.live.json. Returns its status (ok / degraded / disabled).
    func refreshWechatLive() async throws -> WeChatLiveRefreshResult {
        try await post("/wechat/live/refresh", body: [String: String](), as: WeChatLiveRefreshResult.self)
    }

    private func get<T: Decodable>(_ path: String, as type: T.Type) async throws -> T {
        try requireContractTestAccess()
        let url = endpoint(path)
        var request = URLRequest(url: url, timeoutInterval: 3)
        request.httpMethod = "GET"
        applyAuth(to: &request)
        let (data, response) = try await session.data(for: request)
        try validate(response: response, data: data)
        return try JSONDecoder.agentArtifactDecoder().decode(T.self, from: data)
    }

    private func post<Body: Encodable, T: Decodable>(_ path: String, body: Body, as type: T.Type) async throws -> T {
        try requireContractTestAccess()
        let url = endpoint(path)
        var request = URLRequest(url: url, timeoutInterval: 90)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(to: &request)
        request.httpBody = try JSONEncoder.agentArtifactEncoder().encode(body)
        let (data, response) = try await session.data(for: request)
        try validate(response: response, data: data)
        return try JSONDecoder.agentArtifactDecoder().decode(T.self, from: data)
    }

    private func patch<Body: Encodable, T: Decodable>(_ path: String, body: Body, as type: T.Type) async throws -> T {
        try requireContractTestAccess()
        let url = endpoint(path)
        var request = URLRequest(url: url, timeoutInterval: 20)
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(to: &request)
        request.httpBody = try JSONEncoder.agentArtifactEncoder().encode(body)
        let (data, response) = try await session.data(for: request)
        try validate(response: response, data: data)
        return try JSONDecoder.agentArtifactDecoder().decode(T.self, from: data)
    }

    private func delete<T: Decodable>(_ path: String, as type: T.Type) async throws -> T {
        try requireContractTestAccess()
        let url = endpoint(path)
        var request = URLRequest(url: url, timeoutInterval: 20)
        request.httpMethod = "DELETE"
        applyAuth(to: &request)
        let (data, response) = try await session.data(for: request)
        try validate(response: response, data: data)
        return try JSONDecoder.agentArtifactDecoder().decode(T.self, from: data)
    }

    private func endpoint(_ path: String) -> URL {
        let normalized = path.hasPrefix("/") ? path : "/\(path)"
        return URL(string: normalized, relativeTo: baseURL)!.absoluteURL
    }

    private func applyAuth(to request: inout URLRequest) {
        guard let authToken, !authToken.isEmpty else { return }
        request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
    }

    private func requireContractTestAccess() throws {
        guard contractTestAccess else {
            throw AgentDaemonClientError.legacyClientDisabled
        }
    }

    private static func isContractTestURL(_ url: URL) -> Bool {
        guard url.scheme == "https", let host = url.host?.lowercased() else { return false }
        return host.hasSuffix(".test")
            || (host.hasSuffix(".invalid") && (host.contains("mock") || host.contains("_test")))
    }

    private func validate(response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let preview = String(data: data, encoding: .utf8)?.prefix(500) ?? ""
            throw AgentDaemonClientError.http(String(preview))
        }
    }
}

struct AgentSessionListResponse: Decodable {
    let schemaVersion: String?
    let sessions: [AgentSession]
}

struct AgentTaskListResponse: Decodable {
    let schemaVersion: String?
    let tasks: [AgentLongTask]
}

struct AgentDeleteResult: Codable, Hashable {
    let schemaVersion: String?
    let kind: String
    let id: String
    let runID: String?
    let deletedRunCount: Int?
    let status: String
}

struct AgentRuntimeResetResult: Codable, Hashable {
    let schemaVersion: String?
    let status: String
    let resetAt: String?
}

private struct AgentMessageRequest: Encodable {
    let prompt: String
    let selectedSkillIDs: [String]
    let selectedExtensionIDs: [String]
    let attachments: [AgentAttachment]
    let contextRefs: [RuntimeObjectReference]
    let modelPreference: AgentModelPreference
}

struct WeChatLiveRefreshResult: Decodable {
    let status: String          // ok / empty / degraded / disabled
    var messages: Int? = nil
    var sessions: Int? = nil
    var reason: String? = nil
    var hint: String? = nil
    var artifact: String? = nil
}

enum AgentDaemonClientError: LocalizedError {
    case legacyClientDisabled
    case contractTestModeRequired
    case contractTestURLRequired
    case http(String)

    var errorDescription: String? {
        switch self {
        case .legacyClientDisabled:
            return "历史 Swift Agent 客户端已停用，请使用 Web Product API。"
        case .contractTestModeRequired:
            return "legacy Agent contract client requires WORKBENCH_TEST_MODE=1"
        case .contractTestURLRequired:
            return "legacy Agent contract client requires an explicit .test or mock URL"
        case let .http(message):
            return "Agent daemon HTTP error: \(message)"
        }
    }
}

struct AgentEventStreamClient {
    private let baseURL: URL
    private let session: URLSession
    private let authToken: String?
    private let contractTestAccess: Bool

    init(session: URLSession = .shared) {
        self.baseURL = URL(string: "https://legacy-agent-disabled.invalid")!
        self.session = session
        self.authToken = nil
        self.contractTestAccess = false
    }

    private init(baseURL: URL, session: URLSession, authToken: String?) {
        self.baseURL = baseURL
        self.session = session
        self.authToken = authToken
        self.contractTestAccess = true
    }

    static func contractTest(
        baseURL: URL,
        session: URLSession,
        authToken: String? = nil
    ) throws -> AgentEventStreamClient {
        guard ProcessInfo.processInfo.environment["WORKBENCH_TEST_MODE"] == "1" else {
            throw AgentDaemonClientError.contractTestModeRequired
        }
        guard baseURL.scheme == "https",
              let host = baseURL.host?.lowercased(),
              host.hasSuffix(".test")
                || (host.hasSuffix(".invalid") && (host.contains("mock") || host.contains("_test")))
        else {
            throw AgentDaemonClientError.contractTestURLRequired
        }
        return AgentEventStreamClient(baseURL: baseURL, session: session, authToken: authToken)
    }

    func events(runID: String) -> AsyncThrowingStream<AgentStreamEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    guard contractTestAccess else {
                        throw AgentDaemonClientError.legacyClientDisabled
                    }
                    let url = URL(string: "/runs/\(runID)/events", relativeTo: baseURL)!.absoluteURL
                    var request = URLRequest(url: url, timeoutInterval: 300)
                    request.httpMethod = "GET"
                    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    if let authToken, !authToken.isEmpty {
                        request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
                    }
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
