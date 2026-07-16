import Foundation
import SwiftUI

enum WorkbenchDomain: String, CaseIterable, Identifiable, Hashable, Codable {
    case crypto = "Crypto"
    case markets = "Markets"
    case office = "Office"

    var id: String { rawValue }

    var title: String { rawValue }

    var subtitle: String {
        switch self {
        case .crypto:
            return "CMC market loops"
        case .markets:
            return "Equity and cross-asset"
        case .office:
            return "Meeting and documents"
        }
    }

    var systemImage: String {
        switch self {
        case .crypto:
            return "chart.line.uptrend.xyaxis"
        case .markets:
            return "building.columns"
        case .office:
            return "doc.text"
        }
    }

    var tint: Color {
        switch self {
        case .crypto:
            return RadarTheme.blue
        case .markets:
            return RadarTheme.indigo
        case .office:
            return RadarTheme.green
        }
    }

    var placeholder: String {
        switch self {
        case .crypto:
            return "让 CMC Skill Hub 扫描市场、复核 thesis，或继续追问当前 crypto 结果…"
        case .markets:
            return "启动公司深研、财报复核、行业扫描或跨资产 read-through…"
        case .office:
            return "拖入会议材料、音视频、图片或文档，生成纪要、草稿、改写或飞书预览…"
        }
    }
}

enum WorkbenchBlockAction: String, CaseIterable, Identifiable, Hashable, Codable {
    case runLoop = "Run loop"
    case continueLoop = "Continue"
    case review = "Review"
    case refineDraft = "Refine draft"
    case prepareDelivery = "Prepare delivery"

    var id: String { rawValue }
}

struct WorkbenchLoopTemplate: Identifiable, Hashable {
    let id: String
    let domain: WorkbenchDomain
    let title: String
    let subtitle: String
    let trigger: String
    let stepsSummary: [String]
    let feedbackGate: String
    let exitCondition: String
    let reviewBoundary: String
    let outputShape: String
    let prompt: String
    let systemImage: String
    let action: WorkbenchBlockAction
    let defaultSkillIDs: [String]
    let defaultExtensionIDs: [String]

    init(
        id: String,
        domain: WorkbenchDomain,
        title: String,
        subtitle: String,
        trigger: String? = nil,
        stepsSummary: [String] = [],
        feedbackGate: String? = nil,
        exitCondition: String? = nil,
        reviewBoundary: String? = nil,
        outputShape: String? = nil,
        prompt: String,
        systemImage: String,
        action: WorkbenchBlockAction,
        defaultSkillIDs: [String],
        defaultExtensionIDs: [String]
    ) {
        self.id = id
        self.domain = domain
        self.title = title
        self.subtitle = subtitle
        self.trigger = trigger ?? subtitle
        self.stepsSummary = stepsSummary.isEmpty ? [subtitle] : stepsSummary
        self.feedbackGate = feedbackGate ?? "人工复核输出质量后再继续。"
        self.exitCondition = exitCondition ?? "生成当前任务的可读结果或待确认问题。"
        self.reviewBoundary = reviewBoundary ?? "仅生成草稿和复核清单，不执行外部动作。"
        self.outputShape = outputShape ?? "最终答案、证据说明、下一步建议。"
        self.prompt = prompt
        self.systemImage = systemImage
        self.action = action
        self.defaultSkillIDs = defaultSkillIDs
        self.defaultExtensionIDs = defaultExtensionIDs
    }

