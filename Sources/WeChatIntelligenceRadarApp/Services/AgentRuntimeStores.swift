import AppKit
import CryptoKit
import Foundation

struct AgentRuntimePathResolver {
    let pathResolver: RuntimePathResolver

    init(pathResolver: RuntimePathResolver = RuntimePathResolver()) {
        self.pathResolver = pathResolver
    }

    var agentRuntimeDirectory: URL {
        pathResolver.runtimeDirectory.appendingPathComponent("agent", isDirectory: true)
    }

    var sessionsDirectory: URL {
        agentRuntimeDirectory.appendingPathComponent("sessions", isDirectory: true)
    }

    var tasksDirectory: URL {
        agentRuntimeDirectory.appendingPathComponent("tasks", isDirectory: true)
    }

    var runsDirectory: URL {
        agentRuntimeDirectory.appendingPathComponent("runs", isDirectory: true)
    }

    var attachmentsDirectory: URL {
        agentRuntimeDirectory.appendingPathComponent("attachments", isDirectory: true)
    }

    var agentRuntimePackageDirectory: URL {
        pathResolver.root.appendingPathComponent("agent-runtime", isDirectory: true)
    }
}

struct AgentStreamStore {
    let resolver: AgentRuntimePathResolver
    let fileManager: FileManager

    init(resolver: AgentRuntimePathResolver = AgentRuntimePathResolver(), fileManager: FileManager = .default) {
        self.resolver = resolver
        self.fileManager = fileManager
    }

    func readSessions() -> [AgentSession] {
        readDirectory(resolver.sessionsDirectory, as: AgentSession.self)
            .sorted { $0.updatedAt > $1.updatedAt }
    }

    func renameSession(sessionID: String, title: String) throws -> AgentSession? {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let url = resolver.sessionsDirectory.appendingPathComponent("\(safeAgentSegment(sessionID)).json")
        guard let data = try? Data(contentsOf: url),
              let session = try? JSONDecoder.agentArtifactDecoder().decode(AgentSession.self, from: data) else {
            return nil
        }
        let updated = AgentSession(
            schemaVersion: session.schemaVersion,
            sessionID: session.sessionID,
            title: trimmed,
            createdAt: session.createdAt,
            updatedAt: AgentDateFormatting.isoString(Date()),
            status: session.status,
            activeRunID: session.activeRunID,
            messages: session.messages
        )
        try JSONEncoder.agentArtifactEncoder().encode(updated).write(to: url, options: [.atomic])
        return updated
    }

    func readTasks() -> [AgentLongTask] {
        readDirectory(resolver.tasksDirectory, as: AgentLongTask.self)
            .sorted { $0.updatedAt > $1.updatedAt }
    }

    func readEvents(runID: String?) -> [AgentStreamEvent] {
        guard let runID, !runID.isEmpty else { return [] }
        let url = resolver.runsDirectory
            .appendingPathComponent(runID, isDirectory: true)
            .appendingPathComponent("events.ndjson")
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return [] }
        return text
            .split(separator: "\n")
            .compactMap { line in
                try? JSONDecoder.agentArtifactDecoder().decode(AgentStreamEvent.self, from: Data(line.utf8))
            }
    }

    func readToolCalls(runID: String?) -> [AgentToolCallRecord] {
        guard let runID else { return [] }
        let url = resolver.runsDirectory
            .appendingPathComponent(runID, isDirectory: true)
            .appendingPathComponent("tool-calls.json")
        guard let data = try? Data(contentsOf: url) else { return [] }
        return (try? JSONDecoder.agentArtifactDecoder().decode([AgentToolCallRecord].self, from: data)) ?? []
    }

    func readRunManifest(runID: String?) -> AgentRunManifest? {
        readRunArtifact(runID: runID, name: "run-manifest.json", as: AgentRunManifest.self)
    }

    func readContextSummary(runID: String?) -> AgentContextPlaneSummary? {
        readRunArtifact(runID: runID, name: "context-summary.json", as: AgentContextPlaneSummary.self)
            ?? readRunManifest(runID: runID)?.contextSummary
    }

    func readControlSummary(runID: String?) -> AgentControlPlaneSummary? {
        readRunArtifact(runID: runID, name: "control-summary.json", as: AgentControlPlaneSummary.self)
            ?? readRunManifest(runID: runID)?.controlSummary
    }

    func hasToolObservations(runID: String?) -> Bool {
        guard let runID, !runID.isEmpty else { return false }
        let url = resolver.runsDirectory
            .appendingPathComponent(runID, isDirectory: true)
            .appendingPathComponent("tool-observations.json")
        return fileManager.fileExists(atPath: url.path)
    }

    func readFinalOutput(runID: String?) -> String? {
        guard let runID, !runID.isEmpty else { return nil }
        let url = resolver.runsDirectory
            .appendingPathComponent(runID, isDirectory: true)
            .appendingPathComponent("final-output.md")
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    func readRunArtifact<T: Decodable>(runID: String?, name: String, as type: T.Type) -> T? {
        guard let runID else { return nil }
        let url = resolver.runsDirectory
            .appendingPathComponent(runID, isDirectory: true)
            .appendingPathComponent(name)
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder.agentArtifactDecoder().decode(T.self, from: data)
    }

    private func readDirectory<T: Decodable>(_ directory: URL, as type: T.Type) -> [T] {
        guard let urls = try? fileManager.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) else { return [] }
        return urls
            .filter { $0.pathExtension == "json" }
            .compactMap { url in
                guard let data = try? Data(contentsOf: url) else { return nil }
                return try? JSONDecoder.agentArtifactDecoder().decode(T.self, from: data)
            }
    }
}

