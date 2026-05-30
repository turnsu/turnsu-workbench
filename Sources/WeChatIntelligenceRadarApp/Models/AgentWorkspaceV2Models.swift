import Foundation

enum AgentInspectorSelection: Hashable, Identifiable {
    case overview
    case message(String)
    case toolCall(String)
    case attachment(String)
    case event(String)
    case policy(String)
    case artifact(String)
    case task(String)
    case context(String)

    var id: String {
        switch self {
        case .overview:
            return "overview"
        case .message(let id):
            return "message:\(id)"
        case .toolCall(let id):
            return "tool:\(id)"
        case .attachment(let id):
            return "attachment:\(id)"
        case .event(let id):
            return "event:\(id)"
        case .policy(let id):
            return "policy:\(id)"
        case .artifact(let path):
            return "artifact:\(path)"
        case .task(let id):
            return "task:\(id)"
        case .context(let id):
            return "context:\(id)"
        }
    }
}

typealias AgentWorkspaceInspectorSelection = AgentInspectorSelection

struct AgentTaskTemplate: Identifiable, Hashable {
    let id: String
    let title: String
    let subtitle: String
    let prompt: String
    let icon: String
    let defaultSkillIDs: [String]
    let defaultExtensionIDs: [String]
}

enum AgentWorkspaceTaskTemplates {
    static let all: [AgentTaskTemplate] = [
        AgentTaskTemplate(
            id: "daily-intel",
            title: "分析今日重点",
            subtitle: "读取本地微信情报，结合 Token、行情和链上状态生成待处理事项。",
            prompt: "帮我看今天微信群里和 BTC、ETH、SOL 相关的重点讨论，结合行情和链上数据，列出我需要处理的 3 件事。",
            icon: "sparkle.magnifyingglass",
            defaultSkillIDs: ["wechat-onchain-intelligence", "cmc-market-radar"],
            defaultExtensionIDs: ["wechat-cli-export-bridge", "cmc-skill-hub"]
        ),
        AgentTaskTemplate(
            id: "token-check",
            title: "检查某个 Token",
            subtitle: "围绕一个 Token 或合约地址整理讨论、风险和下一步。",
            prompt: "帮我检查这个 Token 的微信讨论、行情状态和链上信号，判断是否值得加入观察列表。",
            icon: "bitcoinsign.circle",
            defaultSkillIDs: ["wechat-onchain-intelligence", "market-regime-review"],
            defaultExtensionIDs: ["cmc-skill-hub"]
        ),
        AgentTaskTemplate(
            id: "image-analysis",
            title: "从图片生成分析",
            subtitle: "把截图、图片内容和本地情报上下文合并判断。",
            prompt: "这张图里的项目值得加到观察列表吗？结合微信讨论和行情状态判断。",
            icon: "photo.on.rectangle.angled",
            defaultSkillIDs: ["image-analysis", "wechat-onchain-intelligence", "cmc-market-radar"],
            defaultExtensionIDs: ["wechat-cli-export-bridge", "cmc-skill-hub"]
        ),
        AgentTaskTemplate(
            id: "long-watch",
            title: "创建长期监控",
            subtitle: "生成一个可恢复的长期观察任务和复盘记录。",
            prompt: "接下来 24 小时帮我盯 SOL 相关讨论和异常链上信号，有变化时生成复盘。",
            icon: "clock.badge.checkmark",
            defaultSkillIDs: ["long-task", "handoff-writer"],
            defaultExtensionIDs: ["wechat-cli-export-bridge", "cmc-skill-hub"]
        )
    ]
}

struct AgentThreadState: Identifiable, Hashable {
    enum Status: String, Hashable {
        case idle
        case composing
        case running
        case waitingForApproval
        case completed
        case failed
        case blocked
        case paused
        case cancelled
    }

    let id: String
    let title: String
    let status: Status
    let statusText: String
    let messages: [AgentThreadMessage]
    let activeTaskID: String?
    let activeRunID: String?
    let selectedContext: [AgentContextChip]
    let capabilityCalls: [CapabilityCallState]
    let approvals: [AgentApprovalState]
    let inspectorSelection: AgentInspectorSelection?
    let compactRunState: AgentCompactRunState
    let runManifest: AgentRunManifest?
    let controlSummary: AgentControlPlaneSummary?
    let contextSummary: AgentContextPlaneSummary?
    let daemonSummary: String
    let providerSummary: String
    let longTasks: [AgentLongTask]
    let availableTemplates: [AgentTaskTemplate]
    let createdAt: String?
    let updatedAt: String?

    var run: AgentCompactRunState { compactRunState }
}

typealias AgentThreadStatus = AgentThreadState.Status

struct AgentThreadMessage: Identifiable, Hashable {
    enum Role: String, Hashable {
        case user
        case assistant
        case system
        case tool
        case unknown
    }

    let id: String
    let role: Role
    let authorName: String
    let parts: [AgentMessagePart]
    let attachments: [AgentAttachment]
    let contextChips: [AgentContextChip]
    let linkedArtifacts: [RuntimeObjectReference]
    let runID: String?
    let createdAt: String

    var displayName: String { authorName }
}

enum AgentMessagePart: Identifiable, Hashable {
    enum Kind: String, Hashable {
        case text
        case planSummary
        case toolCall
        case approvalRequest
        case attachment
        case evidence
        case finalOutput
        case error
    }

    case text(id: String, text: String)
    case planSummary(id: String, title: String, summary: String, evidenceRefs: [AgentContextChip])
    case capabilityCall(CapabilityCallState)
    case approvalRequest(AgentApprovalState)
    case attachment(id: String, title: String, summary: String, attachment: AgentAttachment)
    case evidence(AgentContextChip)
    case finalOutput(id: String, title: String, summary: String, artifactPath: String?)
    case error(id: String, title: String, message: String)

    var id: String {
        switch self {
        case .text(let id, _),
             .planSummary(let id, _, _, _),
             .attachment(let id, _, _, _),
             .finalOutput(let id, _, _, _),
             .error(let id, _, _):
            return id
        case .capabilityCall(let call):
            return call.id
        case .approvalRequest(let approval):
            return approval.id
        case .evidence(let chip):
            return chip.id
        }
    }

    var kind: Kind {
        switch self {
        case .text:
            return .text
        case .planSummary:
            return .planSummary
        case .capabilityCall:
            return .toolCall
        case .approvalRequest:
            return .approvalRequest
        case .attachment:
            return .attachment
        case .evidence:
            return .evidence
        case .finalOutput:
            return .finalOutput
        case .error:
            return .error
        }
    }
}

