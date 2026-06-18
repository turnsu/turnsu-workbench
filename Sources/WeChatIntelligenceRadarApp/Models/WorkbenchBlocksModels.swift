import Foundation
import SwiftUI

enum WorkbenchDomain: String, CaseIterable, Identifiable, Hashable {
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

enum WorkbenchBlockAction: String, CaseIterable, Identifiable, Hashable {
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
    let prompt: String
    let systemImage: String
    let action: WorkbenchBlockAction
    let defaultSkillIDs: [String]
    let defaultExtensionIDs: [String]

    static let all: [WorkbenchLoopTemplate] = [
        WorkbenchLoopTemplate(
            id: "crypto-market-scan",
            domain: .crypto,
            title: "Market scan",
            subtitle: "CMC 返回结果、证据缺口、下一轮追问",
            prompt: "用 CMC Skill Hub 扫描今天 crypto 市场，输出可展示的市场摘要、证据缺口、价格来源说明和下一轮追问，不给下单指令。",
            systemImage: "arrow.triangle.2.circlepath",
            action: .runLoop,
            defaultSkillIDs: ["cmc-market-radar", "market-regime-review"],
            defaultExtensionIDs: ["cmc-skill-hub"]
        ),
        WorkbenchLoopTemplate(
            id: "crypto-thesis-review",
            domain: .crypto,
            title: "Thesis review",
            subtitle: "复核 BTC/ETH/SOL thesis 和反证",
            prompt: "复核一个 crypto thesis：只引用 CMC Skill Hub 返回内容、群消息或链上 evidence，区分可展示结果、价格门禁、反证和后续观察条件。",
            systemImage: "checkmark.seal",
            action: .review,
            defaultSkillIDs: ["cmc-market-radar", "market-regime-review", "social-price-divergence"],
            defaultExtensionIDs: ["cmc-skill-hub", "wechat-cli-export-bridge"]
        ),
        WorkbenchLoopTemplate(
            id: "crypto-opportunity-watch",
            domain: .crypto,
            title: "Opportunity watch",
            subtitle: "寻找研究候选，不生成交易指令",
            prompt: "寻找 crypto 潜在交易机会候选，只输出研究候选、需要复核的证据、风险和下一轮数据需求，不生成入场、止损、止盈或下单建议。",
            systemImage: "scope",
            action: .runLoop,
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