struct AgentRunReadModelStore {
    let streamStore: AgentStreamStore

    init(streamStore: AgentStreamStore = AgentStreamStore()) {
        self.streamStore = streamStore
    }

    func readFinalReadModel(runID: String?) -> AgentFinalReadModel? {
        streamStore.readRunArtifact(runID: runID, name: "agent-final-read-model.json", as: AgentFinalReadModel.self)
    }

    func readCMCCapabilitySummary(runID: String?) -> CMCCapabilitySummary? {
        streamStore.readRunArtifact(runID: runID, name: "cmc-capability-summary.json", as: CMCCapabilitySummary.self)
    }

    func readCloudASRSummary(runID: String?) -> CloudASRSummary? {
        streamStore.readRunArtifact(runID: runID, name: "cloud-asr-summary.json", as: CloudASRSummary.self)
    }

    func readCapabilityLoopReadModel(runID: String?) -> CapabilityLoopReadModel? {
        streamStore.readRunArtifact(runID: runID, name: "capability-loop-read-model.json", as: CapabilityLoopReadModel.self)
    }

    func readMemoryReadModel(runID: String?) -> AgentMemoryReadModel? {
        streamStore.readRunArtifact(runID: runID, name: "memory-read-model.json", as: AgentMemoryReadModel.self)
    }

    func readSubagentCoordinationReadModel(runID: String?) -> SubagentCoordinationReadModel? {
        streamStore.readRunArtifact(runID: runID, name: "subagent-coordination-read-model.json", as: SubagentCoordinationReadModel.self)
    }

    func readHarnessSessionTree(runID: String?) -> HarnessSessionTreeReadModel? {
        streamStore.readRunArtifact(runID: runID, name: "harness-session-tree.json", as: HarnessSessionTreeReadModel.self)
    }

    func readHarnessBranchLineage(runID: String?) -> HarnessBranchLineageReadModel? {
        streamStore.readRunArtifact(runID: runID, name: "harness-branch-lineage.json", as: HarnessBranchLineageReadModel.self)
    }

    func readReviewReadModel(runID: String?) -> ReviewReadModel? {
        streamStore.readRunArtifact(runID: runID, name: "review-read-model.json", as: ReviewReadModel.self)
    }

    func readEvents(runID: String?) -> [AgentStreamEvent] {
        streamStore.readEvents(runID: runID)
    }

    func readToolCalls(runID: String?) -> [AgentToolCallRecord] {
        streamStore.readToolCalls(runID: runID)
    }

    func readRunManifest(runID: String?) -> AgentRunManifest? {
        streamStore.readRunManifest(runID: runID)
    }

    func readContextSummary(runID: String?) -> AgentContextPlaneSummary? {
        streamStore.readContextSummary(runID: runID)
    }

    func readControlSummary(runID: String?) -> AgentControlPlaneSummary? {
        streamStore.readControlSummary(runID: runID)
    }

    func hasToolObservations(runID: String?) -> Bool {
        streamStore.hasToolObservations(runID: runID)
    }
}

struct AgentToolRegistryStore {
    let resolver: AgentRuntimePathResolver