struct CapabilityCallState: Identifiable, Hashable {
    enum Status: String, Hashable {
        case preparing
        case running
        case waitingForApproval
        case completed
        case failed
        case blocked
        case cancelled
    }

    let id: String
    let toolName: String
    let displayName: String
    let status: Status
    let statusText: String
    let summary: String
    let policyDecision: AgentApprovalState?
    let inputSummary: String
    let outputSummary: String
    let artifactRefs: [RuntimeObjectReference]
    let rawStatus: String
    let rawPermission: String
    let createdAt: String?

    var technicalName: String { toolName }
    var inputsSummary: String { inputSummary }
    var permissionLabel: String { policyDecision?.statusText ?? AgentWorkspaceStateAdapter.permissionLabel(rawPermission) }
    var requiresUserDecision: Bool { status == .waitingForApproval || status == .blocked }
}

typealias CapabilityCallDisplayStatus = CapabilityCallState.Status

struct AgentApprovalState: Identifiable, Hashable {
    enum Status: String, Hashable {
        case allowed
        case needsApproval
        case blocked
    }

    let id: String
    let action: String
    let displayName: String
    let status: Status
    let statusText: String
    let title: String
    let reason: String
    let dataScopeText: String
    let consequenceText: String
    let artifactRefs: [RuntimeObjectReference]
    let rawStatus: String
    let createdAt: String?
    let runID: String?

    var actionSummary: String { displayName }
    var dataBoundary: String { dataScopeText }
    var outboundBoundary: String { consequenceText }
    var rejectionFallback: String { consequenceText }
    var isUserActionRequired: Bool { status == .needsApproval }
}

struct AgentContextChip: Identifiable, Hashable {
    let id: String
    let kind: RuntimeObjectReferenceKind
    let title: String
    let subtitle: String
    let confidenceText: String?
    let sourceText: String
    let privacyText: String
    let reference: RuntimeObjectReference

    var label: String { title }
    var detail: String { subtitle }
    var freshness: ProactiveFreshness { reference.freshness }
    var confidence: Double? { reference.confidence }
    var path: String? { reference.path }
}

struct AgentCompactRunState: Identifiable, Hashable {
    enum Status: String, Hashable {
        case idle
        case running
        case waitingForApproval
        case completed
        case failed
        case blocked
        case paused
        case cancelled
    }

    let id: String
    let runID: String?
    let taskID: String?
    let status: Status
    let statusText: String
    let activeCapabilityID: String?
    let activeCapabilityName: String?
    let lastEventText: String
    let artifactPath: String?
    let eventCount: Int
    let canPause: Bool
    let canResume: Bool
    let canCancel: Bool
    let updatedAt: String?

    var displayID: String { AgentWorkspaceStateAdapter.runDisplay(runID) }
    var latestStep: String { activeCapabilityName ?? statusText }
    var latestDetail: String { lastEventText }
}

struct AgentWorkspaceStateAdapter {
    static func makeThreadStates(
        sessions: [AgentSession],
        longTasks: [AgentLongTask] = [],
        daemonStatus: AgentDaemonStatus = .unavailable
    ) -> [AgentThreadState] {
        sessions.map { session in
            makeThreadState(
                session: session,
                messages: session.messages,
                streamEvents: [],
                toolCalls: [],
                longTasks: longTasks,
                daemonStatus: daemonStatus
            )
        }
    }

    static func makeThreadState(
        session: AgentSession?,
        messages: [AgentMessage] = [],
        streamEvents: [AgentStreamEvent] = [],
        toolCalls: [AgentToolCallRecord] = [],
        runManifest: AgentRunManifest? = nil,
        controlSummary: AgentControlPlaneSummary? = nil,
        contextSummary: AgentContextPlaneSummary? = nil,
        longTasks: [AgentLongTask] = [],
        daemonStatus: AgentDaemonStatus = .unavailable,
        selectedEventID: String? = nil,
        selectedMessageID: String? = nil,
        selectedToolCallID: String? = nil
    ) -> AgentThreadState {
        makeThreadState(
            selectedSession: session,
            messages: messages,
            streamEvents: streamEvents,
            toolCalls: toolCalls,
            runManifest: runManifest,
            controlSummary: controlSummary,
            contextSummary: contextSummary,
            longTasks: longTasks,
            daemonStatus: daemonStatus,
            contextRefs: [],
            selectedSkillIDs: [],
            selectedExtensionIDs: [],
            pendingAttachments: [],
            draftPrompt: "",
            selectedEventID: selectedEventID,
            selectedMessageID: selectedMessageID,
            selectedToolCallID: selectedToolCallID
        )
    }

    static func makeThreadState(
        selectedSession: AgentSession?,
        messages: [AgentMessage],
        streamEvents: [AgentStreamEvent],
        toolCalls: [AgentToolCallRecord],
        runManifest: AgentRunManifest? = nil,
        controlSummary: AgentControlPlaneSummary? = nil,
        contextSummary: AgentContextPlaneSummary? = nil,
        longTasks: [AgentLongTask],
        daemonStatus: AgentDaemonStatus,
        contextRefs: [RuntimeObjectReference],
        selectedSkillIDs: Set<String>,
        selectedExtensionIDs: Set<String>,
        pendingAttachments: [AgentAttachment],
        draftPrompt: String,
        selectedEventID: String? = nil,
        selectedMessageID: String? = nil,
        selectedToolCallID: String? = nil
    ) -> AgentThreadState {
        let resolvedMessages = messages.isEmpty ? (selectedSession?.messages ?? []) : messages
        let activeRunID = resolveRunID(session: selectedSession, streamEvents: streamEvents, longTasks: longTasks)
        let activeTask = resolveTask(session: selectedSession, runID: activeRunID, longTasks: longTasks)
        let contextChips = uniqueContextChips(
            makeContextChips(from: contextRefs) +
            resolvedMessages.flatMap { makeContextChips(from: $0.contextRefs ?? []) }
        )
        let calls = makeCapabilityCalls(toolCalls: toolCalls, streamEvents: streamEvents)
        let approvals = makeRunApprovals(toolCalls: toolCalls, streamEvents: streamEvents)
        let compactRunState = makeCompactRunState(
            session: selectedSession,
            streamEvents: streamEvents,
            toolCalls: toolCalls,
            runManifest: runManifest,
            controlSummary: controlSummary,
            contextSummary: contextSummary,
            longTasks: longTasks,
            daemonStatus: daemonStatus
        )
        let threadMessages = makeThreadMessages(
            from: resolvedMessages,
            streamEvents: streamEvents,
            capabilityCalls: calls,
            approvals: approvals,
            pendingAttachments: pendingAttachments,
            activeRunID: activeRunID
        )
        let status = threadStatus(
            sessionStatus: selectedSession?.status,
            runStatus: compactRunState.status,
            approvals: approvals,
            hasContent: !threadMessages.isEmpty,
            draftPrompt: draftPrompt
        )

        return AgentThreadState(
            id: selectedSession?.sessionID ?? activeRunID ?? activeTask?.taskID ?? "agent-thread-empty",
            title: nonEmpty(selectedSession?.title) ?? nonEmpty(activeTask?.prompt) ?? "新任务",
            status: status,
            statusText: threadStatusLabel(status),
            messages: threadMessages,
            activeTaskID: activeTask?.taskID,
            activeRunID: activeRunID,
            selectedContext: contextChips,
            capabilityCalls: calls,
            approvals: approvals,
            inspectorSelection: selection(eventID: selectedEventID, messageID: selectedMessageID, toolCallID: selectedToolCallID),
            compactRunState: compactRunState,
            runManifest: runManifest,
            controlSummary: controlSummary,
            contextSummary: contextSummary,
            daemonSummary: daemonSummary(daemonStatus),
            providerSummary: providerSummary(daemonStatus),
            longTasks: longTasks,
            availableTemplates: AgentWorkspaceTaskTemplates.all,
            createdAt: selectedSession?.createdAt ?? activeTask?.createdAt,
            updatedAt: selectedSession?.updatedAt ?? activeTask?.updatedAt
        )
    }

