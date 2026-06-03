import Foundation

/// Frontend read model for the CMC strategist workbench, mirroring the runtime artifact
/// `strategyReadModel` (schema `cmc-strategist-result-v1`) described in
/// wiki/architecture/2026-06-03-cmc-strategist-workbench-architecture.md.
///
/// The Swift layer consumes only this lightweight read model + artifact pointers; raw provider
/// payloads, API keys and live MCP details stay inside runtime artifacts. Every conclusion must
/// carry a source pointer, and `riskBoundary.tradeInstruction` is always `blocked` — this is a
/// decision-support surface, never an order generator.
struct CMCStrategistResult: Identifiable, Hashable, Codable {
    var schemaVersion: String = "cmc-strategist-result-v1"
    let taskType: String
    let title: String
    let verdict: String
    var confidence: Double = 0
    var dataFreshness: String = "unknown"
    /// The one-line decision the user is trying to make (shown as a "决策问题" box).
    var decisionProblem: String? = nil
    let subject: Subject
    var candidateSignals: [Signal] = []
    var keyLevels: [KeyLevel] = []
    var scenarios: [Scenario] = []
    var counterEvidence: [CounterEvidence] = []
    var sourceMap: [SourceRef] = []
    var riskBoundary: RiskBoundary = .default
    var followUps: [FollowUp] = []
    /// Closing decision-support takeaway.
    var takeaway: String? = nil
    /// Artifact this result was decoded from (set by the loader; not part of the schema).
    var artifactPath: String? = nil

    var id: String { artifactPath ?? "\(taskType):\(title)" }

    var kind: StrategistTaskType { StrategistTaskType(rawValue: taskType) }

    struct Subject: Hashable, Codable {
        let symbol: String
        var name: String? = nil
        var instrument: String? = nil
        var directionContext: String? = nil
    }

    struct Signal: Hashable, Codable, Identifiable {
        let label: String
        let value: String
        var interpretation: String = ""
        var evidenceRefs: [String]? = nil
        var id: String { "\(label):\(value)" }
    }

    struct KeyLevel: Hashable, Codable, Identifiable {
        let label: String
        var price: Double? = nil
        var upperPrice: Double? = nil
        let role: String
        var condition: String? = nil
        var invalidatesBelow: Double? = nil
        var id: String { label }
    }

    struct Scenario: Hashable, Codable, Identifiable {
        let id: String
        let label: String
        let ifCondition: String
        let thenOutcome: String
        var bias: String = "neutral"
        var confidence: Double? = nil
        /// Marks the scenario that actually played out (▶ in the showcase scenario map).
        var triggered: Bool = false

        enum CodingKeys: String, CodingKey {
            case id, label, bias, confidence, triggered
            case ifCondition = "if"
            case thenOutcome = "then"
        }
    }

    struct CounterEvidence: Hashable, Codable, Identifiable {
        let label: String
        let detail: String
        var severity: String = "medium"
        var id: String { label }
    }

    struct SourceRef: Hashable, Codable, Identifiable {
        let label: String
        let artifactPath: String
        var freshness: String = "unknown"
        var provider: String = "unknown"
        var id: String { artifactPath }
    }

    struct RiskBoundary: Hashable, Codable {
        var tradeInstruction: String = "blocked"
        var summary: String = "仅做研究与决策支持，不生成下单、仓位或杠杆指令。"
        var warnings: [String] = []
        static let `default` = RiskBoundary()
    }

    struct FollowUp: Hashable, Codable, Identifiable {
        let label: String
        let condition: String
        var suggestedSkillIDs: [String]? = nil
        var id: String { label }
    }
}

/// Known strategist task types from the architecture doc, plus display metadata.
enum StrategistTaskType: Hashable {
    case alphaDiscovery
    case perpTradeReview
    case macroThesisReview
    case other(String)

    init(rawValue: String) {
        switch rawValue {
        case "alpha_discovery", "cmc_alpha_discovery": self = .alphaDiscovery
        case "perp_trade_review", "cmc_perp_trade_review": self = .perpTradeReview
        case "macro_thesis_review", "cmc_macro_thesis_review": self = .macroThesisReview
        default: self = .other(rawValue)
        }
    }

    var label: String {
        switch self {
        case .alphaDiscovery: return "Alpha 发现"
        case .perpTradeReview: return "永续复核"
        case .macroThesisReview: return "宏观 Thesis"
        case .other: return "策略分析"
        }
    }

    var icon: String {
        switch self {
        case .alphaDiscovery: return "scope"
        case .perpTradeReview: return "chart.line.uptrend.xyaxis"
        case .macroThesisReview: return "globe.asia.australia"
        case .other: return "chart.bar.doc.horizontal"
        }
    }
}

// MARK: - Sample data (decision-support previews; replaced by live runtime artifacts)

