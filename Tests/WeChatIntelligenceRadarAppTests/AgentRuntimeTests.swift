import Foundation
@testable import WeChatIntelligenceRadarApp

let agentRuntimeChecks: Void = {
    checkWeb3SignalServiceDetectsCoreTickers()
    checkPolicyGateAllowsReadOnlyRefreshAndBlocksOutboundActions()
    try! checkFixtureFileAdapterLoadsSampleJSONAndContracts()
    try! checkCMCProviderUsesFreshStoreSnapshot()
    try! checkCMCProviderMarksExpiredStoreSnapshotStale()
    try! checkCMCProviderDoesNotPromoteFixtureSnapshotToLive()
    try! checkAgentDaemonAuthTokenLoadsFromRuntime()
    try! checkRuntimeResolverFindsProjectRootFromBundledAppPath()
    checkTimeWindowFilteringChangesSnapshotSizeAndArtifactsWrite()
    checkDefaultMonthWindowGeneratesThreeCrystals()
    try! checkTerminalDataStoresCloseTheTokenLoop()
    checkRuntimeBackendProactiveCommands()
    checkAgentWorkspaceV2AdapterBuildsThreadAndApprovalCards()
    checkAgentWorkspaceV2HidesPlannerAndNonInterruptingTools()
    checkCompletedRunUsesAuthoritativeFinalReadModel()
    checkTerminalRunWithoutFinalReadModelSuppressesStreamBlob()
    checkCompletedRunIgnoresTerminalFinalTextWithoutFinalReadModel()
    checkWorkbenchLayoutMetricsBreakpoints()
    checkCMCGateSummaryDecodesNestedAndFlatFields()
    checkAgentModelPreferencePayloads()
    checkCMCCapabilitySummaryDecodesRenderContract()
    try! checkCloudASRSummaryDecodesAndStoreReads()
    try! checkHarnessReadModelsDecodeAndStoreReads()
    checkAgentRunManifestAndV2EventDecode()
    checkAgentWorkspaceAdapterUsesControlContextSummaries()
    checkAgentOutputMarkdownAndSignals()
    checkMarkdownParserDegradesToPlainText()
    checkDenseAgentOutputUsesSharedRenderStructure()
    checkAlphaCandidateOutputSplitsIntoReadableBlocks()
    checkCompactHyphenBulletsParse()
    checkAgentAssistantTextIsRunScoped()
    checkProviderSummarySeparatesAgentDataSources()
    try! checkAgentStreamStoreDetectsToolObservations()
    print("agent_runtime_contracts=pass")
}()

private func require(_ condition: @autoclosure () -> Bool, _ message: String) {
    precondition(condition(), message)
}

private func checkCloudASRSummaryDecodesAndStoreReads() throws {
    let root = temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let runID = "run-cloud-asr-test"
    let runDir = root
        .appendingPathComponent("runtime", isDirectory: true)
        .appendingPathComponent("agent", isDirectory: true)
        .appendingPathComponent("runs", isDirectory: true)
        .appendingPathComponent(runID, isDirectory: true)
    try FileManager.default.createDirectory(at: runDir, withIntermediateDirectories: true)
    let payload = """
    {
      "schemaVersion": "cloud-asr-summary-v1",
      "runID": "\(runID)",
      "sessionID": "session-cloud-asr-test",
      "status": "completed",
      "cloudASRStatus": "completed",
      "provider": "阿里云百炼",
      "providerID": "aliyun-bailian-dashscope",
      "model": "fun-asr",
      "uploadProvider": "aliyun-oss",
      "cloudUpload": true,
      "userVisibleLabel": "云端转写 · 阿里云百炼 · OSS 临时上传",
      "reason": null,
      "speakerDiarizationStatus": "provider_supported",
      "needsTranscriptReview": false,
      "transcriptPath": "runtime/agent/runs/\(runID)/cloud-asr-transcript.json",
      "sourcePackPath": "runtime/agent/runs/\(runID)/meeting-source-pack.json",
      "segmentCount": 2,
      "boundedChunkCount": 2,
      "sourceAttachmentIDs": ["attachment-audio"],
      "rawAudioStored": false,
      "rawProviderRequestIncluded": false,
      "rawProviderResponseIncluded": false,
      "secretsIncluded": false,
      "generatedAt": "2026-06-12T00:00:00.000Z",
      "artifactPath": "runtime/agent/runs/\(runID)/cloud-asr-summary.json"
    }
    """.data(using: .utf8)!
    try payload.write(to: runDir.appendingPathComponent("cloud-asr-summary.json"))

    let resolver = AgentRuntimePathResolver(pathResolver: RuntimePathResolver(root: root))
    let store = AgentRunReadModelStore(streamStore: AgentStreamStore(resolver: resolver))
    let summary = store.readCloudASRSummary(runID: runID)
    require(summary?.cloudASRStatus == "completed", "Cloud ASR summary should decode completed status")
    require(summary?.cloudUpload == true, "Cloud ASR summary should preserve cloud upload marker")
    require(summary?.rawAudioStored == false, "Cloud ASR summary must not mark raw audio as stored")
    require(summary?.displayStatus.contains("云端转写") == true, "Cloud ASR display status should be user-readable")
}

private func checkWorkbenchLayoutMetricsBreakpoints() {
    let compact900 = WorkbenchLayoutMetrics(contentWidth: 900)
    let compact1024 = WorkbenchLayoutMetrics(contentWidth: 1024)
    let regular1280 = WorkbenchLayoutMetrics(contentWidth: 1280)
    let regular1440 = WorkbenchLayoutMetrics(contentWidth: 1440)
    let wide1700 = WorkbenchLayoutMetrics(contentWidth: 1700)
    let wide2200 = WorkbenchLayoutMetrics(contentWidth: 2200)

    require(compact900.breakpoint == .compact, "900pt should use compact layout")
    require(compact1024.breakpoint == .compact, "1024pt should use compact layout")
    require(regular1280.breakpoint == .regular, "1280pt should use regular layout")
    require(regular1440.breakpoint == .regular, "1440pt should use regular layout")
    require(wide1700.breakpoint == .wide, "1700pt should use wide layout")
    require(wide2200.breakpoint == .wide, "2200pt should use wide layout")
    require(compact1024.queueColumnWidth == compact1024.contentWidth, "compact queue should span available width")
    require(regular1280.queueColumnWidth == 320, "regular queue should use stable minimum width")
    require(wide1700.queueColumnWidth > 360 && wide1700.queueColumnWidth <= 460, "wide queue should expand but remain clamped")
    require(wide2200.supportColumnWidth == 460, "ultra-wide support column should clamp")
}

private func checkRuntimeResolverFindsProjectRootFromBundledAppPath() throws {
    let fileManager = FileManager.default
    let temp = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
        .appendingPathComponent("looloomi-resolver-\(UUID().uuidString)", isDirectory: true)
    let projectRoot = temp.appendingPathComponent("project", isDirectory: true)
    let appBundle = projectRoot
        .appendingPathComponent(".build/release-app/WeChatIntelligenceRadar.app", isDirectory: true)
    try fileManager.createDirectory(at: appBundle, withIntermediateDirectories: true)
    try "// test package\n".write(
        to: projectRoot.appendingPathComponent("Package.swift"),
        atomically: true,
        encoding: .utf8
    )
    defer { try? fileManager.removeItem(at: temp) }

    let found = RuntimePathResolver.projectRootCandidate(startingAt: appBundle, fileManager: fileManager)
    require(found?.standardizedFileURL.path == projectRoot.standardizedFileURL.path,
            "resolver should find project root from .build app bundle ancestors")
}

private func checkProviderSummarySeparatesAgentDataSources() {
    let cmcMissing = AgentDaemonStatus.ProviderStatus(
        provider: "coinmarketcap",
        role: "market_data",
        ready: false,
        missingEnv: ["CMC_MCP_API_KEY"],
        apiKeyEnv: "CMC_MCP_API_KEY",
        baseUrlConfigured: true,
        model: nil,
        state: "degraded",
        connectionState: "missing_key",
        configured: false,
        connected: false,
        degraded: true,
        providerType: "normalizedFileProvider",
        rawSecretsReturned: false,
        requestBodyReturned: false
    )
    let deepseekReady = AgentDaemonStatus.ProviderStatus(
        provider: "deepseek",
        role: "text_planner_tool_calling",
        ready: true,
        missingEnv: [],
        apiKeyEnv: "DEEPSEEK_API_KEY",
        baseUrlConfigured: true,
        model: "deepseek-v4-pro",
        state: "configured",
        connectionState: "configured",
        configured: true,
        connected: nil,
        degraded: false,
        providerType: nil,
        rawSecretsReturned: false,
        requestBodyReturned: false
    )
    let degradedStatus = AgentDaemonStatus(
        schemaVersion: "agent-runtime-host-health-v1",
        status: "available",
        daemon: nil,
        providers: [cmcMissing],
        capabilities: [],
        skills: [],
        extensions: [],
        templates: [],
        tools: [],
        internalToolsExposed: false,
        policy: nil
    )
    let mixedStatus = AgentDaemonStatus(
        schemaVersion: "agent-runtime-host-health-v1",
        status: "available",
        daemon: nil,
        providers: [deepseekReady, cmcMissing],
        capabilities: [],
        skills: [],
        extensions: [],
        templates: [],
        tools: [],
        internalToolsExposed: false,
        policy: nil
    )
    let degradedSummary = AgentWorkspaceStateAdapter.providerSummary(degradedStatus)
    require(degradedSummary.contains("Agent 能力源缺少 CMC_MCP_API_KEY"), "CMC missing key should be visible as an Agent data-source gap")
    let mixedSummary = AgentWorkspaceStateAdapter.providerSummary(mixedStatus)
    require(mixedSummary.contains("Agent 能力源可用：deepseek-v4-pro"), "ready model should still be shown")
    require(!mixedSummary.contains("AI 模型可用"), "summary should not label every provider as only AI model availability")
}