    static let all: [WorkbenchLoopTemplate] = [
        WorkbenchLoopTemplate(
            id: "crypto-market-report-loop",
            domain: .crypto,
            title: "Market Report Loop",
            subtitle: "大盘、perp、链上广度扫描",
            trigger: "需要一轮周期市场扫描或小时级 crypto monitor。",
            stepsSummary: [
                "并行读取大盘 regime、perp scanner、on-chain scanner。",
                "逐项检查 status、confidence、missing/stale inputs 和错误。",
                "只把高质量候选放入后续深挖或复核队列。"
            ],
            feedbackGate: "如果大盘防御、数据 partial 或 scanner 结果拥挤，只输出研究候选和等待条件。",
            exitCondition: "形成候选漏斗、市场 stance、缺失输入和下一轮检查条件。",
            reviewBoundary: "review-only：不调用 Trading Zac，不触发 dry-run，不生成下单动作。",
            outputShape: "中文本轮报告摘要、候选状态变化、NO_TRADE/等待触发说明。",
            prompt: "运行一轮 Crypto Market Report Loop：用 CMC Skill Hub 做大盘 regime、perp scanner、on-chain scanner 的并行只读扫描，逐项检查 status、confidence、missing_or_stale_inputs、error 和数据时间。输出中文候选漏斗、市场 stance、缺失输入、下一轮复核条件和人工 review 清单；不调用 Trading Zac，不触发 dry-run 或 live 交易，不生成下单指令。",
            systemImage: "arrow.triangle.2.circlepath",
            action: .runLoop,
            defaultSkillIDs: ["cmc-market-radar", "market-regime-review"],
            defaultExtensionIDs: ["cmc-skill-hub"]
        ),
        WorkbenchLoopTemplate(
            id: "crypto-defi-opportunity-scan",
            domain: .crypto,
            title: "DeFi Opportunity Scan",
            subtitle: "深挖 1-3 个候选，输出四问与 R:R",
            trigger: "需要从 crypto / DeFi / public-contract 候选中寻找交易机会。",
            stepsSummary: [
                "先广度筛选，再只深挖 1-3 个干净候选。",
                "检查价格/OI、funding/basis、spot 与 futures CVD、多周期结构。",
                "给出 A/B/C/D 执行分层和 R:R 解释。"
            ],
            feedbackGate: "A 级必须四问通过且结构性 R:R >= 2:1；R:R < 1.5:1 强制拒绝交易。",
            exitCondition: "输出持仓/空仓/等待触发 stance、候选生命周期和下一轮触发条件。",
            reviewBoundary: "review-only：生成计划草稿和复核任务，不转换成订单。",
            outputShape: "候选深挖、四问深度门、R:R 假设、A/B/C/D 分层、人工复核清单。",
            prompt: "运行 DeFi Opportunity Scan：先从 CMC Skill Hub 返回内容、perp 结构、链上/public-contract 线索和已有上下文中筛选候选，再只深挖 1-3 个证据最干净的标的。每个重点标的必须写四问深度门：价格/OI、funding/basis、spot 与 futures CVD、多周期结构；必须写 R:R 假设、入场前置、止损参考、目标、潜在亏损/收益、是否值得执行。输出 A/B/C/D 分层、最终 stance 和人工 review 清单；不调用 Trading Zac，不触发 dry-run 或 live 交易。",
            systemImage: "scope",
            action: .runLoop,
            defaultSkillIDs: ["cmc-market-radar", "market-regime-review"],
            defaultExtensionIDs: ["cmc-skill-hub"]
        ),
        WorkbenchLoopTemplate(
            id: "crypto-thesis-review",
            domain: .crypto,
            title: "Thesis Review",
            subtitle: "复核 BTC/ETH/SOL thesis、支持与反证",
            trigger: "已有 thesis、关注标的或上一轮结果需要复核。",
            stepsSummary: [
                "读取当前 thesis 与 CMC returned result。",
                "分离支持证据、反证、缺失输入和价格门禁。",
                "给出失效条件、升级条件和下一轮追问。"
            ],
            feedbackGate: "没有 spot/perp confirmation 或证据冲突时，不能升级为执行建议。",
            exitCondition: "形成支持/反证矩阵、失效条件和继续观察条件。",
            reviewBoundary: "review-only：只做 thesis 复核，不写下单指令。",
            outputShape: "中文 thesis 结论、反证、风险、后续观察脚本。",
            prompt: "复核一个 crypto thesis：只引用 CMC Skill Hub returned result、群消息、链上或用户提供材料，区分支持证据、反证、缺失输入、价格门禁和后续观察条件。没有 spot/perp confirmation 或证据冲突时，必须保持等待或拒绝交易；不调用 Trading Zac，不触发 dry-run 或 live 交易。",
            systemImage: "checkmark.seal",
            action: .review,
            defaultSkillIDs: ["cmc-market-radar", "market-regime-review", "social-price-divergence"],
            defaultExtensionIDs: ["cmc-skill-hub", "wechat-cli-export-bridge"]
        ),
        WorkbenchLoopTemplate(
            id: "crypto-trade-plan-review",
            domain: .crypto,
            title: "Trade Plan Review",
            subtitle: "A/B/C/D 分层计划草稿，不执行交易",
            trigger: "需要把当前候选整理成交易计划和人工复核清单。",
            stepsSummary: [
                "组合级 stance：空仓、持仓、开多、开空或等待触发。",
                "每个标的写入场前置、触发、止损、止盈、禁止条件和风险预算。",
                "把 NO_TRADE、等待触发、risk rejected 视为有效安全结果。"
            ],
            feedbackGate: "没有 A 级可执行时必须写 0 风险预算；交易执行必须停在人工 review。",
            exitCondition: "输出可复核交易计划草稿、触发条件、失效条件和下一次检查。",
            reviewBoundary: "review-only：不调用 Trading Zac、不下单、不发送外部指令。",
            outputShape: "中文交易计划草稿、A/B/C/D 分层、人工确认清单。",
            prompt: "把当前 crypto 候选整理成 Trade Plan Review：输出组合级 stance、总风险预算、A/B/C/D 执行分层、每个标的的入场前置、入场触发、初始止损参考、减仓/止盈逻辑、禁止交易条件、仓位/风险、下一次检查和人工复核清单。没有 A 级可执行时明确写 0 风险预算。只生成交易计划草稿，不调用 Trading Zac，不触发 dry-run 或 live 交易，不生成下单动作。",
            systemImage: "list.clipboard",
            action: .review,
            defaultSkillIDs: ["cmc-market-radar", "market-regime-review"],
            defaultExtensionIDs: ["cmc-skill-hub"]
        ),
        WorkbenchLoopTemplate(
            id: "markets-company-deep-dive",
            domain: .markets,
            title: "Company deep dive",
            subtitle: "业务质量、财务线索、反证和复核任务",
            prompt: "做一家公司 deep dive：输出业务质量、财务问题、竞争格局、反证、证据缺口和下一轮复核任务；不要输出 BUY/HOLD/SELL。",
            systemImage: "building.columns",
            action: .runLoop,
            defaultSkillIDs: ["equity-company-deep-dive", "equity-thesis-tracker"],
            defaultExtensionIDs: ["markets-research"]
        ),
        WorkbenchLoopTemplate(
            id: "markets-earnings-review",
            domain: .markets,
            title: "Earnings review",
            subtitle: "收入质量、margin、guidance 和管理层语气",
            prompt: "复核一家公司的最新 earnings：收入质量、margin、guidance、管理层语气、异常项、风险和需要补充的材料。",
            systemImage: "chart.bar.doc.horizontal",
            action: .review,
            defaultSkillIDs: ["equity-earnings-review", "equity-thesis-tracker"],
            defaultExtensionIDs: ["markets-research"]
        ),
        WorkbenchLoopTemplate(
            id: "markets-cross-asset",
            domain: .markets,
            title: "Cross-asset read",
            subtitle: "crypto、equity、sector、macro 联动",
            prompt: "结合 crypto、equity、sector 和 macro read-through，找出值得继续研究的风险偏好线索，只输出研究候选和复核任务。",
            systemImage: "point.3.connected.trianglepath.dotted",
            action: .runLoop,
            defaultSkillIDs: ["macro-cross-asset-readthrough", "equity-sector-scan"],
            defaultExtensionIDs: ["markets-research", "cmc-skill-hub"]
        ),
        WorkbenchLoopTemplate(
            id: "office-meeting-minutes",
            domain: .office,
            title: "Meeting minutes",
            subtitle: "云端转写、纪要、行动项和待确认问题",
            prompt: "基于我拖入的会议材料或音视频，写一版结构化会议纪要：结论、行动项、负责人、deadline、风险和需要我确认的问题。",
            systemImage: "text.badge.checkmark",
            action: .runLoop,
            defaultSkillIDs: ["meeting-cloud-asr", "meeting-minutes"],
            defaultExtensionIDs: ["office-meeting-agent"]
        ),
        WorkbenchLoopTemplate(
            id: "office-document-draft",
            domain: .office,
            title: "Doc draft",
            subtitle: "把材料整理成团队可读草稿",
            prompt: "把我给的材料整理成一份团队可读的文档草稿，结构清晰、措辞克制、保留待确认项，不执行真实发布。",
            systemImage: "doc.text",
            action: .refineDraft,
            defaultSkillIDs: ["document-generation"],
            defaultExtensionIDs: ["office-meeting-agent"]
        ),
        WorkbenchLoopTemplate(
            id: "office-feishu-preview",
            domain: .office,
            title: "Feishu preview",
            subtitle: "只生成预览，不发布、不回复",
            prompt: "生成一版飞书文档预览草稿，先不要发布或回复，列出交付前需要我确认的对象、标题和风险。",
            systemImage: "square.and.pencil",
            action: .prepareDelivery,
            defaultSkillIDs: ["feishu-agent-bridge", "document-revision"],
            defaultExtensionIDs: ["office-meeting-agent"]
        )
    ]