    static func makeContextChips(from references: [RuntimeObjectReference]) -> [AgentContextChip] {
        references.map { reference in
            AgentContextChip(
                id: "\(reference.kind.rawValue):\(reference.id)",
                kind: reference.kind,
                title: reference.label,
                subtitle: contextSubtitle(reference),
                confidenceText: reference.confidence.map { "可信度 \(Int(($0 * 100).rounded()))%" },
                sourceText: sourceLabel(reference.source),
                privacyText: privacyLabel(reference.privacyLevel, redactionStatus: reference.redactionStatus),
                reference: reference
            )
        }
    }

    static func makeCapabilityCalls(
        toolCalls: [AgentToolCallRecord],
        streamEvents: [AgentStreamEvent] = []
    ) -> [CapabilityCallState] {
        var calls = toolCalls.map(makeCapabilityCall)
        let existingToolNames = Set(calls.map(\.toolName))
        let eventCalls = streamEvents.compactMap { event -> CapabilityCallState? in
            guard event.type.lowercased().contains("tool"),
                  let toolName = nonEmpty(event.toolName),
                  !existingToolNames.contains(toolName) else {
                return nil
            }
            return makeCapabilityCall(from: event)
        }
        calls.append(contentsOf: eventCalls)
        return calls
    }

    static func makeApprovals(
        daemonStatus: AgentDaemonStatus,
        toolCalls: [AgentToolCallRecord] = [],
        streamEvents: [AgentStreamEvent] = []
    ) -> [AgentApprovalState] {
        uniqueApprovals(makeRunApprovals(toolCalls: toolCalls, streamEvents: streamEvents) + makePolicyBoundaryApprovals(daemonStatus))
    }

    static func makeCompactRunState(
        session: AgentSession?,
        streamEvents: [AgentStreamEvent] = [],
        toolCalls: [AgentToolCallRecord] = [],
        runManifest: AgentRunManifest? = nil,
        controlSummary: AgentControlPlaneSummary? = nil,
        contextSummary: AgentContextPlaneSummary? = nil,
        longTasks: [AgentLongTask] = [],
        daemonStatus: AgentDaemonStatus = .unavailable
    ) -> AgentCompactRunState {
        let activeRunID = nonEmpty(runManifest?.runID) ?? resolveRunID(session: session, streamEvents: streamEvents, longTasks: longTasks)
        let activeTask = resolveTask(session: session, runID: activeRunID, longTasks: longTasks)
        let calls = makeCapabilityCalls(toolCalls: toolCalls, streamEvents: streamEvents)
        let approvals = makeRunApprovals(toolCalls: toolCalls, streamEvents: streamEvents)
        let status = compactRunStatus(
            sessionStatus: session?.status,
            taskStatus: activeTask?.status,
            latestEvent: streamEvents.last,
            runManifest: runManifest,
            approvals: approvals,
            hasRun: activeRunID != nil || activeTask != nil || !streamEvents.isEmpty
        )
        let activeCall = calls.first(where: \.requiresUserDecision)
            ?? calls.last(where: { $0.status == .running || $0.status == .preparing })
            ?? calls.last
        let latestEvent = streamEvents.last
        let artifactPath = nonEmpty(latestEvent?.artifactPath)
            ?? activeCall?.artifactRefs.first?.path
            ?? nonEmpty(activeTask?.artifactPath)

        return AgentCompactRunState(
            id: activeRunID ?? activeTask?.taskID ?? "agent-run-idle",
            runID: activeRunID,
            taskID: activeTask?.taskID,
            status: status,
            statusText: compactRunStatusLabel(status, daemonStatus: daemonStatus),
            activeCapabilityID: activeCall?.id,
            activeCapabilityName: stageDisplayName(manifest: runManifest, controlSummary: controlSummary, activeCall: activeCall, status: status),
            lastEventText: runSummaryText(manifest: runManifest, controlSummary: controlSummary, contextSummary: contextSummary, latestEvent: latestEvent),
            artifactPath: artifactPath,
            eventCount: streamEvents.count,
            canPause: status == .running,
            canResume: status == .paused,
            canCancel: status == .running || status == .paused || status == .waitingForApproval,
            updatedAt: latestEvent?.timestamp ?? activeTask?.updatedAt ?? session?.updatedAt
        )
    }

    static func threadStatusLabel(_ status: AgentThreadState.Status) -> String {
        switch status {
        case .idle:
            return "未开始"
        case .composing:
            return "准备提交"
        case .running:
            return "Agent 正在处理"
        case .waitingForApproval:
            return "等待你确认"
        case .completed:
            return "已完成"
        case .failed:
            return "执行失败"
        case .blocked:
            return "已阻断"
        case .paused:
            return "已暂停"
        case .cancelled:
            return "已取消"
        }
    }

    static func statusLabel(_ status: CapabilityCallState.Status) -> String {
        switch status {
        case .preparing:
            return "准备中"
        case .running:
            return "运行中"
        case .waitingForApproval:
            return "需要你确认"
        case .completed:
            return "已完成"
        case .failed:
            return "失败"
        case .blocked:
            return "已阻断"
        case .cancelled:
            return "已取消"
        }
    }