/// Phase C: the compact agent markdown must parse into structured blocks (not one blob) and the
/// best-effort signal extractor must surface assets / changes / freshness from the prose.
private func checkAgentOutputMarkdownAndSignals() {
    let sample = "**今日市场热门币种与信息简报**（基于本地运行时工时）---"
        + "###一、资产热度概览####1.BTC—比特币-**实体状态**：symbol:BTC freshness:fresh，置信度0.78。"
        + "####2.ETH—以太坊：ETH 紧随 BTC，置信度0.57。"
        + "####4.热门主题币-**PEPE**：市场快照 24h 上涨17%，置信度0.69。BTC 日内下降1.3%。"

    let blocks = MarkdownParser.parse(sample)
    var headingCount = 0
    for block in blocks { if case .heading = block { headingCount += 1 } }
    require(headingCount >= 2, "compact markdown should split into multiple headings, got \(headingCount)")
    require(blocks.count >= 3, "markdown should yield several blocks, got \(blocks.count)")

    // Markdown tables must parse (and the separator row must be dropped, not mistaken for HRs).
    let tableSrc = "标题\n| Source | Confidence |\n| --- | --- |\n| fused | 0.57 |\n尾注。"
    let tableBlocks = MarkdownParser.parse(tableSrc)
    var foundTable = false
    for block in tableBlocks {
        if case .table(let header, let rows) = block {
            foundTable = true
            require(header == ["Source", "Confidence"], "table header parsed")
            require(rows.count == 1 && rows[0] == ["fused", "0.57"], "one data row, separator dropped")
        }
    }
    require(foundTable, "a markdown table should be recognized")

    let digest = AgentSignalExtractor.extract(from: sample)
    require(!digest.assets.isEmpty, "should extract at least one asset confidence signal")
    require(digest.assets.allSatisfy { $0.confidence >= 0 && $0.confidence <= 1 }, "confidence in 0...1")
    require(digest.assets.contains { $0.symbol == "BTC" }, "BTC should be among extracted assets")
    require(digest.changes.contains { $0.percent > 0 } && digest.changes.contains { $0.percent < 0 },
            "should extract both an up and a down change")
    require(digest.freshness.contains(.fresh), "freshness:fresh should be detected")

    let rawToolText = """
    我会直接读取数据。
    <looloomi-tool-calls><callname="market.read_snapshot" parameters="{\\"symbol\\":\\"BTC\\"}"/></looloomi-tool-calls>
    runtime/agent/runs/run-test/tool-calls.json
    """
    let cleaned = AgentOutputCopy.humanize(rawToolText)
    require(!cleaned.contains("looloomi-tool-calls"), "raw tool markup must be hidden")
    require(!cleaned.contains("runtime/agent"), "runtime paths must be hidden")
    require(!cleaned.contains("parameters="), "raw tool parameters must be hidden")
    require(cleaned.contains("后台调用参数已隐藏"), "empty raw-only output should show readable placeholder")

    let rawFunctionCallText = """
    <function_calls><invoke invokename="cmc.live_market_refresh"><parametername="symbol">SOL</parameter></invoke></function_calls>
    """
    let cleanedFunctionCall = AgentOutputCopy.humanize(rawFunctionCallText)
    require(!cleanedFunctionCall.contains("function_calls"), "raw function-call markup must be hidden")
    require(!cleanedFunctionCall.contains("invokename"), "raw function names must be hidden")
    require(!cleanedFunctionCall.contains("parametername"), "raw function parameters must be hidden")
    require(cleanedFunctionCall.contains("后台调用参数已隐藏"), "raw function-only output should show readable placeholder")

    let safeInternalTerms = "CMC source mcpProvider returned cmc-skill-hub status."
    let readableTerms = AgentOutputCopy.humanize(safeInternalTerms)
    require(readableTerms.contains("CoinMarketCap MCP"), "provider IDs in safe lines should be humanized")
    require(readableTerms.contains("CMC Skill Hub 能力包"), "capability IDs in safe lines should be humanized")
    require(!readableTerms.contains("mcpProvider") && !readableTerms.contains("cmc-skill-hub"), "raw safe IDs should not remain")

    let rawSkillLine = "Skill: cmc-skill-hub, cmc-market-radar"
    let hiddenSkillLine = AgentOutputCopy.humanize(rawSkillLine)
    require(hiddenSkillLine.contains("后台调用参数已隐藏"), "raw Skill ID list should still be hidden")
}

/// Degradation guarantee: plain prose with no markup must still render as one paragraph and an
/// empty digest — never crash, never drop text.
private func checkMarkdownParserDegradesToPlainText() {
    let plain = "这是一段没有任何标记的普通说明文字，应当原样作为段落呈现。"
    let blocks = MarkdownParser.parse(plain)
    require(blocks.count == 1, "plain text should be a single paragraph block")
    if case .paragraph(let text) = blocks[0] {
        require(text == plain, "paragraph text must be preserved verbatim")
    } else {
        require(false, "plain text should classify as paragraph")
    }
    require(AgentSignalExtractor.extract(from: plain).isEmpty, "no signals in plain prose")
}

private func checkDenseAgentOutputUsesSharedRenderStructure() {
    let dense = "结论 空头逻辑依然成立，但空头优势正在衰减。关键证据 ETF 流：近 3 个交易日持续流出。跨资产相关性：风险资产倾斜但未确认。行动建议 1.保留现有观察，不追空。2.监控 ETF 流出和资金费率。风险边界/数据缺口 CMC 数据可能延迟，需等待 fresh refresh。"
    let normalized = AgentOutputCopy.humanize(dense)
    let blocks = MarkdownParser.parse(normalized)
    var headingCount = 0
    var orderedCount = 0
    for block in blocks {
        if case .heading = block { headingCount += 1 }
        if case .ordered = block { orderedCount += 1 }
    }
    require(headingCount >= 3, "dense output should split into section headings, got \(headingCount): \(normalized)")
    require(orderedCount >= 2, "compact numbered actions should parse as ordered items")

    let liveSegments = AgentOutputCopy.streamingSegments(dense)
    require(liveSegments.contains { segment in
        if case .heading = segment.kind { return true }
        return false
    }, "live renderer should use the same heading structure")
    require(liveSegments.contains { segment in
        if case .ordered = segment.kind { return true }
        return false
    }, "live renderer should use the same ordered structure")
}

private func checkAlphaCandidateOutputSplitsIntoReadableBlocks() {
    let alpha = """
    #
    市场雷达 Alpha研究候选数据新鲜度：CMC 实时节点已刷新，市场体制、社交分歧、形态分类均已校验。盘面定性：BTC 主导高位震荡，山寨轮动加速，精选 3 个候选供进一步追踪。候选 1: SOL (Solana) 核心逻辑: 社交量单日 +140%，但价格滞后仅 +2.3%。关键价位: 阻力观察：172-175 支撑观察：158-160。反证：社交热度可能由 Meme/空投活动驱动，无基本面升级。后续观察条件：社交量持续高于均值 3 日，且不伴随价格集中派发。候选 2: LINK (Chainlink) 核心逻辑: K 线形态分类为“双底突破颈线”。关键价位：强弱突破区 13.8-14.1。反证：消息扩散但未充分定价。风险边界/数据缺口：本分析仅基于 CMC 实时数据，社交价格分歧模型与链上快照。
    """
    let normalized = AgentOutputCopy.humanize(alpha)
    require(!normalized.contains("#\n"), "orphan markdown hash must be removed")
    require(normalized.contains("### 候选 1:"), "candidate 1 should become a heading: \(normalized)")
    require(normalized.contains("### 候选 2:"), "candidate 2 should become a heading")
    require(normalized.contains("- **核心逻辑**："), "core logic should become a bullet")
    require(normalized.contains("- **关键价位**："), "key level should become a bullet")
    require(normalized.contains("- **反证**："), "counter-evidence should become a bullet")
    require(normalized.contains("## 风险边界/数据缺口"), "risk/data gap should become a section")

    let blocks = MarkdownParser.parse(alpha)
    var headingCount = 0
    var bulletCount = 0
    for block in blocks {
        if case .heading = block { headingCount += 1 }
        if case .bullet = block { bulletCount += 1 }
    }
    require(headingCount >= 4, "alpha candidate output should split into headings, got \(headingCount): \(normalized)")
    require(bulletCount >= 6, "alpha candidate output should split into bullets, got \(bulletCount): \(normalized)")

    let liveSegments = AgentOutputCopy.streamingSegments(alpha)
    require(liveSegments.contains { segment in
        if case .heading = segment.kind { return segment.text.contains("候选 1") }
        return false
    }, "live renderer should show candidate heading immediately")
    require(liveSegments.contains { segment in
        if case .bullet = segment.kind { return segment.text.contains("核心逻辑") }
        return false
    }, "live renderer should show field bullets immediately")
}

private func checkCompactHyphenBulletsParse() {
    let text = "cmc.live_market_refresh 完成后，我抓取了以下证据：\n-市场概览：BTC ETF 净流量。\n-宏观关联：BTC 与 DXY。"
    let blocks = MarkdownParser.parse(text)
    let bulletCount = blocks.filter {
        if case .bullet = $0 { return true }
        return false
    }.count
    require(bulletCount == 2, "compact hyphen bullets should parse, got \(bulletCount)")
}

private func checkAgentAssistantTextIsRunScoped() {
    let events = [
        makeDeltaEvent(id: "evt-btc", runID: "run-btc", delta: "BTC 旧结论"),
        makeDeltaEvent(id: "evt-sol", runID: "run-sol", delta: "SOL 新结论")
    ]
    require(DashboardViewModel.assistantText(from: events, runID: "run-sol") == "SOL 新结论",
            "live assistant text must be scoped to the requested run")
    require(DashboardViewModel.assistantText(from: events, runID: "run-new").isEmpty,
            "new run with no deltas must not fall back to previous assistant text")
    require(DashboardViewModel.assistantText(from: events, runID: nil).isEmpty,
            "nil run must not surface stale assistant text")
}

private func makeDeltaEvent(id: String, runID: String, delta: String) -> AgentStreamEvent {
    AgentStreamEvent(
        eventID: id,
        timestamp: "2026-06-04T00:00:00.000Z",
        type: "assistant.delta",
        runID: runID,
        taskID: "task-\(runID)",
        sessionID: "session-test",
        stage: "model_stream",
        action: nil,
        actionIntent: nil,
        riskLevel: nil,
        artifactKind: nil,
        contextSourceCount: nil,
        contextChunkCount: nil,
        delta: delta,
        toolName: nil,
        status: nil,
        permission: nil,
        reason: nil,
        provider: nil,
        model: nil,
        artifactPath: nil,
        errorPreview: nil
    )
}