    static func templates(for domain: WorkbenchDomain) -> [WorkbenchLoopTemplate] {
        all.filter { $0.domain == domain }
    }
}

struct WorkbenchBlock: Identifiable, Hashable {
    var id: WorkbenchDomain { domain }
    let domain: WorkbenchDomain
    let activeLoopCount: Int
    let reviewCount: Int
    let completedCount: Int

    var statusText: String {
        if activeLoopCount > 0 { return "\(activeLoopCount) active" }
        if reviewCount > 0 { return "\(reviewCount) review" }
        if completedCount > 0 { return "\(completedCount) done" }
        return "ready"
    }
}

struct WorkbenchLoopRunState: Identifiable, Hashable {
    var id: String { task.taskID }
    let task: AgentLongTask
    let domain: WorkbenchDomain
    let capabilityLoop: CapabilityLoopReadModel?
    let finalReadModel: AgentFinalReadModel?

    var title: String {
        capabilityLoop?.title ?? promptTitle
    }

    var promptTitle: String {
        let trimmed = task.prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "Untitled loop" : trimmed
    }

    var reviewLabel: String {
        capabilityLoop?.review.actionLabel ?? "Review"
    }

    var statusLabel: String {
        BlocksTaskStatus.label(for: task.status)
    }

    var isRunning: Bool {
        BlocksTaskStatus.isRunning(task.status)
    }
}

enum WorkbenchBlockClassifier {
    static func domain(
        for task: AgentLongTask,
        capabilityLoop: CapabilityLoopReadModel? = nil
    ) -> WorkbenchDomain {
        if let loopType = capabilityLoop?.loopType.lowercased() {
            if loopType.contains("markets") { return .markets }
            if loopType.contains("office") || loopType.contains("meeting") { return .office }
            if loopType.contains("crypto") { return .crypto }
        }

        let haystack = ([
            task.prompt,
            task.selectedSkillIDs?.joined(separator: " ") ?? "",
            task.selectedExtensionIDs?.joined(separator: " ") ?? "",
            task.selectedToolNames.joined(separator: " ")
        ]).joined(separator: " ").lowercased()

        if haystack.range(of: #"markets|equity|earnings|sector|company|stock|cross-asset|股票|财报|行业|公司"#, options: .regularExpression) != nil {
            return .markets
        }
        if haystack.range(of: #"office|meeting|minutes|document|feishu|lark|asr|会议|纪要|文档|飞书"#, options: .regularExpression) != nil {
            return .office
        }
        return .crypto
    }
}