    static func statusLabel(_ raw: String) -> String {
        let value = raw.lowercased()
        if value.contains("blocked") {
            return "已阻断"
        }
        if value.contains("needs_confirmation") || value.contains("confirmation") {
            return "需要你确认"
        }
        if value.contains("pass") || value.contains("local") {
            return "可本地使用"
        }
        if value.contains("completed") || value.contains("done") {
            return "已完成"
        }
        if value.contains("running") || value.contains("started") {
            return "运行中"
        }
        if value.contains("failed") || value.contains("error") {
            return "失败"
        }
        if value.isEmpty || value == "--" {
            return "--"
        }
        return raw.replacingOccurrences(of: "_", with: " ")
    }

    static func permissionLabel(_ raw: String) -> String {
        let value = raw.lowercased()
        if value.contains("blocked") {
            return "已阻断"
        }
        if value.contains("needs_confirmation") || value.contains("confirmation") {
            return "需要确认"
        }
        if value.contains("pass") || value.contains("local") {
            return "本地可用"
        }
        return raw.isEmpty ? "未声明" : statusLabel(raw)
    }

    static func approvalStatusLabel(_ status: AgentApprovalState.Status) -> String {
        switch status {
        case .allowed:
            return "本地可用"
        case .needsApproval:
            return "需要确认"
        case .blocked:
            return "已阻断"
        }
    }

    static func toolDisplayName(_ raw: String) -> String {
        switch raw {
        case "wechat.read_normalized_messages":
            return "微信 x 链上情报"
        case "token.resolve_entities":
            return "微信 x 链上情报"
        case "market.read_snapshot":
            return "CMC 市场雷达"
        case "onchain.read_snapshot":
            return "微信 x 链上情报"
        case "crystal.create_or_update":
            return "微信 x 链上情报"
        case "proposal.create":
            return "微信 x 链上情报"
        case "memory.save":
            return "本地记忆"
        case "handoff.write":
            return "交接包生成"
        case "image.analyze_with_kimi":
            return "图片理解"
        case "computer_use.request", "computerUse":
            return "申请电脑操作"
        case "wechat_cli.import_export_file":
            return "WeChatCLI 导出接入"
        case "wechat_cli.live_command":
            return "WeChatCLI 导出接入"
        case "cmc.read_market_evidence":
            return "CMC 市场雷达"
        case "cmc.detect_market_regime":
            return "市场状态复核"
        case "cmc.track_social_price_divergence":
            return "讨论与价格偏离"
        case "cmc.request_mcp_refresh":
            return "CMC Skill Hub"
        case "liveWechat":
            return "真实微信访问"
        case "liveWechatCLI":
            return "微信 CLI 操作"
        case "trade":
            return "交易 / 转账"
        case "sendMessage":
            return "发送消息"
        case "publishExternal":
            return "对外发布"
        case "policy":
            return "安全检查"
        default:
            return raw.replacingOccurrences(of: "_", with: " ")
        }
    }

    static func kindLabel(_ kind: RuntimeObjectReferenceKind) -> String {
        switch kind {
        case .evidence:
            return "证据"
        case .message:
            return "微信消息"
        case .token:
            return "Token"
        case .artifact:
            return "记录文件"
        case .marketSnapshot:
            return "行情快照"
        case .onchainSnapshot:
            return "链上快照"
        case .memory:
            return "记忆"
        case .crystal:
            return "情报卡"
        case .proposal:
            return "行动建议"
        case .handoff:
            return "交接包"
        case .session:
            return "对话任务"
        case .task:
            return "长期任务"
        case .alert:
            return "预警"
        case .watchlist:
            return "观察项"
        case .moduleRun:
            return "处理模块"
        case .subagentRun:
            return "子任务"
        case .policyDecision:
            return "安全边界"
        case .source:
            return "数据源"
        }
    }
}

extension AgentWorkspaceStateAdapter {
    static func makeThreadMessages(
        from messages: [AgentMessage],
        streamEvents: [AgentStreamEvent],
        capabilityCalls: [CapabilityCallState],
        approvals: [AgentApprovalState],
        pendingAttachments: [AgentAttachment],
        activeRunID: String?
    ) -> [AgentThreadMessage] {
        var threadMessages = messages.map(makeThreadMessage)
        if let runMessage = makeRunMessage(
            streamEvents: streamEvents,
            capabilityCalls: capabilityCalls,
            approvals: approvals,
            activeRunID: activeRunID
        ) {
            threadMessages.append(runMessage)
        }
        if threadMessages.isEmpty, !pendingAttachments.isEmpty {
            threadMessages.append(AgentThreadMessage(
                id: "pending-attachments",
                role: .user,
                authorName: "你",
                parts: pendingAttachments.map { attachmentPart($0, messageID: "pending") },
                attachments: pendingAttachments,
                contextChips: [],
                linkedArtifacts: pendingAttachments.map {
                    artifactReference(label: $0.fileName, path: $0.artifactPath, generatedAt: $0.createdAt, runID: nil)
                },
                runID: nil,
                createdAt: ""
            ))
        }
        return threadMessages
    }

    static func makeThreadMessage(from message: AgentMessage) -> AgentThreadMessage {
        var parts = message.content.enumerated().map { index, content -> AgentMessagePart in
            let id = "\(message.id)-part-\(index)"
            if content.type.lowercased().contains("error") {
                return .error(id: id, title: "消息处理失败", message: content.text)
            }
            return .text(id: id, text: content.text)
        }

        let attachments = message.attachments ?? []
        parts.append(contentsOf: attachments.map { attachmentPart($0, messageID: message.id) })

        let contextChips = makeContextChips(from: message.contextRefs ?? [])
        parts.append(contentsOf: contextChips.map(AgentMessagePart.evidence))

        let linkedArtifacts = attachments.flatMap { attachment -> [RuntimeObjectReference] in
            [
                artifactReference(label: attachment.fileName, path: attachment.artifactPath, generatedAt: attachment.createdAt, runID: message.runID),
                attachment.analysisPath.map {
                    artifactReference(label: "\(attachment.fileName) 分析记录", path: $0, generatedAt: attachment.createdAt, runID: message.runID)
                }
            ].compactMap { $0 }
        }

        return AgentThreadMessage(
            id: message.id,
            role: role(from: message.role),
            authorName: authorName(for: message.role),
            parts: parts,
            attachments: attachments,
            contextChips: contextChips,
            linkedArtifacts: linkedArtifacts,
            runID: message.runID,
            createdAt: message.createdAt
        )
    }

    static func attachmentPart(_ attachment: AgentAttachment, messageID: String) -> AgentMessagePart {
        .attachment(
            id: "\(messageID)-attachment-\(attachment.attachmentID)",
            title: attachment.fileName,
            summary: "\(attachment.mimeType) · sha256 \(attachment.sha256.prefix(10))",
            attachment: attachment
        )
    }