    init(resolver: AgentRuntimePathResolver = AgentRuntimePathResolver()) {
        self.resolver = resolver
    }

    func read() -> AgentToolRegistryPayload {
        let url = resolver.agentRuntimePackageDirectory
            .appendingPathComponent("runtime", isDirectory: true)
            .appendingPathComponent("public-surface.json")
        guard let data = try? Data(contentsOf: url),
              let payload = try? JSONDecoder.agentArtifactDecoder().decode(AgentToolRegistryPayload.self, from: data) else {
            return Self.defaultPublicSurface()
        }
        if payload.skills.isEmpty && payload.extensions.isEmpty {
            return Self.defaultPublicSurface()
        }
        return payload
    }

    static func defaultPublicSurface() -> AgentToolRegistryPayload {
        AgentToolRegistryPayload(
            capabilities: [],
            skills: [
                AgentSkillManifest(
                    skillID: "wechat-onchain-intelligence",
                    title: "微信 x 链上情报",
                    description: "合并本地微信情报、Token、行情和链上快照，生成情报卡和行动建议。",
                    category: "intelligence",
                    defaultSelected: true,
                    status: "available",
                    permissionSummary: "本地 artifact 读写；live WeChat 只读刷新仅在本机开关启用时自动执行。"
                ),
                AgentSkillManifest(
                    skillID: "cmc-market-radar",
                    title: "CoinMarketCap 市场雷达",
                    description: "读取 CMC / CoinMarketCap 市场证据，形成行情快照、市场风险和观察线索。",
                    category: "market",
                    defaultSelected: true,
                    status: "available",
                    permissionSummary: "默认自动尝试 CMC MCP HTTP / bridge / CMC REST；不可用时降级为 normalized/fixture。"
                ),
                AgentSkillManifest(
                    skillID: "market-regime-review",
                    title: "市场状态复核",
                    description: "判断市场状态、风险预算和需要继续追踪的 Token/板块。",
                    category: "market",
                    defaultSelected: false,
                    status: "available",
                    permissionSummary: "研究用途，不生成交易指令。"
                ),
                AgentSkillManifest(
                    skillID: "image-analysis",
                    title: "图片理解",
                    description: "把截图或图片与当前情报上下文合并分析。",
                    category: "multimodal",
                    defaultSelected: false,
                    status: "available",
                    permissionSummary: "图片 hash 和记录文件本地保存；外发分析取决于 Kimi 配置。"
                ),
                AgentSkillManifest(
                    skillID: "equity-company-deep-dive",
                    title: "Company Deep Dive",
                    description: "生成公司研究草稿：业务质量、财务线索、竞争格局、证据缺口和下一轮复核任务。",
                    category: "markets",
                    defaultSelected: false,
                    status: "available",
                    permissionSummary: "本地研究草稿；不输出 BUY/HOLD/SELL、仓位或交易价位。"
                ),
                AgentSkillManifest(
                    skillID: "equity-earnings-review",
                    title: "Earnings Review",
                    description: "复核财报、guidance、管理层语气、风险和需要补充的材料。",
                    category: "markets",
                    defaultSelected: false,
                    status: "available",
                    permissionSummary: "方法论草稿；live equity provider 当前未启用。"
                ),
                AgentSkillManifest(
                    skillID: "equity-thesis-tracker",
                    title: "Thesis Tracker",
                    description: "把股票 thesis 拆成支持证据、反证、证据缺口和人工复核清单。",
                    category: "markets",
                    defaultSelected: false,
                    status: "available",
                    permissionSummary: "只生成研究倾向和复核任务，不生成交易执行建议。"
                ),
                AgentSkillManifest(
                    skillID: "equity-sector-scan",
                    title: "Sector Scan",
                    description: "整理行业 read-through、主题线索和需要继续研究的公司候选。",
                    category: "markets",
                    defaultSelected: false,
                    status: "available",
                    permissionSummary: "需要用户材料或后续 provider 证据补齐。"
                ),
                AgentSkillManifest(
                    skillID: "macro-cross-asset-readthrough",
                    title: "Macro / Cross-asset",
                    description: "连接 crypto、equity、sector 与宏观线索，输出研究候选和复核任务。",
                    category: "markets",
                    defaultSelected: false,
                    status: "available",
                    permissionSummary: "跨市场研究草稿；不生成具体交易价位。"
                )
            ],
            extensions: [
                AgentExtensionManifest(
                    extensionID: "wechat-cli-export-bridge",
                    title: "WeChatCLI 能力包",
                    description: "读取用户提供的导出/fixture 文件并归一化为 Agent 可用的微信消息。",
                    category: "wechat",
                    defaultSelected: true,
                    status: "available",
                    permissionSummary: "只读刷新可由 daemon 代管；原始 live wechat-cli 命令和发送能力保持 blocked。"
                ),
                AgentExtensionManifest(
                    extensionID: "cmc-skill-hub",
                    title: "CMC Skill Hub 能力包",
                    description: "提供 CoinMarketCap Skill Hub / MCP 市场能力，优先走官方 MCP HTTP，其次 bridge、CMC REST、normalized file 和 fixture fallback。",
                    category: "market",
                    defaultSelected: true,
                    status: "available",
                    permissionSummary: "只读市场数据自动刷新；MCP/REST 不可用时明确降级，不伪造 live 数据。"
                ),
                AgentExtensionManifest(
                    extensionID: "markets-research",
                    title: "Markets Research 能力包",
                    description: "把股票研究方法论、公司 deep dive、财报复核、行业扫描和跨资产 read-through 组织成安全研究草稿。",
                    category: "markets",
                    defaultSelected: false,
                    status: "available",
                    permissionSummary: "本轮只启用本地 prompt/framework 与 dispatcher；live equity provider 延后接入。"
                )
            ],
            templates: [
                AgentSurfaceTemplateManifest(
                    templateID: "daily-intel",
                    title: "分析今日重点",
                    skillIDs: ["wechat-onchain-intelligence", "cmc-market-radar"],
                    extensionIDs: ["wechat-cli-export-bridge", "cmc-skill-hub"]
                ),
                AgentSurfaceTemplateManifest(
                    templateID: "token-check",
                    title: "检查某个 Token",
                    skillIDs: ["wechat-onchain-intelligence", "market-regime-review"],
                    extensionIDs: ["cmc-skill-hub"]
                ),
                AgentSurfaceTemplateManifest(
                    templateID: "markets-company-deep-dive",
                    title: "公司研究草稿",
                    skillIDs: ["equity-company-deep-dive", "equity-earnings-review", "equity-thesis-tracker"],
                    extensionIDs: ["markets-research"]
                ),
                AgentSurfaceTemplateManifest(
                    templateID: "markets-cross-asset-readthrough",
                    title: "跨市场 read-through",
                    skillIDs: ["macro-cross-asset-readthrough", "equity-sector-scan"],
                    extensionIDs: ["markets-research", "cmc-skill-hub"]
                )
            ],
            providers: [],
            extensionPackages: [],
            tools: [],
            internalToolsExposed: false
        )
    }
}