extension CMCStrategistResult {
    /// Sample matching the architecture doc's HOME alpha example. Clearly a fixture preview —
    /// labeled with provider/freshness = fixture and carrying the full risk boundary.
    static let alphaSample = CMCStrategistResult(
        taskType: "alpha_discovery",
        title: "HOME 永续挤压候选，等待回踩",
        verdict: "研究候选成立，但不追高，等待关键回踩区确认。",
        confidence: 0.72,
        dataFreshness: "fixture",
        decisionProblem: "市场 risk-off（恐惧 36），晨扫把 HOME 标了出来——已 +187%/30d、funding 深度为负。这是真 alpha，还是该回避的 blow-off 顶？",
        subject: Subject(symbol: "HOME", name: "Defi App", instrument: "spot/perp", directionContext: "watch_long_setup"),
        candidateSignals: [
            Signal(label: "Perp 挤压", value: "OI +201% · funding -0.31%", interpretation: "拥挤且可能继续挤压，但不是低风险追高点。"),
            Signal(label: "成交放量", value: "24h vol +138%", interpretation: "关注度上升，需确认是否 perp 主导。"),
            Signal(label: "社媒热度", value: "mentions +96%", interpretation: "叙事在升温，但 spot 还未确认。")
        ],
        keyLevels: [
            KeyLevel(label: "回踩区", price: 0.038, upperPrice: 0.0405, role: "wait_for_entry_review", condition: "价格回踩且结构未破坏", invalidatesBelow: 0.035),
            KeyLevel(label: "失效区", price: 0.035, role: "invalidation", condition: "跌破则候选作废")
        ],
        scenarios: [
            Scenario(id: "A", label: "继续挤压", ifCondition: "守住回踩区，OI 不塌，funding 修复", thenOutcome: "继续观察上方流动性区", bias: "constructive", confidence: 0.55, triggered: true),
            Scenario(id: "B", label: "假突破回落", ifCondition: "spot 持续不确认、funding 转正后回落", thenOutcome: "回到区间下沿，候选转弱", bias: "cautious", confidence: 0.3),
            Scenario(id: "C", label: "结构破坏", ifCondition: "跌破 0.035 失效区", thenOutcome: "候选作废，移出观察", bias: "bearish", confidence: 0.15)
        ],
        counterEvidence: [
            CounterEvidence(label: "Spot 确认不足", detail: "spot CVD 未确认，结构偏 perp-led", severity: "medium"),
            CounterEvidence(label: "流动性缺口", detail: "缺少 live liquidation map，挤压上限不确定", severity: "low")
        ],
        sourceMap: [
            SourceRef(label: "CMC 市场证据", artifactPath: "runtime/agent/runs/{runID}/cmc-daily_market_overview.json", freshness: "fixture", provider: "fixtureProvider")
        ],
        riskBoundary: RiskBoundary(
            tradeInstruction: "blocked",
            summary: "仅做研究与决策支持，不生成下单、仓位或杠杆指令。",
            warnings: ["杠杆会放大亏损", "缺少 live liquidation map 时必须标记数据缺口"]
        ),
        followUps: [
            FollowUp(label: "跟踪回踩区", condition: "价格进入 0.038–0.0405 且 funding 正常化", suggestedSkillIDs: ["cmc-market-radar"])
        ],
        takeaway: "发现 + 纪律：扫描在变明显前就捞出 HOME；深度分析拒绝追顶、标出 0.035 这条决定性价位。价格回踩到该位即是有依据的入场，而非追高 FOMO。"
    )