    static func makeRunMessage(
        streamEvents: [AgentStreamEvent],
        capabilityCalls: [CapabilityCallState],
        approvals: [AgentApprovalState],
        activeRunID: String?
    ) -> AgentThreadMessage? {
        guard !streamEvents.isEmpty || !capabilityCalls.isEmpty || !approvals.isEmpty else {
            return nil
        }

        var parts: [AgentMessagePart] = []
        let runID = activeRunID ?? streamEvents.compactMap(\.runID).last

        for event in streamEvents where event.type.lowercased().contains("planner") {
            parts.append(.planSummary(
                id: "\(event.eventID)-plan",
                title: "计划摘要",
                summary: "Agent 已把任务拆成可执行步骤，技术记录可在详情中查看。",
                evidenceRefs: []
            ))
        }

        parts.append(contentsOf: capabilityCalls.map(AgentMessagePart.capabilityCall))
        parts.append(contentsOf: approvals.map(AgentMessagePart.approvalRequest))

        let assistantText = streamEvents.compactMap { nonEmpty($0.delta) }.joined()
        if !assistantText.isEmpty {
            parts.append(.text(id: "\(runID ?? "agent-run")-assistant-stream", text: assistantText))
        }

        for event in streamEvents where isFailedEvent(event) {
            parts.append(.error(
                id: "\(event.eventID)-error",
                title: "执行失败",
                message: nonEmpty(event.errorPreview) ?? nonEmpty(event.reason) ?? "Agent 执行时遇到错误。"
            ))
        }

        for event in streamEvents where isCompletedEvent(event) {
            parts.append(.finalOutput(
                id: "\(event.eventID)-final",
                title: "已生成结果",
                summary: finalOutputSummary(event),
                artifactPath: event.artifactPath
            ))
        }

        guard !parts.isEmpty else { return nil }

        return AgentThreadMessage(
            id: "\(runID ?? "agent-run")-assistant",
            role: .assistant,
            authorName: "Agent",
            parts: parts,
            attachments: [],
            contextChips: [],
            linkedArtifacts: streamEvents.compactMap { event in
                guard let path = nonEmpty(event.artifactPath) else { return nil }
                return artifactReference(label: artifactLabel(path), path: path, generatedAt: event.timestamp, runID: event.runID ?? runID)
            },
            runID: runID,
            createdAt: streamEvents.first?.timestamp ?? ""
        )
    }

    static func makeCapabilityCall(_ call: AgentToolCallRecord) -> CapabilityCallState {
        let status = capabilityStatus(rawStatus: call.status, permission: call.permission)
        let displayName = toolDisplayName(call.toolName)
        let artifactRefs = [call.artifactPath, call.detailsArtifactPath].compactMap { path -> RuntimeObjectReference? in
            guard let path = nonEmpty(path) else { return nil }
            return artifactReference(label: "\(displayName) 记录", path: path, generatedAt: call.createdAt, runID: runIDFromArtifactPath(path))
        }
        let approval = makeApprovalState(
            id: "approval-\(call.id)",
            action: call.toolName,
            rawStatus: call.permission,
            reason: call.outputSummary,
            artifactRefs: artifactRefs,
            createdAt: call.createdAt,
            runID: artifactRefs.first?.runID
        )

        return CapabilityCallState(
            id: call.id,
            toolName: call.toolName,
            displayName: displayName,
            status: status,
            statusText: statusLabel(status),
            summary: capabilitySummary(displayName: displayName, status: status, outputSummary: call.outputSummary),
            policyDecision: approval,
            inputSummary: humanSummary(call.inputSummary),
            outputSummary: humanSummary(call.outputSummary),
            artifactRefs: artifactRefs,
            rawStatus: call.status,
            rawPermission: call.permission,
            createdAt: call.createdAt
        )
    }

    static func makeCapabilityCall(from event: AgentStreamEvent) -> CapabilityCallState {
        let toolName = nonEmpty(event.toolName) ?? "tool"
        let permission = nonEmpty(event.permission) ?? nonEmpty(event.status) ?? "pass"
        let rawStatus = nonEmpty(event.status) ?? event.type
        let status = capabilityStatus(rawStatus: rawStatus, permission: permission)
        let displayName = toolDisplayName(toolName)
        let artifactRefs = [event.artifactPath].compactMap { path -> RuntimeObjectReference? in
            guard let path = nonEmpty(path) else { return nil }
            return artifactReference(label: "\(displayName) 记录", path: path, generatedAt: event.timestamp, runID: event.runID)
        }
        let approval = makeApprovalState(
            id: "approval-\(event.eventID)",
            action: toolName,
            rawStatus: permission,
            reason: event.reason ?? event.errorPreview ?? event.delta,
            artifactRefs: artifactRefs,
            createdAt: event.timestamp,
            runID: event.runID
        )

        return CapabilityCallState(
            id: event.eventID,
            toolName: toolName,
            displayName: displayName,
            status: status,
            statusText: statusLabel(status),
            summary: capabilitySummary(displayName: displayName, status: status, outputSummary: eventSummary(event)),
            policyDecision: approval,
            inputSummary: humanSummary(event.reason ?? "Agent 正在准备使用这个能力。"),
            outputSummary: humanSummary(event.delta ?? event.errorPreview ?? event.reason ?? ""),
            artifactRefs: artifactRefs,
            rawStatus: rawStatus,
            rawPermission: permission,
            createdAt: event.timestamp
        )
    }

    static func makeRunApprovals(
        toolCalls: [AgentToolCallRecord],
        streamEvents: [AgentStreamEvent]
    ) -> [AgentApprovalState] {
        let callApprovals = toolCalls.compactMap { call -> AgentApprovalState? in
            guard approvalStatus(call.permission) != .allowed else { return nil }
            let artifacts = [call.artifactPath].compactMap { path -> RuntimeObjectReference? in
                guard let path = nonEmpty(path) else { return nil }
                return artifactReference(label: "\(toolDisplayName(call.toolName)) 记录", path: path, generatedAt: call.createdAt, runID: runIDFromArtifactPath(path))
            }
            return makeApprovalState(
                id: "approval-\(call.id)",
                action: call.toolName,
                rawStatus: call.permission,
                reason: call.outputSummary,
                artifactRefs: artifacts,
                createdAt: call.createdAt,
                runID: artifacts.first?.runID
            )
        }

        let eventApprovals = streamEvents.compactMap { event -> AgentApprovalState? in
            guard event.type.lowercased().contains("policy"),
                  let rawStatus = nonEmpty(event.status),
                  approvalStatus(rawStatus) != .allowed else {
                return nil
            }
            return makeApprovalState(
                id: "approval-\(event.eventID)",
                action: nonEmpty(event.toolName) ?? "policy",
                rawStatus: rawStatus,
                reason: event.reason,
                artifactRefs: [event.artifactPath].compactMap { path in
                    guard let path = nonEmpty(path) else { return nil }
                    return artifactReference(label: "安全检查记录", path: path, generatedAt: event.timestamp, runID: event.runID)
                },
                createdAt: event.timestamp,
                runID: event.runID
            )
        }

        return uniqueApprovals(callApprovals + eventApprovals)
    }

