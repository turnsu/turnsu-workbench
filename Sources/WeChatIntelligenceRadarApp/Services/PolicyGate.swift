import Foundation

enum AgentAction: String {
    case readMockFixture = "read_mock_fixture"
    case readFixtureFile = "read_fixture_file"
    case readWeChatCLIExportFile = "read_wechat_cli_export_file"
    case runLiveWeChatCLI = "run_live_wechat_cli"
    case readLiveWeChat = "read_live_wechat"
    case generateBriefing = "generate_briefing"
    case queryCMCMCP = "query_cmc_mcp"
    case useMockMarketFixture = "use_mock_market_fixture"
    case enrichWeb3Signals = "enrich_web3_signals"
    case copySummary = "copy_summary"
    case changeTimeWindow = "change_time_window"
    case selectGroup = "select_group"
    case acceptLocalProposal = "accept_local_proposal"
    case rejectProposal = "reject_proposal"
    case createLocalHandoff = "create_local_handoff"
    case exportHandoffOutsideProject = "export_handoff_outside_project"
    case requestMarketBridgeRefresh = "request_market_bridge_refresh"
    case requestOnchainBridgeRefresh = "request_onchain_bridge_refresh"
    case executeTrade = "execute_trade"
    case sendMessage = "send_message"
    case publishContent = "publish_content"
}

struct PolicyGate {
    func check(_ action: AgentAction) -> PolicyDecision {
        switch action {
        case .readMockFixture:
            return PolicyDecision(
                action: action.rawValue,
                status: "pass",
                reason: "Fixture 数据位于新项目内，不触碰真实微信数据。"
            )
        case .readFixtureFile:
            return PolicyDecision(
                action: action.rawValue,
                status: "pass",
                reason: "读取项目内 sample fixture JSON，不触碰真实微信数据。"
            )
        case .readWeChatCLIExportFile:
            return PolicyDecision(
                action: action.rawValue,
                status: "needs_confirmation",
                reason: "仅允许用户主动提供的 wechat-cli export JSON；导入前需要确认隐私边界。"
            )
        case .runLiveWeChatCLI:
            return PolicyDecision(
                action: action.rawValue,
                status: "blocked",
                reason: "禁止运行 wechat-cli init/history/search 或任何读取本机微信的命令。"
            )
        case .readLiveWeChat:
            return PolicyDecision(
                action: action.rawValue,
                status: "blocked",
                reason: "用户限制 MVP 阶段不能擅自接入当前电脑微信。"
            )
        case .generateBriefing:
            return PolicyDecision(
                action: action.rawValue,
                status: "pass",
                reason: "基于 mock batch 做本地摘要和结构化提取。"
            )
        case .queryCMCMCP:
            return PolicyDecision(
                action: action.rawValue,
                status: "pass",
                reason: "当前会话已加载 CMC Crypto Skill Hub；只允许通过已验证 skill 输出进入 agent snapshot。"
            )
        case .useMockMarketFixture:
            return PolicyDecision(
                action: action.rawValue,
                status: "standby",
                reason: "CMC Skill Hub 可用时不使用 mock market；仅在 CMC degraded/blocked 时作为明确 fallback。"
            )
        case .enrichWeb3Signals:
            return PolicyDecision(
                action: action.rawValue,
                status: "pass",
                reason: "只在本地消息 fixture 与市场 fixture 上做 ticker/entity enrichment。"
            )
        case .copySummary:
            return PolicyDecision(
                action: action.rawValue,
                status: "pass",
                reason: "复制当前本地摘要到剪贴板，不读取外部数据。"
            )
        case .changeTimeWindow:
            return PolicyDecision(
                action: action.rawValue,
                status: "pass",
                reason: "时间窗口仅触发本地 agent rerun。"
            )
        case .selectGroup:
            return PolicyDecision(
                action: action.rawValue,
                status: "pass",
                reason: "群组选择只过滤本地 mock batch。"
            )
        case .acceptLocalProposal:
            return PolicyDecision(
                action: action.rawValue,
                status: "pass",
                reason: "Proposal accept 仅写本地 runtime artifact，不执行外部动作。"
            )
        case .rejectProposal:
            return PolicyDecision(
                action: action.rawValue,
                status: "pass",
                reason: "Proposal reject 仅写本地 review memory。"
            )
        case .createLocalHandoff:
            return PolicyDecision(
                action: action.rawValue,
                status: "pass",
                reason: "Handoff 默认写入项目 runtime/handoffs，且使用脱敏摘要。"
            )
        case .exportHandoffOutsideProject:
            return PolicyDecision(
                action: action.rawValue,
                status: "needs_confirmation",
                reason: "导出到项目外可能包含敏感情报，需要用户确认。"
            )
        case .requestMarketBridgeRefresh:
            return PolicyDecision(
                action: action.rawValue,
                status: "needs_confirmation",
                reason: "外部 CMC/MCP refresh 必须由外部 agent 写 normalized JSON，Swift 不直连。"
            )
        case .requestOnchainBridgeRefresh:
            return PolicyDecision(
                action: action.rawValue,
                status: "needs_confirmation",
                reason: "外部 RPC/DEX bridge 必须由授权流程写 normalized JSON，Swift 不直连。"
            )
        case .executeTrade:
            return PolicyDecision(
                action: action.rawValue,
                status: "blocked",
                reason: "MVP 阶段禁止交易执行。"
            )
        case .sendMessage:
            return PolicyDecision(
                action: action.rawValue,
                status: "blocked",
                reason: "MVP 阶段禁止自动发送消息。"
            )
        case .publishContent:
            return PolicyDecision(
                action: action.rawValue,
                status: "blocked",
                reason: "MVP 阶段禁止自动发布内容。"
            )
        }
    }
}