struct AgentOpsSnapshot: Hashable {
    let providerStatusPath: String
    let dependencyStatusPath: String
    let healthPath: String
    let policySummaryPath: String
    let providerSummary: String
    let dependencySummary: String
    let policySummary: String
}

struct AgentOpsRuntimeStore {
    let resolver: AgentRuntimePathResolver

    init(resolver: AgentRuntimePathResolver = AgentRuntimePathResolver()) {
        self.resolver = resolver
    }

    func read() -> AgentOpsSnapshot {
        let opsDirectory = resolver.pathResolver.runtimeDirectory.appendingPathComponent("ops", isDirectory: true)
        let providerURL = opsDirectory.appendingPathComponent("provider-status.json")
        let dependencyURL = opsDirectory.appendingPathComponent("dependency-status.json")
        let policyURL = opsDirectory.appendingPathComponent("policy", isDirectory: true).appendingPathComponent("latest-policy-summary.json")

        return AgentOpsSnapshot(
            providerStatusPath: "runtime/ops/provider-status.json",
            dependencyStatusPath: "runtime/ops/dependency-status.json",
            healthPath: "runtime/ops/health/agent-runtime-host.json",
            policySummaryPath: "runtime/ops/policy/latest-policy-summary.json",
            providerSummary: summary(url: providerURL, fallback: "等待 Agent Runtime Host 写入 provider status"),
            dependencySummary: summary(url: dependencyURL, fallback: "等待 Agent Runtime Host 写入 dependency status"),
            policySummary: summary(url: policyURL, fallback: "真实微信、live wechat-cli、交易、发消息、外部发布默认阻断")
        )
    }