private func checkAgentStreamStoreDetectsToolObservations() throws {
    let root = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
        .appendingPathComponent("looloomi-agent-store-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }

    let resolver = AgentRuntimePathResolver(pathResolver: RuntimePathResolver(root: root))
    let store = AgentStreamStore(resolver: resolver)
    let runDir = resolver.runsDirectory.appendingPathComponent("run-history", isDirectory: true)
    try FileManager.default.createDirectory(at: runDir, withIntermediateDirectories: true)

    require(!store.hasToolObservations(runID: "run-history"), "history run starts without observations")
    try "{}\n".write(to: runDir.appendingPathComponent("tool-observations.json"), atomically: true, encoding: .utf8)
    require(store.hasToolObservations(runID: "run-history"), "tool observations should be detected")
    require(!store.hasToolObservations(runID: nil), "nil run has no observations")
}

private func checkWeb3SignalServiceDetectsCoreTickers() {
    let batch = try! MockWeChatDataAdapter().loadBatch(selectedGroupID: nil, date: testDate("2026-05-24T00:00:00Z"))
    let symbols = Web3SignalService().detectedSymbols(in: batch.messages)

    require(symbols == ["BTC", "ETH", "SOL"], "Expected BTC/ETH/SOL detection")
}

private func checkPolicyGateAllowsReadOnlyRefreshAndBlocksOutboundActions() {
    let gate = PolicyGate()

    require(gate.check(.runLiveWeChatCLI).status == "blocked", "run_live_wechat_cli must be blocked")
    require(gate.check(.readLiveWeChat).status == "pass", "read_live_wechat read-only refresh should pass")
    require(gate.check(.readWeChatCLIExportFile).status == "pass", "export file import should pass within local boundary")
    require(gate.check(.requestMarketBridgeRefresh).status == "pass", "CMC bridge refresh should pass")
    require(gate.check(.readFixtureFile).status == "pass", "fixture file read must pass")
    require(gate.check(.sendMessage).status == "blocked", "send_message must remain blocked")
    require(gate.check(.executeTrade).status == "blocked", "execute_trade must remain blocked")
}

private func checkAgentWorkspaceV2AdapterBuildsThreadAndApprovalCards() {
    let tokenRef = RuntimeObjectReference(
        id: "bitcoin:btc",
        kind: .token,
        label: "BTC",
        path: "runtime/entities/token-entities.json",
        value: "bitcoin:btc",
        source: "test",
        freshness: .fresh,
        confidence: 0.9,
        privacyLevel: "local",
        redactionStatus: "pointer_only",
        generatedAt: nil,
        runID: "run-test"
    )
    let blockedCall = AgentToolCallRecord(
        id: "tool-call-1",
        toolName: "computer_use.request",
        status: "needs_confirmation",
        permission: "needs_confirmation",
        inputSummary: "request computer use proposal",
        outputSummary: "requires user confirmation",
        artifactPath: "runtime/agent/runs/run-test/tool-calls.json",
        detailsArtifactPath: "runtime/agent/runs/run-test/tool-details/tool-call-1.json",
        redactionStatus: "redacted_summary_only",
        createdAt: "2026-05-27T00:00:00.000Z"
    )
    let message = AgentMessage(
        id: "message-1",
        role: "user",
        content: [AgentContentPart(type: "text", text: "Use the current context.")],
        attachments: nil,
        contextRefs: [tokenRef],
        runID: nil,
        createdAt: "2026-05-27T00:00:00.000Z"
    )
    let state = AgentWorkspaceStateAdapter.makeThreadState(
        session: nil,
        messages: [message],
        streamEvents: [],
        toolCalls: [blockedCall],
        longTasks: [],
        daemonStatus: .unavailable
    )

    require(state.selectedContext.first?.title == "BTC", "V2 adapter must expose selected context chips")
    require(state.availableTemplates.count >= 4, "V2 adapter must provide task templates")
    require(state.messages.flatMap(\.parts).contains { $0.kind == .approvalRequest }, "Needs-confirmation tools must render as approval cards")
    require(state.run.displayID == "未开始", "Missing run should be user-readable")
}

private func checkAgentWorkspaceV2HidesPlannerAndNonInterruptingTools() {
    let plannerEvent = AgentStreamEvent(
        eventID: "evt-planner",
        timestamp: "2026-06-04T00:00:00.000Z",
        type: "planner.envelope.created",
        runID: "run-test",
        taskID: "task-test",
        sessionID: "session-test",
        stage: "planner",
        action: nil,
        actionIntent: nil,
        riskLevel: nil,
        artifactKind: "planner",
        contextSourceCount: nil,
        contextChunkCount: nil,
        delta: nil,
        toolName: nil,
        status: "completed",
        permission: nil,
        reason: nil,
        provider: nil,
        model: nil,
        artifactPath: "runtime/agent/runs/run-test/planner-envelope.json",
        errorPreview: nil
    )
    let deltaEvent = AgentStreamEvent(
        eventID: "evt-delta",
        timestamp: "2026-06-04T00:00:01.000Z",
        type: "assistant.delta",
        runID: "run-test",
        taskID: "task-test",
        sessionID: "session-test",
        stage: "model_stream",
        action: nil,
        actionIntent: nil,
        riskLevel: nil,
        artifactKind: nil,
        contextSourceCount: nil,
        contextChunkCount: nil,
        delta: "结论：已读取 CMC 数据。",
        toolName: nil,
        status: nil,
        permission: nil,
        reason: nil,
        provider: nil,
        model: nil,
        artifactPath: nil,
        errorPreview: nil
    )
    let completedToolEvent = AgentStreamEvent(
        eventID: "evt-tool-completed",
        timestamp: "2026-06-04T00:00:02.000Z",
        type: "tool.call",
        runID: "run-test",
        taskID: "task-test",
        sessionID: "session-test",
        stage: "tool_execution",
        action: "cmc.live_market_refresh",
        actionIntent: "external_provider_refresh",
        riskLevel: "low",
        artifactKind: "tool_calls",
        contextSourceCount: nil,
        contextChunkCount: nil,
        delta: nil,
        toolName: "cmc.live_market_refresh",
        status: "completed",
        permission: "pass",
        reason: nil,
        provider: nil,
        model: nil,
        artifactPath: "runtime/agent/runs/run-test/tool-calls.json",
        errorPreview: nil
    )
    let completedCMC = CapabilityCallState(
        id: "tool-cmc",
        toolName: "cmc.live_market_refresh",
        displayName: "CMC 行情刷新",
        status: .completed,
        statusText: "已完成",
        summary: "已获取行情。",
        policyDecision: nil,
        inputSummary: "",
        outputSummary: "",
        artifactRefs: [],
        rawStatus: "completed",
        rawPermission: "pass",
        createdAt: nil
    )
    let message = AgentWorkspaceStateAdapter.makeRunMessage(
        streamEvents: [plannerEvent, deltaEvent, completedToolEvent],
        capabilityCalls: [completedCMC],
        approvals: [],
        activeRunID: "run-test"
    )
    let kinds = message?.parts.map(\.kind) ?? []
    require(kinds.contains(.text), "assistant stream text should remain visible")
    require(!kinds.contains(.planSummary), "planner events must not become chat plan cards")
    require(!kinds.contains(.toolCall), "completed pass tool calls should stay in trace/inspector, not main chat")
    require(!kinds.contains(.finalOutput), "completed tool events must not become repeated result cards")
}

private func checkCompletedRunUsesAuthoritativeFinalReadModel() {
    let denseDelta = makeAgentStreamEvent(
        id: "evt-delta-dense",
        type: "assistant.delta",
        runID: "run-final",
        delta: "cmc.live_market_refresh 完成后，我抓取了以下证据： -市场概览：BTC ETF 净流量。 -宏观关联：BTC 与 DXY。"
    )
    let completed = makeAgentStreamEvent(
        id: "evt-run-completed",
        type: "run.completed",
        runID: "run-final",
        status: "completed",
        artifactPath: "runtime/agent/runs/run-final/final-output.md"
    )
    let mirroredSessionMessage = AgentMessage(
        id: "msg-final",
        role: "assistant",
        content: [AgentContentPart(type: "text", text: "## 结论\n- session 镜像不应作为前端权威来源。")],
        attachments: nil,
        contextRefs: nil,
        runID: "run-final",
        createdAt: "2026-06-04T00:00:02.000Z"
    )
    let finalModel = makeAgentFinalReadModel(
        runID: "run-final",
        finalText: "## 结论\n- 已使用权威 final read model。"
    )
    let state = AgentWorkspaceStateAdapter.makeThreadState(
        session: nil,
        messages: [mirroredSessionMessage],
        streamEvents: [denseDelta, completed],
        toolCalls: [],
        longTasks: [],
        daemonStatus: .unavailable,
        finalReadModelsByRunID: ["run-final": finalModel]
    )
    let textParts = state.messages.flatMap(\.parts).compactMap { part -> String? in
        if case .text(_, let text) = part { return text }
        return nil
    }
    require(textParts.count == 1, "completed run should show only authoritative final read model text")
    require(textParts.first?.contains("权威 final read model") == true, "final read model should remain visible")
    require(!textParts.contains { $0.contains("session 镜像") }, "session assistant mirror must not compete with final read model")
    require(!textParts.contains { $0.contains("cmc.live_market_refresh 完成后") }, "dense stream blob must not be appended after completion")
}

private func checkTerminalRunWithoutFinalReadModelSuppressesStreamBlob() {
    let denseDelta = makeAgentStreamEvent(
        id: "evt-delta-pending",
        type: "assistant.delta",
        runID: "run-pending-final",
        delta: "cmc.live_market_refresh 完成后，我抓取了以下证据： -市场概览：BTC ETF 净流量。 -宏观关联：BTC 与 DXY。"
    )
    let completed = makeAgentStreamEvent(
        id: "evt-run-pending-completed",
        type: "run.completed",
        runID: "run-pending-final",
        status: "completed",
        artifactPath: "runtime/agent/runs/run-pending-final/final-output.md"
    )
    let message = AgentWorkspaceStateAdapter.makeRunMessage(
        streamEvents: [denseDelta, completed],
        capabilityCalls: [],
        approvals: [],
        activeRunID: "run-pending-final",
        suppressAssistantStreamText: true,
        finalReadModel: makeAgentFinalReadModel(
            runID: "run-pending-final",
            finalText: "## 结论\n- final read model 已显示。"
        )
    )
    let kinds = message?.parts.map(\.kind) ?? []
    require(kinds.contains(.text), "terminal run should show final read model text")
    require(!kinds.contains(.notice), "final read model should replace finalizing-only notice")
    let text = message?.parts.compactMap { part -> String? in
        if case .text(_, let text) = part { return text }
        return nil
    }.joined(separator: "\n") ?? ""
    require(text.contains("final read model 已显示"), "authoritative final text should be rendered")
    require(!text.contains("cmc.live_market_refresh 完成后"), "dense stream blob must remain suppressed")

    let pendingMessage = AgentWorkspaceStateAdapter.makeRunMessage(
        streamEvents: [denseDelta, completed],
        capabilityCalls: [],
        approvals: [],
        activeRunID: "run-pending-final",
        suppressAssistantStreamText: true
    )
    let pendingKinds = pendingMessage?.parts.map(\.kind) ?? []
    require(!pendingKinds.contains(.text), "terminal run without final read model must not show dense stream text")
    require(pendingKinds.contains(.notice) || pendingKinds.contains(.finalOutput), "terminal run should show only short finalizing/status parts")
}

private func checkCompletedRunIgnoresTerminalFinalTextWithoutFinalReadModel() {
    let denseDelta = makeAgentStreamEvent(
        id: "evt-terminal-text-dense",
        type: "assistant.delta",
        runID: "run-terminal-text",
        delta: "cmc.live_market_refresh 完成后，我抓取了以下证据： -市场概览：BTC ETF 净流量。 -宏观关联：BTC 与 DXY。"
    )
    let completed = makeAgentStreamEvent(
        id: "evt-terminal-text-completed",
        type: "run.completed",
        runID: "run-terminal-text",
        status: "completed",
        artifactPath: "runtime/agent/runs/run-terminal-text/final-output.md",
        finalText: "## 结论\n- 完成事件正文已直接显示。"
    )
    let state = AgentWorkspaceStateAdapter.makeThreadState(
        session: nil,
        messages: [],
        streamEvents: [denseDelta, completed],
        toolCalls: [],
        longTasks: [],
        daemonStatus: .unavailable
    )
    let text = state.messages.flatMap(\.parts).compactMap { part -> String? in
        if case .text(_, let text) = part { return text }
        return nil
    }.joined(separator: "\n")
    require(!text.contains("完成事件正文已直接显示"), "terminal finalText must not render without final read model")
    require(!text.contains("cmc.live_market_refresh 完成后"), "dense stream blob must remain suppressed after terminal event")
}

private func checkCMCGateSummaryDecodesNestedAndFlatFields() {
    let json = """
    {
      "schemaVersion": "agent-final-read-model-v1",
      "runID": "run-cmc-gate",
      "taskID": "task-cmc-gate",
      "sessionID": "session-cmc-gate",
      "status": "completed",
      "finalText": "## 结论\\n- CMC evidence empty.",
      "finalTextSource": "final_output_artifact",
      "outputGuardStatus": "rewritten",
      "outputGuardReason": "concrete_market_values_without_fresh_gate",
      "cmcGateSummary": {
        "status": "degraded",
        "provider": "mcpProvider",
        "freshness": "fresh",
        "transportStatus": "ok",
        "skillHubDisplay": {
          "status": "usable",
          "allowSkillHubResultDisplay": true,
          "displayableResultText": "CMC Skill Hub 调用成功，返回通用结果摘要；App 未解析到更具体的结构化结论。",
          "displayableResultSource": "genericSummary",
          "parserEvidenceStatus": "empty",
          "allowSkillHubReturnedPrices": true,
          "skillHubReturnedPriceTokenCount": 1,
          "skillHubReturnedTextSource": "cmc_skill_hub_returned_text",
          "skillHubReturnedTextCharCount": 88
        },
        "skillHubDisplayStatus": "usable",
        "allowSkillHubResultDisplay": true,
        "displayableResultText": "CMC Skill Hub 调用成功，返回通用结果摘要；App 未解析到更具体的结构化结论。",
        "displayableResultSource": "genericSummary",
        "parserEvidenceStatus": "empty",
        "allowSkillHubReturnedPrices": true,
        "skillHubReturnedPriceTokenCount": 1,
        "skillHubReturnedTextSource": "cmc_skill_hub_returned_text",
        "skillHubReturnedTextCharCount": 88,
        "researchEvidence": {
          "status": "empty",
          "readableEvidenceCount": 0,
          "emptyEvidenceReason": "skill_hub_transport_ok_but_no_readable_evidence",
          "source": "cmc_skill_hub",
          "allowResearchConclusion": true
        },
        "researchEvidenceStatus": "empty",
        "readableEvidenceCount": 0,
        "emptyEvidenceReason": "skill_hub_transport_ok_but_no_readable_evidence",
        "priceSnapshot": {
          "status": "empty",
          "assetCount": 0,
          "allowConcretePrices": false,
          "provider": "mcpProvider",
          "freshness": "fresh"
        },
        "priceSnapshotStatus": "empty",
        "assetCount": 0,
        "allowResearchConclusion": true,
        "allowConcretePrices": false,
        "reason": "fresh_live_research_snapshot_no_concrete_prices"
      },
      "productMutationPolicy": {
        "status": "discarded",
        "reason": "price_snapshot_empty_or_parser_evidence_empty",
        "decidedAt": "2026-06-05T00:00:00.000Z"
      },
      "generatedAt": "2026-06-05T00:00:00.000Z",
      "artifactPath": "runtime/agent/runs/run-cmc-gate/agent-final-read-model.json"
    }
    """
    let model = try! JSONDecoder.agentArtifactDecoder().decode(AgentFinalReadModel.self, from: Data(json.utf8))
    require(model.cmcGateSummary?.transportStatus == "ok", "CMC gate should preserve transport status")
    require(model.cmcGateSummary?.skillHubDisplay?.status == "usable", "CMC gate should decode nested skill hub display")
    require(model.cmcGateSummary?.skillHubDisplayStatus == "usable", "CMC gate should preserve flat skill hub display status")
    require(model.cmcGateSummary?.allowSkillHubResultDisplay == true, "CMC gate should allow displayable Skill Hub result")
    require(model.cmcGateSummary?.parserEvidenceStatus == "empty", "CMC gate should keep parser evidence empty as diagnostic")
    require(model.cmcGateSummary?.allowSkillHubReturnedPrices == true, "CMC gate should decode returned-price allowance")
    require(model.cmcGateSummary?.skillHubReturnedPriceTokenCount == 1, "CMC gate should decode returned-price token count")
    require(model.cmcGateSummary?.researchEvidence?.status == "empty", "CMC gate should decode nested research evidence")
    require(model.cmcGateSummary?.researchEvidenceStatus == "empty", "CMC gate should preserve flat research evidence status")
    require(model.cmcGateSummary?.priceSnapshot?.allowConcretePrices == false, "CMC gate should decode nested price snapshot")
    require(model.productMutationPolicy?.status == "discarded", "empty CMC evidence should decode discarded mutation policy")
}

private func checkAgentModelPreferencePayloads() {
    let auto = AgentModelPreferenceOption.auto.requestPayload
    require(auto.mode == "auto", "auto model preference should use auto mode")
    require(auto.textModel == nil, "auto model preference should omit explicit model")
    require(auto.fallbackPolicy == "continue_with_eligible_models", "model preference should request fallback chain")

    let pro = AgentModelPreferenceOption.deepseekV4Pro.requestPayload
    require(pro.mode == "explicit", "pro model preference should be explicit")
    require(pro.textModel == "deepseek-v4-pro", "pro model preference should encode deepseek-v4-pro")

    let flash = AgentModelPreferenceOption.deepseekV4Flash.requestPayload
    require(flash.mode == "explicit", "flash model preference should be explicit")
    require(flash.textModel == "deepseek-v4-flash", "flash model preference should encode deepseek-v4-flash")
}

private func checkCMCCapabilitySummaryDecodesRenderContract() {
    let json = """
    {
      "schemaVersion": "cmc-capability-summary-v1",
      "renderSchemaVersion": "cmc-render-result-v1",
      "capabilityID": "cmc-skill-hub",
      "displayName": "CMC Skill Hub",
      "packageTitle": "CMC Skill Hub 能力包",
      "runID": "run-cmc-render",
      "mountStatus": "mounted",
      "transportStatus": "ok",
      "provider": "mcpProvider",
      "skill": "crypto_macro_overview",
      "status": "ok",
      "confidence": "medium",
      "summary": "BTC is trading near 69,000 while ETF flow remains mixed.",
      "returnedContent": {
        "summary": "BTC is trading near 69,000 while ETF flow remains mixed.",
        "conclusion": "Keep BTC on research watch.",
        "marketRead": "Macro liquidity is mixed.",
        "readableEvidence": []
      },
      "renderBlocks": [
        {
          "type": "provider_summary",
          "title": "CMC Skill Hub 返回",
          "body": "BTC is trading near 69,000 while ETF flow remains mixed.",
          "source": "CMC Skill Hub MCP",
          "observedAt": "2026-06-12T00:00:00.000Z"
        }
      ],
      "diagnostics": {
        "parserEvidenceStatus": "empty",
        "researchEvidenceStatus": "empty",
        "priceSnapshotStatus": "empty",
        "assetCount": 0,
        "emptyEvidenceReason": "parser_did_not_extract_structured_sections",
        "freshness": "fresh",
        "confidence": "medium",
        "risk": null,
        "sourceTrust": null,
        "degraded": false
      },
      "claimPolicy": {
        "appMayAddConcretePrices": false,
        "providerReturnedNumbersMayRender": true,
        "appMayAddTradingLevels": false
      },
      "readableEvidence": [],
      "readableEvidenceCount": 0,
      "skillHubDisplayStatus": "usable",
      "allowSkillHubResultDisplay": true,
      "displayableResultText": "BTC is trading near 69,000 while ETF flow remains mixed.",
      "displayableResultSource": "summary",
      "parserEvidenceStatus": "empty",
      "allowSkillHubReturnedPrices": true,
      "skillHubReturnedPriceTokenCount": 1,
      "researchEvidenceStatus": "empty",
      "emptyEvidenceReason": "parser_did_not_extract_structured_sections",
      "priceSnapshotStatus": "empty",
      "assetCount": 0,
      "allowResearchConclusion": true,
      "allowConcretePrices": false,
      "missingOrStaleInputs": [],
      "notableAnomalies": [],
      "generatedAt": "2026-06-12T00:00:00.000Z",
      "sourceObservationCount": 1,
      "workspaceMutationPolicy": {
        "scope": "persistent_workspace_state_only",
        "displayEligibleEvenWhenDiscarded": true
      }
    }
    """
    let model = try! JSONDecoder.agentArtifactDecoder().decode(CMCCapabilitySummary.self, from: Data(json.utf8))
    require(model.renderSchemaVersion == "cmc-render-result-v1", "CMC summary should decode render schema")
    require(model.renderBlocks?.first?.body.contains("69,000") == true, "CMC render block should preserve provider-returned number")
    require(model.diagnostics?.parserEvidenceStatus == "empty", "parser empty should decode as diagnostic")
    require(model.claimPolicy?.providerReturnedNumbersMayRender == true, "provider-returned numbers should be displayable")
    require(model.workspaceMutationPolicy?.scope == "persistent_workspace_state_only", "workspace mutation policy scope should decode")
}

private func checkHarnessReadModelsDecodeAndStoreReads() throws {
    let root = temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let runID = "run-harness-read-model"
    let runDir = root
        .appendingPathComponent("runtime/agent/runs", isDirectory: true)
        .appendingPathComponent(runID, isDirectory: true)
    try FileManager.default.createDirectory(at: runDir, withIntermediateDirectories: true)

    let sessionTreeJSON = """
    {
      "schemaVersion": "agent-harness-session-tree-v1",
      "sessionID": "session-harness",
      "rootRunID": "\(runID)",
      "activeBranchID": "branch-main-\(runID)",
      "branches": [
        {
          "branchID": "branch-main-\(runID)",
          "runID": "\(runID)",
          "parentBranchID": null,
          "branchType": "main",
          "status": "completed",
          "sourceStepID": "step-plan-0",
          "finalReadModelPath": "runtime/agent/runs/\(runID)/agent-final-read-model.json",
          "reviewReadModelPath": null,
          "createdAt": "2026-06-06T00:00:00.000Z",
          "updatedAt": "2026-06-06T00:00:01.000Z"
        }
      ],
      "reviewBranches": [
        {
          "branchID": "branch-review-\(runID)",
          "runID": "review-\(runID)",
          "parentBranchID": "branch-main-\(runID)",
          "branchType": "review",
          "status": "completed",
          "sourceStepID": "step-final-output",
          "finalReadModelPath": null,
          "reviewReadModelPath": "runtime/agent/runs/\(runID)/review-read-model.json",
          "createdAt": "2026-06-06T00:00:01.000Z",
          "updatedAt": "2026-06-06T00:00:01.000Z"
        }
      ],
      "terminalBranches": ["branch-main-\(runID)"],
      "createdAt": "2026-06-06T00:00:00.000Z",
      "updatedAt": "2026-06-06T00:00:01.000Z",
      "artifactPath": "runtime/agent/runs/\(runID)/harness-session-tree.json"
    }
    """
    let lineageJSON = """
    {
      "schemaVersion": "agent-harness-branch-lineage-v1",
      "sessionID": "session-harness",
      "runID": "\(runID)",
      "branchID": "branch-main-\(runID)",
      "parentBranchID": null,
      "sourceRunID": null,
      "sourceStepID": "step-plan-0",
      "branchType": "main",
      "mergeTargetBranchID": null,
      "mergeDecision": "not_applicable",
      "mergeReason": "main_branch_is_authoritative_until_explicit_merge_policy_exists",
      "relatedBranches": [
        {
          "runID": "review-\(runID)",
          "branchID": "branch-review-\(runID)",
          "parentBranchID": "branch-main-\(runID)",
          "sourceRunID": "\(runID)",
          "sourceStepID": "step-final-output",
          "branchType": "review",
          "mergeTargetBranchID": "branch-main-\(runID)",
          "mergeDecision": "pending",
          "mergeReason": "deterministic_review_branch_does_not_auto_merge",
          "reviewReadModelPath": "runtime/agent/runs/\(runID)/review-read-model.json",
          "createdAt": "2026-06-06T00:00:01.000Z"
        }
      ],
      "createdAt": "2026-06-06T00:00:00.000Z",
      "updatedAt": "2026-06-06T00:00:01.000Z",
      "artifactPath": "runtime/agent/runs/\(runID)/harness-branch-lineage.json"
    }
    """
    let reviewJSON = """
    {
      "schemaVersion": "agent-review-read-model-v1",
      "reviewRunID": "review-\(runID)",
      "sourceRunID": "\(runID)",
      "sourceBranchID": "branch-main-\(runID)",
      "status": "insufficient_evidence",
      "findings": [
        {
          "findingID": "cmc-evidence-empty",
          "severity": "high",
          "title": "CMC evidence is empty or unparseable",
          "detail": "skill_hub_transport_ok_but_no_readable_evidence",
          "artifactPath": "runtime/agent/runs/\(runID)/tool-observations.json"
        }
      ],
      "checkedArtifacts": [
        {
          "name": "agent-final-read-model.json",
          "artifactPath": "runtime/agent/runs/\(runID)/agent-final-read-model.json",
          "status": "checked"
        }
      ],
      "cmcGateSummary": null,
      "outputGuardStatus": "rewritten",
      "mutationPolicyAssessment": {
        "status": "discarded",
        "reason": "cmc_research_evidence_empty",
        "importAllowed": false
      },
      "mergeRecommendation": "discard",
      "generatedAt": "2026-06-06T00:00:01.000Z",
      "artifactPath": "runtime/agent/runs/\(runID)/review-read-model.json"
    }
    """
    try sessionTreeJSON.write(to: runDir.appendingPathComponent("harness-session-tree.json"), atomically: true, encoding: .utf8)
    try lineageJSON.write(to: runDir.appendingPathComponent("harness-branch-lineage.json"), atomically: true, encoding: .utf8)
    try reviewJSON.write(to: runDir.appendingPathComponent("review-read-model.json"), atomically: true, encoding: .utf8)

    let resolver = AgentRuntimePathResolver(pathResolver: RuntimePathResolver(root: root))
    let store = AgentRunReadModelStore(streamStore: AgentStreamStore(resolver: resolver))
    let tree = store.readHarnessSessionTree(runID: runID)
    require(tree?.branches.first?.status == "completed", "harness session tree should decode completed main branch")
    require(tree?.reviewBranches.first?.reviewReadModelPath?.contains("review-read-model.json") == true, "harness session tree should decode review branch path")
    let lineage = store.readHarnessBranchLineage(runID: runID)
    require(lineage?.relatedBranches?.first?.mergeDecision == "pending", "branch lineage should preserve pending review merge decision")
    let review = store.readReviewReadModel(runID: runID)
    require(review?.status == "insufficient_evidence", "review read model should decode deterministic review status")
    require(review?.mutationPolicyAssessment?.importAllowed == false, "review read model should preserve non-importable mutation assessment")
}

private func makeAgentStreamEvent(
    id: String,
    type: String,
    runID: String,
    delta: String? = nil,
    status: String? = nil,
    artifactPath: String? = nil,
    finalText: String? = nil
) -> AgentStreamEvent {
    var event = AgentStreamEvent(
        eventID: id,
        timestamp: "2026-06-04T00:00:00.000Z",
        type: type,
        runID: runID,
        taskID: "task-\(runID)",
        sessionID: "session-test",
        stage: "model_stream",
        action: nil,
        actionIntent: nil,
        riskLevel: nil,
        artifactKind: artifactPath == nil ? nil : "final_output",
        contextSourceCount: nil,
        contextChunkCount: nil,
        delta: delta,
        toolName: nil,
        status: status,
        permission: nil,
        reason: nil,
        provider: nil,
        model: nil,
        artifactPath: artifactPath,
        errorPreview: nil
    )
    event.finalText = finalText
    return event
}

private func makeAgentFinalReadModel(
    runID: String,
    finalText: String,
    outputGuardStatus: String = "passed",
    mutationPolicyStatus: String = "importable"
) -> AgentFinalReadModel {
    AgentFinalReadModel(
        schemaVersion: "agent-final-read-model-v1",
        runID: runID,
        taskID: "task-\(runID)",
        sessionID: "session-test",
        status: "completed",
        finalText: finalText,
        finalTextSource: "final_output_artifact",
        outputGuardStatus: outputGuardStatus,
        outputGuardReason: nil,
        cmcGateSummary: CMCGateSummary(
            status: "pass",
            provider: "mcpProvider",
            freshness: "fresh",
            transportStatus: "ok",
            researchEvidenceStatus: "usable",
            readableEvidenceCount: 1,
            emptyEvidenceReason: nil,
            priceSnapshotStatus: "empty",
            assetCount: 0,
            allowResearchConclusion: true,
            allowConcretePrices: false,
            reason: "fresh_live_research_snapshot_no_concrete_prices"
        ),
        productMutationPolicy: ProductMutationPolicy(
            status: mutationPolicyStatus,
            reason: mutationPolicyStatus == "discarded" ? "cmc_research_evidence_empty" : "cmc_evidence_or_price_snapshot_usable",
            decidedAt: "2026-06-05T00:00:00.000Z"
        ),
        generatedAt: "2026-06-05T00:00:00.000Z",
        artifactPath: "runtime/agent/runs/\(runID)/agent-final-read-model.json"
    )
}

private func checkAgentRunManifestAndV2EventDecode() {
    let manifestJSON = """
    {
      "schemaVersion": "agent-run-manifest-v1",
      "runID": "run-test",
      "taskID": "task-test",
      "sessionID": "session-test",
      "status": "running",
      "currentStage": "context",
      "publicSurfaceOnly": true,
      "internalToolsExposed": false,
      "contextSummary": {
        "schemaVersion": "agent-context-plane-summary-v1",
        "runID": "run-test",
        "taskID": "task-test",
        "status": "pass",
        "sourceCount": 4,
        "chunkCount": 6,
        "selectedChunkCount": 6,
        "missingSourceCount": 0,
        "staleChunkCount": 0,
        "artifactPath": "runtime/agent/runs/run-test/context-bundle.json",
        "updatedAt": "2026-05-29T00:00:00.000Z"
      },
      "controlSummary": {
        "schemaVersion": "agent-control-plane-summary-v1",
        "runID": "run-test",
        "taskID": "task-test",
        "taskType": "token_onchain_review",
        "profileID": "sequential_research_mvp",
        "stage": "context",
        "toolIntentCount": 5,
        "policyDecisionCount": 5,
        "blockedPolicyCount": 0,
        "approvalDecisionCount": 0,
        "qaStatus": "pass",
        "modelReadinessStatus": "blocked_missing_provider_config",
        "artifactPath": "runtime/agent/runs/run-test/control-plane-manifest.json",
        "updatedAt": "2026-05-29T00:00:00.000Z"
      },
      "artifacts": [
        {"name": "run-manifest.json", "kind": "manifest", "stage": "run", "artifactPath": "runtime/agent/runs/run-test/run-manifest.json"}
      ],
      "redactionStatus": "summary_only",
      "updatedAt": "2026-05-29T00:00:00.000Z"
    }
    """.data(using: .utf8)!
    let eventJSON = """
    {
      "eventID": "evt-test",
      "timestamp": "2026-05-29T00:00:00.000Z",
      "type": "context_plane.bundle.created",
      "runID": "run-test",
      "taskID": "task-test",
      "stage": "context",
      "action": "context-plane",
      "actionIntent": "assemble_context",
      "riskLevel": "low",
      "artifactKind": "context_bundle",
      "contextSourceCount": 4,
      "contextChunkCount": 6,
      "status": "pass",
      "artifactPath": "runtime/agent/runs/run-test/context-bundle.json"
    }
    """.data(using: .utf8)!

    let manifest = try! JSONDecoder.agentArtifactDecoder().decode(AgentRunManifest.self, from: manifestJSON)
    let event = try! JSONDecoder.agentArtifactDecoder().decode(AgentStreamEvent.self, from: eventJSON)

    require(manifest.internalToolsExposed == false, "Run manifest must preserve hidden internal tool boundary")
    require(manifest.contextSummary?.sourceCount == 4, "Run manifest should decode context summary")
    require(event.stage == "context", "V2 stream event should decode stage")
    require(event.contextChunkCount == 6, "V2 stream event should decode context counts")
}

private func checkAgentWorkspaceAdapterUsesControlContextSummaries() {
    let context = AgentContextPlaneSummary(
        schemaVersion: "agent-context-plane-summary-v1",
        runID: "run-test",
        taskID: "task-test",
        status: "pass",
        sourceCount: 4,
        chunkCount: 6,
        selectedChunkCount: 6,
        missingSourceCount: 0,
        staleChunkCount: 0,
        artifactPath: "runtime/agent/runs/run-test/context-bundle.json",
        updatedAt: "2026-05-29T00:00:00.000Z"
    )
    let control = AgentControlPlaneSummary(
        schemaVersion: "agent-control-plane-summary-v1",
        runID: "run-test",
        taskID: "task-test",
        taskType: "token_onchain_review",
        profileID: "sequential_research_mvp",
        stage: "context",
        toolIntentCount: 5,
        policyDecisionCount: 5,
        blockedPolicyCount: 0,
        approvalDecisionCount: 0,
        qaStatus: "pass",
        modelReadinessStatus: "blocked_missing_provider_config",
        artifactPath: "runtime/agent/runs/run-test/control-plane-manifest.json",
        updatedAt: "2026-05-29T00:00:00.000Z"
    )
    let manifest = AgentRunManifest(
        schemaVersion: "agent-run-manifest-v1",
        runID: "run-test",
        taskID: "task-test",
        sessionID: "session-test",
        status: "running",
        currentStage: "context",
        publicSurfaceOnly: true,
        internalToolsExposed: false,
        selectedSkillIDs: ["wechat-onchain-intelligence"],
        selectedExtensionIDs: ["wechat-cli-export-bridge"],
        contextSummary: context,
        controlSummary: control,
        artifacts: [],
        redactionStatus: "summary_only",
        finalOutputPath: nil,
        toolCallCount: nil,
        updatedAt: "2026-05-29T00:00:00.000Z",
        completedAt: nil
    )
    let state = AgentWorkspaceStateAdapter.makeThreadState(
        session: nil,
        messages: [],
        streamEvents: [],
        toolCalls: [],
        runManifest: manifest,
        controlSummary: control,
        contextSummary: context,
        longTasks: [],
        daemonStatus: .unavailable
    )

    require(state.run.latestStep == "整理上下文", "Adapter should derive current stage from run manifest")
    require(state.run.latestDetail.contains("上下文 4 项 / 6 段"), "Adapter should expose lightweight context summary")
    require(state.controlSummary?.blockedPolicyCount == 0, "Adapter should preserve control summary for inspector")
}

private func checkFixtureFileAdapterLoadsSampleJSONAndContracts() throws {
    let batch = try WeChatFixtureFileAdapter().loadBatch(selectedGroupID: nil, date: testDate("2026-05-24T00:00:00Z"))

    require(batch.sourceMode == "fixture_file", "Fixture adapter must load messages.sample.json instead of hardcoded fallback")
    require(batch.messages.contains { $0.excerpt.contains("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee") }, "Fixture file must include ETH CA sample")
    require(batch.messages.contains { $0.excerpt.contains("So11111111111111111111111111111111111111112") }, "Fixture file must include SOL CA sample")

    let resolver = TokenResolutionService()
    let normalized = resolver.normalize(messages: batch.messages, groups: batch.groups, sourceMode: batch.sourceMode)
    let entities = resolver.resolve(messages: normalized)
    let ethMessage = normalized.first { $0.extractedContracts.contains("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee") }

    require(normalized.contains { $0.extractedContracts.contains("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee") }, "ETH CA must be extracted from fixture text")
    require(normalized.contains { $0.extractedContracts.contains("So11111111111111111111111111111111111111112") }, "SOL CA must be extracted from fixture text")
    require(ethMessage?.extractedContracts.count == 1, "EVM CA extraction must not leak a nested base58 false positive")
    require(entities.contains { $0.tokenID == "ethereum:0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" && $0.confidence >= 0.9 }, "ETH CA token entity must be resolved with high confidence")
    require(entities.contains { $0.tokenID == "solana:so11111111111111111111111111111111111111112" && $0.confidence >= 0.9 }, "SOL CA token entity must be resolved with high confidence")
}

private func checkCMCProviderUsesFreshStoreSnapshot() throws {
    let temp = temporaryDirectory()
    let store = MarketSnapshotStore(snapshotURL: temp.appendingPathComponent("market.json"))
    let now = testDate("2026-05-24T00:00:00Z")
    let snapshot = MarketDataSnapshot(
        status: "enabled",
        sourceName: "Test Market Store",
        provider: "cmcRestProvider",
        generatedAt: AgentDateFormatting.isoString(now),
        observedAt: AgentDateFormatting.isoString(now),
        expiresAt: AgentDateFormatting.isoString(testDate("2026-05-25T00:00:00Z")),
        freshness: "fresh",
        lastVerifiedAt: AgentDateFormatting.isoString(now),
        assets: [
            MarketAsset(
                symbol: "BTC",
                name: "Bitcoin",
                priceUSD: 1,
                percentChange24h: 2,
                volume24hUSD: 3,
                marketCapUSD: 4,
                source: "test",
                isLive: true
            )
        ],
        evidence: ["test snapshot"],
        upstreamStatus: "test_fresh"
    )
    try store.write(snapshot)

    let provider = CMCMarketDataProvider(refreshBridge: CMCRefreshBridge(store: store))
    let market = provider.fetchMarketData(for: ["BTC"], date: now)

    require(market.sourceName == "Test Market Store", "CMC provider should prefer fresh store snapshot")
    require(market.freshness == "fresh", "Fresh store snapshot should stay fresh")
    require(market.assets.first?.priceUSD == 1, "Fresh store asset price should be preserved")
}

private func checkCMCProviderMarksExpiredStoreSnapshotStale() throws {
    let temp = temporaryDirectory()
    let store = MarketSnapshotStore(snapshotURL: temp.appendingPathComponent("market.json"))
    let now = testDate("2026-05-24T00:00:00Z")
    let snapshot = MarketDataSnapshot(
        status: "enabled",
        sourceName: "Expired Store",
        provider: "cmcRestProvider",
        generatedAt: "2026-05-21T00:00:00.000Z",
        observedAt: "2026-05-21T00:00:00.000Z",
        expiresAt: "2026-05-22T00:00:00.000Z",
        freshness: "fresh",
        lastVerifiedAt: "2026-05-21T00:00:00.000Z",
        assets: [],
        evidence: ["expired"],
        upstreamStatus: "expired"
    )
    try store.write(snapshot)

    let provider = CMCMarketDataProvider(refreshBridge: CMCRefreshBridge(store: store))
    let market = provider.fetchMarketData(for: ["BTC"], date: now)

    require(market.status == "degraded", "Expired store snapshot should be degraded")
    require(market.freshness == "stale", "Expired store snapshot should be stale")
}

private func checkCMCProviderDoesNotPromoteFixtureSnapshotToLive() throws {
    let temp = temporaryDirectory()
    let store = MarketSnapshotStore(snapshotURL: temp.appendingPathComponent("market.json"))
    let now = testDate("2026-05-24T00:00:00Z")
    let snapshot = MarketDataSnapshot(
        status: "enabled",
        sourceName: "Fixture Store",
        provider: "fixtureProvider",
        generatedAt: AgentDateFormatting.isoString(now),
        observedAt: AgentDateFormatting.isoString(now),
        expiresAt: AgentDateFormatting.isoString(testDate("2026-05-25T00:00:00Z")),
        freshness: "fixture",
        lastVerifiedAt: AgentDateFormatting.isoString(now),
        assets: [
            MarketAsset(
                symbol: "BTC",
                name: "Bitcoin",
                priceUSD: 1,
                percentChange24h: 2,
                volume24hUSD: 3,
                marketCapUSD: 4,
                source: "fixture",
                isLive: false
            )
        ],
        evidence: ["fixture snapshot"],
        upstreamStatus: "fixture"
    )
    try store.write(snapshot)

    let market = CMCMarketDataProvider(refreshBridge: CMCRefreshBridge(store: store))
        .fetchMarketData(for: ["BTC"], date: now)

    require(market.status == "degraded", "Fixture snapshot must not remain enabled")
    require(market.freshness == "fixture", "Fixture snapshot must not be promoted to fresh")
    require(market.assets.allSatisfy { !$0.isLive }, "Fixture assets must not be live")
}

private func checkAgentDaemonAuthTokenLoadsFromRuntime() throws {
    let temp = temporaryDirectory()
    let authDir = temp.appendingPathComponent("runtime/agent", isDirectory: true)
    try FileManager.default.createDirectory(at: authDir, withIntermediateDirectories: true)
    let authURL = authDir.appendingPathComponent("auth-token.json")
    let payload = #"{"schemaVersion":"agent-daemon-auth-token-v1","token":"test-token-123"}"#
    try payload.data(using: .utf8)!.write(to: authURL)

    let token = AgentDaemonAuth.loadToken(pathResolver: RuntimePathResolver(root: temp))
    require(token == "test-token-123", "Agent daemon auth token should load from runtime/agent/auth-token.json")
}

private func checkTimeWindowFilteringChangesSnapshotSizeAndArtifactsWrite() {
    let temp = temporaryDirectory()
    let pathResolver = RuntimePathResolver(root: temp)
    let runStore = AgentRunStore(runsDirectory: pathResolver.runsDirectory)
    let marketStore = MarketSnapshotStore(pathResolver: pathResolver)
    let provider = CMCMarketDataProvider(refreshBridge: CMCRefreshBridge(store: marketStore))
    let orchestrator = AgentOrchestrator(
        adapter: MockWeChatDataAdapter(),
        cmcProvider: provider,
        runStore: runStore,
        normalizedWeChatStore: NormalizedWeChatStore(pathResolver: pathResolver),
        tokenEntityStore: TokenEntityStore(pathResolver: pathResolver),
        onchainSnapshotStore: OnchainSnapshotStore(pathResolver: pathResolver),
        alertStore: AlertStore(pathResolver: pathResolver),
        evidenceStore: EvidenceStore(pathResolver: pathResolver),
        taskStore: TaskStore(pathResolver: pathResolver),
        watchlistStore: WatchlistStore(pathResolver: pathResolver),
        alertRuleStore: AlertRuleStore(pathResolver: pathResolver),
        artifactManifestStore: ArtifactManifestStore(pathResolver: pathResolver),
        runtimeHealthStore: RuntimeHealthStore(pathResolver: pathResolver),
        crystalStore: CrystalStore(pathResolver: pathResolver),
        proposalStore: ProposalStore(pathResolver: pathResolver),
        memoryStore: MemoryStore(pathResolver: pathResolver),
        handoffStore: HandoffStore(pathResolver: pathResolver),
        proactiveSessionStore: ProactiveSessionStore(pathResolver: pathResolver),
        bridgeStatusStore: BridgeStatusStore(pathResolver: pathResolver),
        pathResolver: pathResolver,
        runIDProvider: { "test-run" }
    )
    let now = testDate("2026-05-24T00:00:00Z")

    let day = orchestrator.run(date: now, selectedGroupID: nil, window: .day)
    let month = orchestrator.run(date: now, selectedGroupID: nil, window: .month)

    require(day.snapshot.signals.count < month.snapshot.signals.count, "Month window should include more signals than day")
    require(month.syncState.runID == "test-run", "Run ID should be surfaced")
    require(month.envelope.taskType == "wechat_onchain_terminal_runtime_refresh", "Planner taskType must use runtime refresh")
    require(month.artifactStatus?.lastWrittenFile == "logs.json", "Run artifacts should write logs.json last")
    require(FileManager.default.fileExists(atPath: temp.appendingPathComponent("runtime/runs/test-run/run.json").path), "Run artifact must exist")
    require(FileManager.default.fileExists(atPath: temp.appendingPathComponent("runtime/runs/test-run/module-runs.json").path), "Module runs artifact must exist")
}

private func checkDefaultMonthWindowGeneratesThreeCrystals() {
    let temp = temporaryDirectory()
    let pathResolver = RuntimePathResolver(root: temp)
    let orchestrator = AgentOrchestrator(
        adapter: WeChatFixtureFileAdapter(),
        cmcProvider: CMCMarketDataProvider(refreshBridge: CMCRefreshBridge(store: MarketSnapshotStore(pathResolver: pathResolver))),
        runStore: AgentRunStore(runsDirectory: pathResolver.runsDirectory),
        normalizedWeChatStore: NormalizedWeChatStore(pathResolver: pathResolver),
        tokenEntityStore: TokenEntityStore(pathResolver: pathResolver),
        onchainSnapshotStore: OnchainSnapshotStore(pathResolver: pathResolver),
        alertStore: AlertStore(pathResolver: pathResolver),
        evidenceStore: EvidenceStore(pathResolver: pathResolver),
        taskStore: TaskStore(pathResolver: pathResolver),
        watchlistStore: WatchlistStore(pathResolver: pathResolver),
        alertRuleStore: AlertRuleStore(pathResolver: pathResolver),
        artifactManifestStore: ArtifactManifestStore(pathResolver: pathResolver),
        runtimeHealthStore: RuntimeHealthStore(pathResolver: pathResolver),
        crystalStore: CrystalStore(pathResolver: pathResolver),
        proposalStore: ProposalStore(pathResolver: pathResolver),
        memoryStore: MemoryStore(pathResolver: pathResolver),
        handoffStore: HandoffStore(pathResolver: pathResolver),
        proactiveSessionStore: ProactiveSessionStore(pathResolver: pathResolver),
        bridgeStatusStore: BridgeStatusStore(pathResolver: pathResolver),
        pathResolver: pathResolver,
        runIDProvider: { "month-crystal-run" }
    )

    let result = orchestrator.run(date: testDate("2026-05-26T00:00:00Z"), selectedGroupID: nil, window: .month)

    require(result.terminalData.proactive.crystals.count >= 3, "Default month path should generate at least 3 crystals")
    require(Set(result.terminalData.proactive.crystals.map(\.title)).isSuperset(of: ["BTC fused signal", "ETH fused signal", "SOL fused signal"]), "Default month path should include BTC/ETH/SOL crystals")
    require(result.terminalData.moduleRuns.first { $0.moduleID == .crystal }?.status == .completed, "Crystal module should complete when 3 crystals are present")
}

private func checkTerminalDataStoresCloseTheTokenLoop() throws {
    let temp = temporaryDirectory()
    let pathResolver = RuntimePathResolver(root: temp)
    let marketStore = MarketSnapshotStore(pathResolver: pathResolver)
    let orchestrator = AgentOrchestrator(
        adapter: WeChatFixtureFileAdapter(),
        cmcProvider: CMCMarketDataProvider(refreshBridge: CMCRefreshBridge(store: marketStore)),
        runStore: AgentRunStore(runsDirectory: pathResolver.runsDirectory),
        normalizedWeChatStore: NormalizedWeChatStore(pathResolver: pathResolver),
        tokenEntityStore: TokenEntityStore(pathResolver: pathResolver),
        onchainSnapshotStore: OnchainSnapshotStore(pathResolver: pathResolver),
        alertStore: AlertStore(pathResolver: pathResolver),
        evidenceStore: EvidenceStore(pathResolver: pathResolver),
        taskStore: TaskStore(pathResolver: pathResolver),
        watchlistStore: WatchlistStore(pathResolver: pathResolver),
        alertRuleStore: AlertRuleStore(pathResolver: pathResolver),
        artifactManifestStore: ArtifactManifestStore(pathResolver: pathResolver),
        runtimeHealthStore: RuntimeHealthStore(pathResolver: pathResolver),
        crystalStore: CrystalStore(pathResolver: pathResolver),
        proposalStore: ProposalStore(pathResolver: pathResolver),
        memoryStore: MemoryStore(pathResolver: pathResolver),
        handoffStore: HandoffStore(pathResolver: pathResolver),
        proactiveSessionStore: ProactiveSessionStore(pathResolver: pathResolver),
        bridgeStatusStore: BridgeStatusStore(pathResolver: pathResolver),
        pathResolver: pathResolver,
        runIDProvider: { "terminal-test-run" }
    )

    let result = orchestrator.run(date: testDate("2026-05-24T00:00:00Z"), selectedGroupID: nil, window: .year)
    let runtime = pathResolver.runtimeDirectory
    let runDirectory = runtime.appendingPathComponent("runs/terminal-test-run", isDirectory: true)

    require(result.snapshot.sourceMode == "fixture_file", "Terminal loop should use editable fixture JSON")
    require(result.terminalData.normalizedMessages.count >= 7, "Terminal loop should normalize fixture messages")
    require(result.terminalData.tokenEntities.contains { $0.tokenID == "ethereum:0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" }, "Terminal loop should persist ETH CA entity")
    require(result.terminalData.tokenEntities.contains { $0.tokenID == "solana:so11111111111111111111111111111111111111112" }, "Terminal loop should persist SOL CA entity")
    require(result.terminalData.onchainSnapshots.contains { $0.contractAddress == "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" && $0.source == "fixture_onchain_snapshot" }, "On-chain snapshot should be generated for ETH CA")
    require(result.terminalData.evidenceItems.contains { $0.tokenIDs.contains("ethereum:0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee") }, "Evidence store should include ETH token evidence")
    require(result.terminalData.tasks.contains { $0.tokenID == "ethereum:0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" }, "Task store should include ETH follow-up task")
    require(result.terminalData.alerts.contains { $0.tokenID == "ethereum:0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" }, "Alert store should include ETH mention watch")
    require(result.terminalData.watchlistItems.contains { $0.tokenID == "ethereum:0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" }, "Watchlist store should include ETH watchlist item")
    require(result.terminalData.alertRules.contains { $0.tokenID == "ethereum:0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" }, "Alert rules should include ETH mention watch rule")
    require(result.terminalData.moduleRuns.contains { $0.moduleID == .evidence && !$0.producedArtifacts.isEmpty }, "Agent module pipeline should include evidence module")
    require(result.terminalData.moduleRuns.contains { $0.moduleID == .task && !$0.producedArtifacts.isEmpty }, "Agent module pipeline should include task module")
    require(result.terminalData.artifactManifest.completenessStatus == "complete", "Artifact manifest should be complete")
    require(!result.terminalData.runtimeHealth.checks.isEmpty, "Runtime health checks should be generated")
    require(result.terminalData.sourceHealth.contains { $0.source == "agent_module_manager" }, "Ops source health should include agent module manager")
    require(result.terminalData.proactive.crystals.count >= 3, "Full-phase runtime should generate at least 3 crystals")
    require(result.terminalData.proactive.crystals.allSatisfy { !$0.evidenceRefs.isEmpty && !$0.tokenRefs.isEmpty && !$0.nextAction.title.isEmpty }, "Each crystal should carry evidence, token refs, and next action")
    require(result.terminalData.proactive.proposals.count >= 3, "Full-phase runtime should generate proposals from crystals")
    require(result.terminalData.proactive.memory.count >= 3, "Full-phase runtime should write local memory seeds")
    require(result.terminalData.proactive.handoffs.count == 1, "Full-phase runtime should create a local handoff draft")
    require(result.terminalData.proactive.latestSession?.runID == "terminal-test-run", "Proactive session should preserve run provenance")
    require(result.terminalData.proactive.bridgeStatuses.map(\.id).sorted() == ["market-bridge", "onchain-bridge", "wechat-export-bridge"], "Bridge contracts should be represented")
    require(result.terminalData.proactive.handoffs.allSatisfy { !$0.redaction.privateContentIncluded }, "Handoff drafts must keep private content redacted")
    require(result.terminalData.moduleRuns.contains { $0.moduleID == .crystal && !$0.producedArtifacts.isEmpty }, "Agent module pipeline should include crystalizer module")
    require(result.terminalData.moduleRuns.contains { $0.moduleID == .proposal && !$0.producedArtifacts.isEmpty }, "Agent module pipeline should include proposal planner module")
    require(result.terminalData.moduleRuns.contains { $0.moduleID == .handoff && !$0.producedArtifacts.isEmpty }, "Agent module pipeline should include handoff writer module")
    require(result.terminalData.moduleRuns.contains { $0.moduleID == .session && !$0.producedArtifacts.isEmpty }, "Agent module pipeline should include session writer module")

    require(FileManager.default.fileExists(atPath: runtime.appendingPathComponent("wechat/messages.normalized.json").path), "Normalized WeChat store must be written")
    require(FileManager.default.fileExists(atPath: runtime.appendingPathComponent("entities/token-entities.json").path), "Token entity store must be written")
    require(FileManager.default.fileExists(atPath: runtime.appendingPathComponent("onchain/Ethereum/0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.json").path), "ETH on-chain artifact must be written")
    require(FileManager.default.fileExists(atPath: runtime.appendingPathComponent("alerts/alerts.json").path), "Alert artifact must be written")
    require(FileManager.default.fileExists(atPath: runtime.appendingPathComponent("alerts/alert-rules.json").path), "Alert rules artifact must be written")
    require(FileManager.default.fileExists(atPath: runtime.appendingPathComponent("evidence/evidence.json").path), "Evidence artifact must be written")
    require(FileManager.default.fileExists(atPath: runtime.appendingPathComponent("tasks/tasks.json").path), "Task artifact must be written")
    require(FileManager.default.fileExists(atPath: runtime.appendingPathComponent("watchlist/watchlist.json").path), "Watchlist artifact must be written")
    require(FileManager.default.fileExists(atPath: runtime.appendingPathComponent("artifacts/manifest.json").path), "Artifact manifest must be written")
    require(FileManager.default.fileExists(atPath: runtime.appendingPathComponent("health/latest-health.json").path), "Runtime health artifact must be written")
    require(FileManager.default.fileExists(atPath: runtime.appendingPathComponent("crystals/crystals.json").path), "Crystal artifact must be written")
    require(FileManager.default.fileExists(atPath: runtime.appendingPathComponent("proposals/proposals.json").path), "Proposal artifact must be written")
    require(FileManager.default.fileExists(atPath: runtime.appendingPathComponent("memory/memory.json").path), "Memory artifact must be written")
    require(FileManager.default.fileExists(atPath: runtime.appendingPathComponent("handoffs/index.json").path), "Handoff index must be written")
    require(FileManager.default.fileExists(atPath: runtime.appendingPathComponent("sessions/latest-session.json").path), "Proactive session artifact must be written")
    require(FileManager.default.fileExists(atPath: runtime.appendingPathComponent("bridges/market-bridge.json").path), "Market bridge contract artifact must be written")
    require(FileManager.default.fileExists(atPath: runtime.appendingPathComponent("bridges/onchain-bridge.json").path), "On-chain bridge contract artifact must be written")
    require(FileManager.default.fileExists(atPath: runtime.appendingPathComponent("bridges/wechat-export-bridge.json").path), "WeChat export bridge contract artifact must be written")
    require(FileManager.default.fileExists(atPath: runDirectory.appendingPathComponent("terminal-data.json").path), "Run terminal-data artifact must be written")
    require(FileManager.default.fileExists(atPath: runDirectory.appendingPathComponent("module-runs.json").path), "Run agent module timeline artifact must be written")
    require(FileManager.default.fileExists(atPath: runDirectory.appendingPathComponent("artifact-manifest.json").path), "Run artifact manifest must be written")

    let moduleData = try Data(contentsOf: runDirectory.appendingPathComponent("module-runs.json"))
    let moduleRuns = try JSONDecoder.agentArtifactDecoder().decode([AgentModuleRun].self, from: moduleData)
    require(moduleRuns.count >= 9, "All runtime agent capability modules should be represented")
    require(moduleRuns.allSatisfy { !$0.inputSummary.isEmpty && !$0.outputSummary.isEmpty }, "Agent module runs must record input and output summaries")
}

private func checkRuntimeBackendProactiveCommands() {
    let temp = temporaryDirectory()
    let pathResolver = RuntimePathResolver(root: temp)
    let orchestrator = AgentOrchestrator(
        adapter: WeChatFixtureFileAdapter(),
        cmcProvider: CMCMarketDataProvider(refreshBridge: CMCRefreshBridge(store: MarketSnapshotStore(pathResolver: pathResolver))),
        runStore: AgentRunStore(runsDirectory: pathResolver.runsDirectory),
        normalizedWeChatStore: NormalizedWeChatStore(pathResolver: pathResolver),
        tokenEntityStore: TokenEntityStore(pathResolver: pathResolver),
        onchainSnapshotStore: OnchainSnapshotStore(pathResolver: pathResolver),
        alertStore: AlertStore(pathResolver: pathResolver),
        evidenceStore: EvidenceStore(pathResolver: pathResolver),
        taskStore: TaskStore(pathResolver: pathResolver),
        watchlistStore: WatchlistStore(pathResolver: pathResolver),
        alertRuleStore: AlertRuleStore(pathResolver: pathResolver),
        artifactManifestStore: ArtifactManifestStore(pathResolver: pathResolver),
        runtimeHealthStore: RuntimeHealthStore(pathResolver: pathResolver),
        crystalStore: CrystalStore(pathResolver: pathResolver),
        proposalStore: ProposalStore(pathResolver: pathResolver),
        memoryStore: MemoryStore(pathResolver: pathResolver),
        handoffStore: HandoffStore(pathResolver: pathResolver),
        proactiveSessionStore: ProactiveSessionStore(pathResolver: pathResolver),
        bridgeStatusStore: BridgeStatusStore(pathResolver: pathResolver),
        pathResolver: pathResolver,
        runIDProvider: { "backend-proactive-run" }
    )
    let repository = RuntimeRepository(
        orchestrator: orchestrator,
        taskStore: TaskStore(pathResolver: pathResolver),
        watchlistStore: WatchlistStore(pathResolver: pathResolver),
        alertStore: AlertStore(pathResolver: pathResolver),
        crystalStore: CrystalStore(pathResolver: pathResolver),
        proposalStore: ProposalStore(pathResolver: pathResolver),
        memoryStore: MemoryStore(pathResolver: pathResolver),
        handoffStore: HandoffStore(pathResolver: pathResolver)
    )
    let agentResolver = AgentRuntimePathResolver(pathResolver: pathResolver)
    var backend = RuntimeBackend(
        repository: repository,
        agentRunReadModelStore: AgentRunReadModelStore(streamStore: AgentStreamStore(resolver: agentResolver)),
        agentProductMutationStore: AgentProductMutationStore(resolver: agentResolver)
    )
    var state = backend.execute(.refreshRun(reason: "test", selectedGroupID: nil, window: .year, date: testDate("2026-05-24T00:00:00Z")))

    let crystalID = state.result.terminalData.proactive.crystals.first!.id
    state = backend.execute(.selectCrystal(crystalID))
    require(state.selection.selectedCrystalID == crystalID, "selectCrystal should update runtime selection")

    let proposalID = state.result.terminalData.proactive.proposals.first!.id
    state = backend.execute(.acceptProposal(proposalID))
    require(state.result.terminalData.proactive.proposals.first { $0.id == proposalID }?.status == .accepted, "acceptProposal should update local proposal status")
    let watchlistCount = state.result.terminalData.watchlistItems.count
    state = backend.execute(.acceptProposal(proposalID))
    require(state.result.terminalData.watchlistItems.count == watchlistCount, "acceptProposal should be idempotent")

    let secondProposalID = state.result.terminalData.proactive.proposals.dropFirst().first!.id
    state = backend.execute(.rejectProposal(secondProposalID, reason: "test reject"))
    require(state.result.terminalData.proactive.proposals.first { $0.id == secondProposalID }?.status == .rejected, "rejectProposal should update local proposal status")
    require(state.result.terminalData.proactive.memory.contains { $0.content == "test reject" }, "rejectProposal should write review memory")

    let memoryID = state.result.terminalData.proactive.memory.first!.id
    state = backend.execute(.purgeMemory(memoryID))
    require(!state.result.terminalData.proactive.memory.contains { $0.id == memoryID }, "purgeMemory should remove memory from runtime query state")

    state = backend.execute(.createHandoff(crystalIDs: [crystalID]))
    let handoffID = state.result.terminalData.proactive.handoffs.first!.id
    require(state.result.terminalData.proactive.handoffs.contains { $0.selectedCrystalRefs.contains { $0.id == crystalID.uuidString } }, "createHandoff should write selected crystal handoff")

    state = backend.execute(.archiveHandoff(handoffID))
    require(state.result.terminalData.proactive.handoffs.first { $0.id == handoffID }?.status == .archived, "archiveHandoff should mark the selected handoff archived")

    state = backend.execute(.purgeArchivedHandoffs)
    require(!state.result.terminalData.proactive.handoffs.contains { $0.id == handoffID }, "purgeArchivedHandoffs should remove archived handoffs from runtime state")

    let discardRunID = "discarded-mutation-run"
    let discardRunDir = agentResolver.runsDirectory.appendingPathComponent(discardRunID, isDirectory: true)
    try! FileManager.default.createDirectory(at: discardRunDir, withIntermediateDirectories: true)
    let discardedFinal = makeAgentFinalReadModel(
        runID: discardRunID,
        finalText: "## 结论\n- 证据不足，产物丢弃。",
        outputGuardStatus: "rewritten",
        mutationPolicyStatus: "discarded"
    )
    try! JSONEncoder.agentArtifactEncoder().encode(discardedFinal)
        .write(to: discardRunDir.appendingPathComponent("agent-final-read-model.json"), options: [.atomic])
    let mutationTask = UserTask(
        id: UUID(),
        title: "Should not import",
        detail: "Discarded policy should block this task.",
        status: "open",
        priority: 1,
        source: "agent_product_mutation",
        evidenceID: nil,
        tokenID: nil,
        messageID: nil,
        generatedAt: "2026-06-05T00:00:00.000Z",
        artifactPath: "runtime/agent/runs/\(discardRunID)/product-mutations.json"
    )
    let mutationPayload = AgentProductMutationPayload(
        schemaVersion: "agent-product-mutations-v1",
        runID: discardRunID,
        source: "test",
        createdAt: "2026-06-05T00:00:00.000Z",
        updatedAt: "2026-06-05T00:00:00.000Z",
        idempotencyKeys: ["task:\(mutationTask.id.uuidString)"],
        tasks: [mutationTask],
        watchlistItems: [],
        crystals: [],
        proposals: [],
        memory: [],
        handoffs: []
    )
    try! JSONEncoder.agentArtifactEncoder().encode(mutationPayload)
        .write(to: discardRunDir.appendingPathComponent("product-mutations.json"), options: [.atomic])
    let taskCountBeforeDiscardedImport = state.result.terminalData.tasks.count
    state = backend.execute(.importAgentProductMutations(runID: discardRunID))
    require(state.result.terminalData.tasks.count == taskCountBeforeDiscardedImport, "discarded final read model must block product mutation import")
    require(state.commandStatus.contains("agent_mutations_discarded"), "discarded mutation policy should be visible in command status")
}

private func testDate(_ value: String) -> Date {
    ISO8601DateFormatter().date(from: value)!
}

private func temporaryDirectory() -> URL {
    let url = FileManager.default.temporaryDirectory
        .appendingPathComponent("wechat-radar-tests-\(UUID().uuidString)", isDirectory: true)
    try! FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}