    static func makePolicyBoundaryApprovals(_ daemonStatus: AgentDaemonStatus) -> [AgentApprovalState] {
        (daemonStatus.policy ?? [:])
            .sorted { $0.key < $1.key }
            .compactMap { key, value -> AgentApprovalState? in
                guard approvalStatus(value) != .allowed else { return nil }
                return makeApprovalState(
                    id: "policy-\(key)",
                    action: key,
                    rawStatus: value,
                    reason: nil,
                    artifactRefs: [],
                    createdAt: nil,
                    runID: nil
                )
            }
    }

    static func makeApprovalState(
        id: String,
        action: String,
        rawStatus: String,
        reason: String?,
        artifactRefs: [RuntimeObjectReference],
        createdAt: String?,
        runID: String?
    ) -> AgentApprovalState {
        let status = approvalStatus(rawStatus)
        let displayName = toolDisplayName(action)
        return AgentApprovalState(
            id: id,
            action: action,
            displayName: displayName,
            status: status,
            statusText: approvalStatusLabel(status),
            title: approvalTitle(displayName: displayName, status: status),
            reason: approvalReason(action: action, status: status, rawReason: reason),
            dataScopeText: dataScopeText(for: action),
            consequenceText: consequenceText(for: action, status: status),
            artifactRefs: artifactRefs,
            rawStatus: rawStatus,
            createdAt: createdAt,
            runID: runID
        )
    }

    static func capabilityStatus(rawStatus: String, permission: String) -> CapabilityCallState.Status {
        let permissionValue = permission.lowercased()
        let rawValue = rawStatus.lowercased()
        if permissionValue.contains("blocked") || rawValue.contains("blocked") {
            return .blocked
        }
        if permissionValue.contains("needs_confirmation") ||
            permissionValue.contains("confirmation") ||
            rawValue.contains("needs_confirmation") {
            return .waitingForApproval
        }
        if rawValue.contains("fail") || rawValue.contains("error") {
            return .failed
        }
        if rawValue.contains("cancel") {
            return .cancelled
        }
        if rawValue.contains("running") || rawValue.contains("started") {
            return .running
        }
        if rawValue.contains("completed") || rawValue.contains("done") || rawValue.contains("tool.call") {
            return .completed
        }
        return .preparing
    }

    static func approvalStatus(_ rawStatus: String) -> AgentApprovalState.Status {
        let value = rawStatus.lowercased()
        if value.contains("blocked") {
            return .blocked
        }
        if value.contains("needs_confirmation") || value.contains("confirmation") {
            return .needsApproval
        }
        return .allowed
    }

    static func threadStatus(
        sessionStatus: String?,
        runStatus: AgentCompactRunState.Status,
        approvals: [AgentApprovalState],
        hasContent: Bool,
        draftPrompt: String
    ) -> AgentThreadState.Status {
        if approvals.contains(where: { $0.status == .needsApproval }) {
            return .waitingForApproval
        }
        if approvals.contains(where: { $0.status == .blocked }) {
            return .blocked
        }
        if runStatus != .idle {
            return AgentThreadState.Status(rawValue: runStatus.rawValue) ?? .running
        }
        if !draftPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || hasContent {
            return .composing
        }
        let raw = sessionStatus?.lowercased() ?? ""
        if raw.contains("running") { return .running }
        if raw.contains("completed") { return .completed }
        if raw.contains("blocked") { return .blocked }
        if raw.contains("fail") { return .failed }
        return .idle
    }

    static func compactRunStatus(
        sessionStatus: String?,
        taskStatus: String?,
        latestEvent: AgentStreamEvent?,
        runManifest: AgentRunManifest? = nil,
        approvals: [AgentApprovalState],
        hasRun: Bool
    ) -> AgentCompactRunState.Status {
        if approvals.contains(where: { $0.status == .needsApproval }) {
            return .waitingForApproval
        }
        if approvals.contains(where: { $0.status == .blocked }) {
            return .blocked
        }
        if let latestEvent {
            if isFailedEvent(latestEvent) { return .failed }
            if isCompletedEvent(latestEvent) { return .completed }
            let value = "\(latestEvent.type) \(latestEvent.status ?? "")".lowercased()
            if value.contains("cancel") { return .cancelled }
            if value.contains("pause") { return .paused }
            if value.contains("running") || value.contains("started") { return .running }
        }
        if let manifestStatus = runManifest?.status.lowercased() {
            if manifestStatus.contains("cancel") { return .cancelled }
            if manifestStatus.contains("pause") { return .paused }
            if manifestStatus.contains("blocked") { return .blocked }
            if manifestStatus.contains("fail") { return .failed }
            if manifestStatus.contains("completed") || manifestStatus.contains("done") { return .completed }
            if manifestStatus.contains("running") { return .running }
        }
        let raw = (taskStatus ?? sessionStatus ?? "").lowercased()
        if raw.contains("blocked") { return .blocked }
        if raw.contains("fail") { return .failed }
        if raw.contains("completed") || raw.contains("done") { return .completed }
        if raw.contains("cancel") { return .cancelled }
        if raw.contains("pause") { return .paused }
        if raw.contains("running") || hasRun { return .running }
        return .idle
    }

    static func compactRunStatusLabel(_ status: AgentCompactRunState.Status, daemonStatus: AgentDaemonStatus) -> String {
        switch status {
        case .idle:
            return daemonStatus.status.lowercased().contains("unavailable") ? "后台服务未连接" : "未开始"
        case .running:
            return "运行中"
        case .waitingForApproval:
            return "等待确认"
        case .completed:
            return "已完成"
        case .failed:
            return "失败"
        case .blocked:
            return "已阻断"
        case .paused:
            return "已暂停"
        case .cancelled:
            return "已取消"
        }
    }

    static func selection(eventID: String?, messageID: String?, toolCallID: String?) -> AgentInspectorSelection? {
        if let toolCallID { return .toolCall(toolCallID) }
        if let messageID { return .message(messageID) }
        if let eventID { return .event(eventID) }
        return nil
    }