    private func summary(url: URL, fallback: String) -> String {
        guard let data = try? Data(contentsOf: url),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return fallback
        }
        if let missing = object["missingProviderCount"] as? Int {
            return missing == 0 ? "provider ready" : "\(missing) provider missing config"
        }
        if let node = object["node"] as? [String: Any],
           let version = node["version"] as? String,
           let ok = node["satisfiesRequired"] as? Bool {
            return "\(version) · \(ok ? "compatible" : "needs upgrade")"
        }
        if let policy = object["defaultBoundary"] as? String {
            return policy
        }
        if let status = object["status"] as? String {
            return status
        }
        return fallback
    }
}

struct AgentProductMutationStore {
    let resolver: AgentRuntimePathResolver

    init(resolver: AgentRuntimePathResolver = AgentRuntimePathResolver()) {
        self.resolver = resolver
    }

    func read(runID: String) -> AgentProductMutationPayload? {
        let url = resolver.runsDirectory
            .appendingPathComponent(safeAgentSegment(runID), isDirectory: true)
            .appendingPathComponent("product-mutations.json")
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder.agentArtifactDecoder().decode(AgentProductMutationPayload.self, from: data)
    }
}

struct AgentAttachmentStore {
    let resolver: AgentRuntimePathResolver
    let fileManager: FileManager

    init(resolver: AgentRuntimePathResolver = AgentRuntimePathResolver(), fileManager: FileManager = .default) {
        self.resolver = resolver
        self.fileManager = fileManager
    }

    func copyImage(from sourceURL: URL) throws -> AgentAttachment {
        try copyAttachment(from: sourceURL, status: "ready_for_kimi_analysis", analysisPathKind: "analysis.json")
    }

    func copyMediaForCloudASR(from sourceURL: URL) throws -> AgentAttachment {
        try copyAttachment(from: sourceURL, status: "ready_for_cloud_asr", analysisPathKind: nil)
    }

    private func copyAttachment(from sourceURL: URL, status: String, analysisPathKind: String?) throws -> AgentAttachment {
        let attachmentID = "attachment-\(UUID().uuidString)"
        let directory = resolver.attachmentsDirectory.appendingPathComponent(attachmentID, isDirectory: true)
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)

        let ext = sourceURL.pathExtension.isEmpty ? "img" : sourceURL.pathExtension
        let destination = directory.appendingPathComponent("original.\(safeAgentSegment(ext))")
        if fileManager.fileExists(atPath: destination.path) {
            try fileManager.removeItem(at: destination)
        }
        try fileManager.copyItem(at: sourceURL, to: destination)
        let data = try Data(contentsOf: destination)
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        let metadataURL = directory.appendingPathComponent("attachment.json")
        let attachment = AgentAttachment(
            attachmentID: attachmentID,
            fileName: sourceURL.lastPathComponent,
            originalPath: destination.path,
            artifactPath: "runtime/agent/attachments/\(attachmentID)/original.\(ext)",
            mimeType: mimeType(for: ext),
            sha256: digest,
            sizeBytes: data.count,
            status: status,
            analysisPath: analysisPathKind.map { "runtime/agent/attachments/\(attachmentID)/\($0)" },
            createdAt: AgentDateFormatting.isoString(Date())
        )
        try JSONEncoder.agentArtifactEncoder().encode(attachment).write(to: metadataURL, options: [.atomic])
        return attachment
    }

    private func mimeType(for pathExtension: String) -> String {
        switch pathExtension.lowercased() {
        case "jpg", "jpeg":
            return "image/jpeg"
        case "png":
            return "image/png"
        case "gif":
            return "image/gif"
        case "webp":
            return "image/webp"
        case "mp3":
            return "audio/mpeg"
        case "m4a":
            return "audio/mp4"
        case "wav":
            return "audio/wav"
        case "aac":
            return "audio/aac"
        case "flac":
            return "audio/flac"
        case "ogg", "opus":
            return "audio/ogg"
        case "mp4", "m4v":
            return "video/mp4"
        case "mov":
            return "video/quicktime"
        case "webm":
            return "video/webm"
        case "mkv":
            return "video/x-matroska"
        default:
            return "application/octet-stream"
        }
    }
}

private func safeAgentSegment(_ value: String) -> String {
    value.replacingOccurrences(of: "[^A-Za-z0-9_.-]", with: "_", options: .regularExpression)
}