    static let perpSample = CMCStrategistResult(
        taskType: "perp_trade_review",
        title: "ZEC 永续多头：场景化复核",
        verdict: "结构仍偏强，但拥挤度高；建议分批减、留底仓，等回踩加。",
        confidence: 0.61,
        dataFreshness: "fixture",
        decisionProblem: "我做空 ZEC 且在盈利。挤压会不会回来碾我，还是这就是 breakdown——哪条线告诉我答案？",
        subject: Subject(symbol: "ZEC", name: "Zcash", instrument: "perp", directionContext: "user_long"),
        candidateSignals: [
            Signal(label: "持仓结构", value: "OI 高位 · funding +0.08%", interpretation: "多头拥挤，squeeze 与回落都可能。"),
            Signal(label: "CVD", value: "现货 CVD 走平", interpretation: "上涨更多由 perp 推动。")
        ],
        keyLevels: [
            KeyLevel(label: "止盈参考区", price: 62, upperPrice: 68, role: "take_profit_zone", condition: "触及后分批减"),
            KeyLevel(label: "结构支撑", price: 48, role: "support", condition: "守住则底仓可留", invalidatesBelow: 45)
        ],
        scenarios: [
            Scenario(id: "A", label: "Squeeze 延续", ifCondition: "funding 不转极端、OI 维持", thenOutcome: "上探 62–68 止盈区", bias: "constructive", confidence: 0.45),
            Scenario(id: "B", label: "Breakdown", ifCondition: "跌破 48 且 OI 快速去化", thenOutcome: "退出多头，转观望", bias: "bearish", confidence: 0.3, triggered: true),
            Scenario(id: "C", label: "区间震荡", ifCondition: "48–62 区间反复", thenOutcome: "降低仓位，等方向", bias: "neutral", confidence: 0.25)
        ],
        counterEvidence: [
            CounterEvidence(label: "Funding 拥挤", detail: "多头资金成本上升，回调风险加大", severity: "high"),
            CounterEvidence(label: "清算数据缺失", detail: "无 live liquidation map，squeeze 风险无法量化", severity: "medium")
        ],
        sourceMap: [
            SourceRef(label: "CMC 永续结构", artifactPath: "runtime/agent/runs/{runID}/cmc-perp_structure_review.json", freshness: "fixture", provider: "fixtureProvider")
        ],
        riskBoundary: RiskBoundary(
            tradeInstruction: "blocked",
            summary: "仅复核结构并给出条件式判断，不构成买卖、加减仓或杠杆指令。",
            warnings: ["你的 entry/leverage 仅作为上下文展示", "高 funding 环境下回调会被放大"]
        ),
        followUps: [
            FollowUp(label: "监控 funding 与 OI", condition: "funding 转极端或 OI 快速去化", suggestedSkillIDs: ["cmc-market-radar", "market-regime-review"])
        ],
        takeaway: "不靠猜：一条决定性价位 + 双向场景图。价位跌破、级联兑现——是看得见的结构在做决定，而非希望。"
    )

    static let macroSample = CMCStrategistResult(
        taskType: "macro_thesis_review",
        title: "BTC 宏观做空 thesis：流出仍在，但反证增多",
        verdict: "空头逻辑尚未失效，但 LTH 增持与稳定币流动性构成反证，转为观察。",
        confidence: 0.54,
        dataFreshness: "fixture",
        decisionProblem: "BTC 已连续两周被 ETF 抽走机构资金，但美股科技在拉升、加密通常跟随 risk-on。我信这股「流血」去做空，还是尊重涨势按兵不动？",
        subject: Subject(symbol: "BTC", name: "Bitcoin", instrument: "macro", directionContext: "short_thesis_watch"),
        candidateSignals: [
            Signal(label: "ETF 流出", value: "近 5 日净流出 $480M", interpretation: "机构需求转弱，支持空头。"),
            Signal(label: "跨资产", value: "BTC/Nasdaq 相关性下降", interpretation: "risk-on beta 失效，独立走弱。")
        ],
        keyLevels: [
            KeyLevel(label: "Thesis 失效价", price: 72000, role: "invalidation", condition: "收复并站稳则 thesis 失效")
        ],
        scenarios: [
            Scenario(id: "A", label: "流出延续", ifCondition: "ETF 持续净流出且无 LTH 接力", thenOutcome: "空头逻辑增强", bias: "bearish", confidence: 0.5, triggered: true),
            Scenario(id: "B", label: "反证占优", ifCondition: "LTH 加速增持 + 稳定币流动性回升", thenOutcome: "thesis 转中性，需重评", bias: "cautious", confidence: 0.5)
        ],
        counterEvidence: [
            CounterEvidence(label: "LTH 增持", detail: "长期持有者地址持续增持，吸收抛压", severity: "high"),
            CounterEvidence(label: "稳定币流动性", detail: "稳定币供应回升，潜在买盘待命", severity: "medium")
        ],
        sourceMap: [
            SourceRef(label: "ETF / AUM 证据", artifactPath: "runtime/agent/runs/{runID}/cmc-macro_flow_review.json", freshness: "fixture", provider: "fixtureProvider")
        ],
        riskBoundary: RiskBoundary(
            tradeInstruction: "blocked",
            summary: "仅做宏观决策支持与监控，不生成做空、对冲或杠杆指令。",
            warnings: ["宏观事件可能快速逆转流向", "缺少实时链上数据时标记为 data_gap"]
        ),
        followUps: [
            FollowUp(label: "监控 ETF 流与 LTH", condition: "未来 72h ETF 转净流入或 LTH 停止增持", suggestedSkillIDs: ["cmc-market-radar", "market-regime-review"])
        ],
        takeaway: "做空 melt-up 靠证据不靠胆量：实时看着基本面恶化（流出累积、AUM 下降、与科技脱钩），并正面回应黄金反证——这就是「持有数据支撑的 thesis」与「被涨势吓退」的区别。"
    )

    static func sample(for taskType: StrategistTaskType) -> CMCStrategistResult {
        switch taskType {
        case .perpTradeReview: return perpSample
        case .macroThesisReview: return macroSample
        default: return alphaSample
        }
    }
}