    static func resolveRunID(
        session: AgentSession?,
        streamEvents: [AgentStreamEvent],
        longTasks: [AgentLongTask]
    ) -> String? {
        nonEmpty(session?.activeRunID)
            ?? streamEvents.compactMap { nonEmpty($0.runID) }.last
            ?? longTasks.first(where: { $0.sessionID == session?.sessionID })?.runID
            ?? longTasks.first?.runID
    }

    static func resolveTask(
        session: AgentSession?,
        runID: String?,
        longTasks: [AgentLongTask]
    ) -> AgentLongTask? {
        if let runID, let task = longTasks.first(where: { $0.runID == runID }) {
            return task
        }
        if let sessionID = session?.sessionID, let task = longTasks.first(where: { $0.sessionID == sessionID }) {
            return task
        }
        return longTasks.first
    }

    static func role(from rawRole: String) -> AgentThreadMessage.Role {
        switch rawRole.lowercased() {
        case "user":
            return .user
        case "assistant":
            return .assistant
        case "system":
            return .system
        case "tool":
            return .tool
        default:
            return .unknown
        }
    }

    static func authorName(for role: String) -> String {
        switch role.lowercased() {
        case "user":
            return "你"
        case "assistant":
            return "Agent"
        case "system":
            return "系统"
        case "tool":
            return "能力"
        default:
            return role
        }
    }

    static func eventName(_ raw: String) -> String {
        switch raw.lowercased() {
        case "run.started":
            return "开始执行"
        case "planner.envelope.created":
            return "生成执行计划"
        case "policy.decision":
            return "安全检查"
        case "tool.call":
            return "调用能力"
        case "assistant.delta":
            return "生成回复"
        case "run.completed":
            return "任务完成"
        case "run.failed":
            return "任务失败"
        default:
            return raw.replacingOccurrences(of: "_", with: " ").replacingOccurrences(of: ".", with: " ")
        }
    }

    static func eventSummary(_ event: AgentStreamEvent) -> String {
        if let delta = nonEmpty(event.delta) {
            return delta
        }
        if let reason = nonEmpty(event.reason) {
            return humanSummary(reason)
        }
        if let error = nonEmpty(event.errorPreview) {
            return error
        }
        if let status = nonEmpty(event.status) {
            return statusLabel(status)
        }
        if let artifactPath = nonEmpty(event.artifactPath) {
            return "已写入本机记录：\(artifactPath)"
        }
        return eventName(event.type)
    }

    static func stageDisplayName(
        manifest: AgentRunManifest?,
        controlSummary: AgentControlPlaneSummary?,
        activeCall: CapabilityCallState?,
        status: AgentCompactRunState.Status
    ) -> String? {
        if status == .waitingForApproval, let activeCall {
            return "等待确认：\(activeCall.displayName)"
        }
        if let stage = nonEmpty(manifest?.currentStage) ?? nonEmpty(controlSummary?.stage) {
            return stageLabel(stage)
        }
        return activeCall?.displayName
    }

    static func runSummaryText(
        manifest: AgentRunManifest?,
        controlSummary: AgentControlPlaneSummary?,
        contextSummary: AgentContextPlaneSummary?,
        latestEvent: AgentStreamEvent?
    ) -> String {
        if let contextSummary {
            let sourceText = "上下文 \(contextSummary.sourceCount) 项 / \(contextSummary.chunkCount) 段"
            let riskText = (controlSummary?.blockedPolicyCount ?? 0) > 0 ? "有阻断项" : "边界正常"
            return "\(sourceText) · \(riskText) · \(RuntimeStatusPresenter.label(contextSummary.status))"
        }
        if let manifest {
            return "\(stageLabel(manifest.currentStage)) · \(RuntimeStatusPresenter.label(manifest.status))"
        }
        return latestEvent.map(eventSummary) ?? "等待你提交任务"
    }

    static func stageLabel(_ raw: String) -> String {
        switch raw {
        case "start":
            return "开始"
        case "intent":
            return "理解任务"
        case "profile":
            return "选择执行方式"
        case "context":
            return "整理上下文"
        case "planner":
            return "规划步骤"
        case "policy":
            return "安全边界"
        case "approval":
            return "等待确认"
        case "model_route":
            return "选择模型"
        case "tool_execution":
            return "调用能力"
        case "model_stream":
            return "生成回复"
        case "qa":
            return "质量检查"
        case "metrics":
            return "记录指标"
        case "checkpoint":
            return "保存进度"
        case "final_output":
            return "输出结果"
        case "prepared":
            return "已准备"
        case "completed":
            return "已完成"
        default:
            return raw.replacingOccurrences(of: "_", with: " ")
        }
    }

    static func capabilitySummary(displayName: String, status: CapabilityCallState.Status, outputSummary: String) -> String {
        switch status {
        case .waitingForApproval:
            return "\(displayName) 需要你确认后才会执行。"
        case .blocked:
            return "\(displayName) 已被安全策略阻断。"
        case .completed:
            let summary = humanSummary(outputSummary)
            return summary.isEmpty ? "\(displayName) 已完成。" : summary
        case .failed:
            return "\(displayName) 执行失败，请查看详情。"
        case .running:
            return "\(displayName) 正在运行。"
        case .preparing:
            return "\(displayName) 正在准备。"
        case .cancelled:
            return "\(displayName) 已取消。"
        }
    }

    static func approvalTitle(displayName: String, status: AgentApprovalState.Status) -> String {
        switch status {
        case .allowed:
            return "\(displayName) 可本地使用"
        case .needsApproval:
            return "需要确认：\(displayName)"
        case .blocked:
            return "已阻断：\(displayName)"
        }
    }

    static func approvalReason(action: String, status: AgentApprovalState.Status, rawReason: String?) -> String {
        if let rawReason = nonEmpty(rawReason) {
            return humanSummary(rawReason)
        }
        switch status {
        case .allowed:
            return "这一步只使用本机项目记录，不会操作真实微信或外部账户。"
        case .needsApproval:
            return "\(toolDisplayName(action)) 涉及敏感能力，Agent 会等你确认后再继续。"
        case .blocked:
            return "\(toolDisplayName(action)) 当前被安全策略阻断，Agent 不能执行这一步。"
        }
    }

    static func dataScopeText(for action: String) -> String {
        switch action {
        case "wechat.read_normalized_messages":
            return "读取本机 normalized 微信消息文件。"
        case "liveWechat":
            return "会触达真实微信账号或窗口。"
        case "liveWechatCLI":
            return "会调用微信 CLI 或用户导出的微信数据。"
        case "computer_use.request", "computerUse":
            return "可能读取屏幕或操作本机应用；当前版本只记录申请。"
        case "trade":
            return "涉及交易、转账或资产操作。"
        case "sendMessage":
            return "会向外部联系人发送消息。"
        case "publishExternal":
            return "会把内容发布到项目外部。"
        case "image.analyze_with_kimi":
            return "会使用你添加的图片附件和对应 hash 记录。"
        default:
            return "使用当前任务上下文和本机运行记录。"
        }
    }

    static func consequenceText(for action: String, status: AgentApprovalState.Status) -> String {
        switch status {
        case .allowed:
            return "无需额外确认，结果会写入本机记录。"
        case .needsApproval:
            return action == "image.analyze_with_kimi"
                ? "如需外部图片模型，应先确认附件边界。"
                : "拒绝后 Agent 会跳过这项能力，继续使用可本地处理的上下文。"
        case .blocked:
            return "这一步不会执行；可以改用本地记录或去掉该能力后重试。"
        }
    }

    static func humanSummary(_ raw: String) -> String {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return "" }
        if value.contains("Generated from selected skill/extension") || value.contains("Generated from agent workspace prompt and selected tools") {
            return "来自你在 Agent 工作台提交的任务和已选 Skill/Extension。"
        }
        if value.contains("Local artifact boundary accepted") {
            return "已在本机项目记录中完成，不会操作真实微信。"
        }
        if value.contains("No execution performed") && value.contains("needs_confirmation") {
            return "尚未执行，等待你确认后才会继续。"
        }
        if value.contains("Sensitive action is not executed") {
            return "这是敏感操作，当前版本不会直接执行，需要先由你确认。"
        }
        if value.contains("Local or user-preferred artifact action") {
            return "只读取或写入本机项目记录，不会操作真实微信。"
        }
        return value
    }

    static func finalOutputSummary(_ event: AgentStreamEvent) -> String {
        if let artifactPath = nonEmpty(event.artifactPath) {
            return "结果已保存到本机记录：\(artifactPath)"
        }
        return "Agent 已完成这次任务。"
    }

    static func contextSubtitle(_ reference: RuntimeObjectReference) -> String {
        var values = [kindLabel(reference.kind), freshnessLabel(reference.freshness)]
        if let path = nonEmpty(reference.path) {
            values.append(path)
        }
        return values.joined(separator: " · ")
    }

    static func sourceLabel(_ raw: String) -> String {
        switch raw {
        case "swift_agent_console_selection":
            return "来自当前选择"
        case "runtime_backend", "runtime_artifact_writer":
            return "来自本机运行记录"
        case "wechat_fixture":
            return "来自本机微信样例数据"
        default:
            return raw
        }
    }

    static func freshnessLabel(_ freshness: ProactiveFreshness) -> String {
        switch freshness {
        case .fresh:
            return "新鲜"
        case .fixture:
            return "样例数据"
        case .currentRun:
            return "本次运行"
        case .stale:
            return "可能过期"
        case .degraded:
            return "降级"
        case .blocked:
            return "已阻断"
        case .notRun:
            return "未运行"
        case .unknown:
            return "未知"
        }
    }

    static func privacyLabel(_ privacyLevel: String?, redactionStatus: String?) -> String {
        let privacy = nonEmpty(privacyLevel) ?? "local"
        if let redaction = nonEmpty(redactionStatus) {
            return "\(privacy) · \(redaction.replacingOccurrences(of: "_", with: " "))"
        }
        return privacy
    }

    static func daemonSummary(_ daemonStatus: AgentDaemonStatus) -> String {
        if let daemon = daemonStatus.daemon {
            return "后台服务已连接 · 127.0.0.1:\(daemon.port)"
        }
        return daemonStatus.status == "unavailable" ? "后台服务未连接" : "后台服务 \(statusLabel(daemonStatus.status))"
    }

    static func providerSummary(_ daemonStatus: AgentDaemonStatus) -> String {
        if daemonStatus.providers.isEmpty {
            return "AI 模型未检查"
        }
        let ready = daemonStatus.providers.filter(\.ready).map { $0.model ?? $0.provider }
        if !ready.isEmpty {
            return "AI 模型可用：\(ready.joined(separator: " / "))"
        }
        let missing = daemonStatus.providers.flatMap(\.missingEnv).joined(separator: ", ")
        return missing.isEmpty ? "AI 模型未配置" : "AI 模型缺少 \(missing)"
    }

    static func runDisplay(_ runID: String?) -> String {
        guard let runID, !runID.isEmpty else {
            return "未开始"
        }
        let cleaned = runID.replacingOccurrences(of: "run-", with: "")
        return "执行记录 \(cleaned.prefix(8))"
    }

    static func artifactReference(label: String, path: String, generatedAt: String?, runID: String?) -> RuntimeObjectReference {
        RuntimeObjectReference(
            id: path,
            kind: .artifact,
            label: label,
            path: path,
            value: nil,
            source: "agent_workspace_v2_adapter",
            freshness: .currentRun,
            confidence: nil,
            privacyLevel: "local",
            redactionStatus: "metadata_only",
            generatedAt: generatedAt,
            runID: runID
        )
    }

    static func artifactLabel(_ path: String) -> String {
        let last = path.split(separator: "/").last.map(String.init) ?? path
        switch last {
        case "planner-envelope.json":
            return "执行计划"
        case "tool-calls.json":
            return "能力调用记录"
        case "policy-decisions.json":
            return "安全检查记录"
        case "final-output.md":
            return "最终输出"
        default:
            return last
        }
    }

    static func runIDFromArtifactPath(_ path: String) -> String? {
        let parts = path.split(separator: "/").map(String.init)
        guard let runsIndex = parts.firstIndex(of: "runs"), parts.indices.contains(runsIndex + 1) else {
            return nil
        }
        return parts[runsIndex + 1]
    }

    static func isFailedEvent(_ event: AgentStreamEvent) -> Bool {
        let value = "\(event.type) \(event.status ?? "")".lowercased()
        return value.contains("failed") || value.contains("error") || event.errorPreview != nil
    }

    static func isCompletedEvent(_ event: AgentStreamEvent) -> Bool {
        let value = "\(event.type) \(event.status ?? "")".lowercased()
        return value.contains("completed")
    }

    static func nonEmpty(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    static func uniqueContextChips(_ chips: [AgentContextChip]) -> [AgentContextChip] {
        var seen = Set<String>()
        return chips.filter { seen.insert($0.id).inserted }
    }

    static func uniqueApprovals(_ approvals: [AgentApprovalState]) -> [AgentApprovalState] {
        var seen = Set<String>()
        return approvals.filter { seen.insert($0.id).inserted }
    }
}
