import SwiftUI

// MARK: - Strategy Result Card (rendered inline in the agent thread)

/// Scannable decision-support card for a `CMCStrategistResult`: verdict, key levels, scenarios,
/// counter-evidence and a always-present risk boundary. Tapping opens the inspector for full
/// evidence / audit. Never renders trade instructions.
struct StrategyResultCard: View {
    let result: CMCStrategistResult

    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            header
            if let problem = result.decisionProblem, !problem.isEmpty {
                decisionProblemBox(problem)
            }
            verdict
            scanStrip

            if !result.candidateSignals.isEmpty {
                signalGrid
            }
            if !result.keyLevels.isEmpty {
                KeyLevelsView(levels: result.keyLevels)
            }
            if !result.scenarios.isEmpty {
                ScenarioMapView(scenarios: result.scenarios)
            }
            if !result.counterEvidence.isEmpty {
                CounterEvidenceView(items: result.counterEvidence)
            }

            RiskBoundaryView(boundary: result.riskBoundary)
            trustline

            if let takeaway = result.takeaway, !takeaway.isEmpty {
                takeawayBlock(takeaway)
            }

            footer
        }
        .padding(15)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(RadarTheme.panelElevated)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(RadarTheme.blue.opacity(0.28), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .shadow(color: RadarTheme.cardShadow.opacity(0.7), radius: 12, x: 0, y: 6)
    }

    private var header: some View {
        HStack(spacing: 11) {
            IconChip(systemName: result.kind.icon, tint: RadarTheme.blue, size: 34, gradient: RadarTheme.brandGradient)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(result.subject.symbol)
                        .font(RadarFont.display(15, .bold))
                        .foregroundStyle(RadarTheme.primaryText)
                    if let name = result.subject.name {
                        Text(name)
                            .font(.system(size: 11))
                            .foregroundStyle(RadarTheme.mutedText)
                            .lineLimit(1)
                    }
                }
                HStack(spacing: 6) {
                    StrategyTag(text: result.kind.label, color: RadarTheme.blue)
                    FreshnessTag(freshness: result.dataFreshness)
                }
            }
            Spacer(minLength: 6)
            ProgressRing(value: result.confidence, size: 44, lineWidth: 4.5, label: "\(Int((result.confidence * 100).rounded()))")
        }
    }

    private var verdict: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "checkmark.seal.fill")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(RadarTheme.blue)
                .padding(.top, 1)
            Text(result.verdict)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(RadarTheme.primaryText)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RadarTheme.blue.opacity(0.10))
        .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
    }

    private var scanStrip: some View {
        HStack(spacing: 8) {
            StrategyStat(icon: "hourglass", label: "等待", value: waitText, tint: RadarTheme.gold)
            StrategyStat(icon: "checkmark.circle", label: "支持", value: "\(result.candidateSignals.count) 项", tint: RadarTheme.positive)
            StrategyStat(icon: "exclamationmark.triangle", label: "反对", value: "\(result.counterEvidence.count) 项", tint: RadarTheme.negative)
        }
    }

    private var waitText: String {
        if let level = result.keyLevels.first(where: { $0.role.contains("wait") || $0.role.contains("entry") }) {
            return level.label
        }
        return result.followUps.first?.label ?? "触发条件"
    }

    private func decisionProblemBox(_ problem: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text("决策问题")
                .font(.system(size: 10, weight: .bold))
                .tracking(0.6)
                .foregroundStyle(RadarTheme.blue)
            Text(problem)
                .font(.system(size: 13))
                .foregroundStyle(RadarTheme.primaryText)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RadarTheme.blue.opacity(0.07))
        .overlay(RoundedRectangle(cornerRadius: 11, style: .continuous).strokeBorder(RadarTheme.blue.opacity(0.25), lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
    }

    private var signalGrid: some View {
        StrategySection(title: "数据信号", icon: "waveform.path.ecg") {
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)], spacing: 8) {
                ForEach(result.candidateSignals) { signal in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(signal.label)
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(RadarTheme.mutedText)
                            .lineLimit(1)
                        Text(signal.value)
                            .font(.system(size: 12.5, weight: .semibold, design: .monospaced))
                            .foregroundStyle(RadarTheme.primaryText)
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                        if !signal.interpretation.isEmpty {
                            Text(signal.interpretation)
                                .font(.system(size: 10.5))
                                .foregroundStyle(RadarTheme.secondaryText)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RadarTheme.tintFaint)
                    .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(RadarTheme.borderSoft, lineWidth: 1))
                    .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                }
            }
        }
    }

    private var trustline: some View {
        HStack(spacing: 6) {
            ForEach(trustItems, id: \.self) { item in
                HStack(spacing: 4) {
                    Image(systemName: "checkmark.seal.fill").font(.system(size: 8.5, weight: .bold))
                    Text(item).font(.system(size: 9.5, weight: .medium)).lineLimit(1)
                }
                .foregroundStyle(RadarTheme.green)
                .padding(.horizontal, 7)
                .padding(.vertical, 3)
                .background(RadarTheme.green.opacity(0.10))
                .clipShape(Capsule())
            }
            Spacer(minLength: 0)
        }
    }

    private var trustItems: [String] {
        var items = ["仅决策支持 · 非投资建议"]
        if let p = result.sourceMap.first?.provider, !p.isEmpty { items.insert("来源已标注 · \(p)", at: 0) }
        if result.riskBoundary.tradeInstruction == "blocked" { items.append("交易指令已阻断") }
        return items
    }

    private func takeawayBlock(_ takeaway: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text("决策支持价值")
                .font(.system(size: 10, weight: .bold))
                .tracking(0.6)
                .foregroundStyle(RadarTheme.green)
            Text(takeaway)
                .font(.system(size: 12.5))
                .foregroundStyle(RadarTheme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.top, 11)
        .overlay(alignment: .top) {
            Rectangle().fill(RadarTheme.borderSoft).frame(height: 1)
        }
    }

    private var footer: some View {
        HStack(spacing: 8) {
            if let source = result.sourceMap.first {
                Label("\(source.provider) · \(FreshnessTag.label(source.freshness))", systemImage: "doc.text.magnifyingglass")
                    .font(.system(size: 10))
                    .foregroundStyle(RadarTheme.mutedText)
                    .lineLimit(1)
            }
            Spacer()
        }
    }
}

// MARK: - Key Levels

struct KeyLevelsView: View {
    let levels: [CMCStrategistResult.KeyLevel]

    var body: some View {
        StrategySection(title: "关键价位", icon: "ruler") {
            VStack(spacing: 6) {
                ForEach(levels) { level in
                    HStack(spacing: 9) {
                        Circle().fill(roleColor(level.role)).frame(width: 7, height: 7)
                        Text(level.label)
                            .font(.system(size: 11.5, weight: .semibold))
                            .foregroundStyle(RadarTheme.primaryText)
                        Spacer()
                        Text(priceText(level))
                            .font(.system(size: 11.5, weight: .semibold, design: .monospaced))
                            .foregroundStyle(RadarTheme.primaryText)
                    }
                    if let condition = level.condition {
                        Text(condition)
                            .font(.system(size: 10))
                            .foregroundStyle(RadarTheme.secondaryText)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
    }

    private func priceText(_ level: CMCStrategistResult.KeyLevel) -> String {
        guard let price = level.price else { return "条件触发" }
        if let upper = level.upperPrice {
            return "\(fmt(price)) – \(fmt(upper))"
        }
        return fmt(price)
    }

    private func fmt(_ v: Double) -> String {
        v >= 100 ? String(format: "%.0f", v) : String(format: "%g", v)
    }

    private func roleColor(_ role: String) -> Color {
        if role.contains("invalidation") { return RadarTheme.negative }
        if role.contains("wait") || role.contains("entry") { return RadarTheme.gold }
        if role.contains("take_profit") { return RadarTheme.positive }
        return RadarTheme.blue
    }
}

// MARK: - Scenario Map

struct ScenarioMapView: View {
    let scenarios: [CMCStrategistResult.Scenario]

    var body: some View {
        StrategySection(title: "场景图", icon: "arrow.triangle.branch") {
            VStack(spacing: 7) {
                ForEach(scenarios) { scenario in
                    HStack(alignment: .top, spacing: 9) {
                        Text(scenario.id)
                            .font(.system(size: 11, weight: .bold, design: .rounded))
                            .foregroundStyle(.white)
                            .frame(width: 20, height: 20)
                            .background(Circle().fill(scenario.triggered ? RadarTheme.green : biasColor(scenario.bias)))
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 6) {
                                Text(scenario.label)
                                    .font(.system(size: 11.5, weight: .semibold))
                                    .foregroundStyle(RadarTheme.primaryText)
                                if scenario.triggered {
                                    Text("▶ 已发生")
                                        .font(.system(size: 8.5, weight: .bold))
                                        .foregroundStyle(.white)
                                        .padding(.horizontal, 5)
                                        .padding(.vertical, 1.5)
                                        .background(RadarTheme.green)
                                        .clipShape(Capsule())
                                }
                                Spacer()
                                if let c = scenario.confidence {
                                    Text("\(Int((c * 100).rounded()))%")
                                        .font(.system(size: 10, weight: .semibold, design: .rounded))
                                        .foregroundStyle(scenario.triggered ? RadarTheme.green : biasColor(scenario.bias))
                                }
                            }
                            Text("若 \(scenario.ifCondition)")
                                .font(.system(size: 10.5))
                                .foregroundStyle(RadarTheme.secondaryText)
                                .fixedSize(horizontal: false, vertical: true)
                            Text("则 \(scenario.thenOutcome)")
                                .font(.system(size: 10.5))
                                .foregroundStyle(RadarTheme.mutedText)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .padding(scenario.triggered ? 8 : 0)
                    .background(scenario.triggered ? RadarTheme.green.opacity(0.08) : Color.clear)
                    .overlay(scenario.triggered ? RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(RadarTheme.green.opacity(0.4), lineWidth: 1) : nil)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
            }
        }
    }

    private func biasColor(_ bias: String) -> Color {
        switch bias {
        case "constructive", "bullish": return RadarTheme.positive
        case "bearish": return RadarTheme.negative
        case "cautious": return RadarTheme.gold
        default: return RadarTheme.secondaryText
        }
    }
}

// MARK: - Counter Evidence

struct CounterEvidenceView: View {
    let items: [CMCStrategistResult.CounterEvidence]

    var body: some View {
        StrategySection(title: "反证", icon: "exclamationmark.bubble") {
            VStack(spacing: 6) {
                ForEach(items) { item in
                    HStack(alignment: .top, spacing: 9) {
                        Circle().fill(severityColor(item.severity)).frame(width: 7, height: 7).padding(.top, 4)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(item.label)
                                .font(.system(size: 11.5, weight: .semibold))
                                .foregroundStyle(RadarTheme.primaryText)
                            Text(item.detail)
                                .font(.system(size: 10.5))
                                .foregroundStyle(RadarTheme.secondaryText)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 0)
                    }
                }
            }
        }
    }

    private func severityColor(_ severity: String) -> Color {
        switch severity {
        case "high": return RadarTheme.negative
        case "medium": return RadarTheme.gold
        default: return RadarTheme.secondaryText
        }
    }
}

// MARK: - Risk Boundary

struct RiskBoundaryView: View {
    let boundary: CMCStrategistResult.RiskBoundary

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "hand.raised.fill")
                    .font(.system(size: 11, weight: .semibold))
                Text("风险边界 · 仅决策支持")
                    .font(.system(size: 11, weight: .semibold))
                Spacer()
                Text("交易指令 已阻断")
                    .font(.system(size: 9.5, weight: .bold))
                    .foregroundStyle(RadarTheme.negative)
            }
            .foregroundStyle(RadarTheme.gold)
            Text(boundary.summary)
                .font(.system(size: 10.5))
                .foregroundStyle(RadarTheme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(boundary.warnings, id: \.self) { warning in
                HStack(alignment: .top, spacing: 5) {
                    Text("•").foregroundStyle(RadarTheme.gold)
                    Text(warning)
                        .font(.system(size: 10))
                        .foregroundStyle(RadarTheme.mutedText)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RadarTheme.gold.opacity(0.10))
        .overlay(
            RoundedRectangle(cornerRadius: 11, style: .continuous)
                .strokeBorder(RadarTheme.gold.opacity(0.25), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
    }
}

// MARK: - Strategy Inspector (right panel detail)

struct StrategyInspectorView: View {
    let result: CMCStrategistResult

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            section("结论") {
                inspectorRow("任务", result.kind.label)
                inspectorRow("Subject", "\(result.subject.symbol)\(result.subject.name.map { " · \($0)" } ?? "")")
                inspectorRow("可信度", "\(Int((result.confidence * 100).rounded()))%")
                inspectorRow("数据", FreshnessTag.label(result.dataFreshness))
            }

            if !result.keyLevels.isEmpty {
                section("关键价位") {
                    ForEach(result.keyLevels) { level in
                        VStack(alignment: .leading, spacing: 1) {
                            inspectorRow(level.label, levelValue(level))
                            if let inv = level.invalidatesBelow {
                                Text("失效 < \(String(format: "%g", inv))")
                                    .font(.system(size: 9.5))
                                    .foregroundStyle(RadarTheme.negative)
                            }
                        }
                    }
                }
            }

            if !result.sourceMap.isEmpty {
                section("证据来源") {
                    ForEach(result.sourceMap) { source in
                        VStack(alignment: .leading, spacing: 1) {
                            Text(source.label)
                                .font(.system(size: 11, weight: .medium))
                                .foregroundStyle(RadarTheme.primaryText)
                            Text("\(source.provider) · \(FreshnessTag.label(source.freshness))")
                                .font(.system(size: 9.5))
                                .foregroundStyle(RadarTheme.secondaryText)
                            Text(source.artifactPath)
                                .font(.system(size: 9, design: .monospaced))
                                .foregroundStyle(RadarTheme.mutedText)
                                .lineLimit(1)
                                .textSelection(.enabled)
                        }
                    }
                }
            }

            if !result.followUps.isEmpty {
                section("后续观察") {
                    ForEach(result.followUps) { item in
                        VStack(alignment: .leading, spacing: 1) {
                            Text(item.label)
                                .font(.system(size: 11, weight: .medium))
                                .foregroundStyle(RadarTheme.primaryText)
                            Text(item.condition)
                                .font(.system(size: 9.5))
                                .foregroundStyle(RadarTheme.secondaryText)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }

            RiskBoundaryView(boundary: result.riskBoundary)
        }
    }

    private func levelValue(_ level: CMCStrategistResult.KeyLevel) -> String {
        guard let price = level.price else { return level.condition ?? "条件触发" }
        if let upper = level.upperPrice { return "\(String(format: "%g", price)) – \(String(format: "%g", upper))" }
        return String(format: "%g", price)
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            ResearchSectionEyebrow(text: title, icon: "square.text.square")
            content()
        }
        .padding(11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .researchPanel()
    }

    private func inspectorRow(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text(label)
                .font(.system(size: 10.5))
                .foregroundStyle(RadarTheme.mutedText)
                .frame(width: 64, alignment: .leading)
            Text(value)
                .font(.system(size: 10.5, weight: .medium))
                .foregroundStyle(RadarTheme.primaryText)
                .textSelection(.enabled)
            Spacer(minLength: 0)
        }
    }
}

// MARK: - Small shared helpers

private struct StrategySection<Content: View>: View {
    let title: String
    let icon: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 5) {
                Image(systemName: icon)
                    .font(.system(size: 9.5, weight: .semibold))
                    .foregroundStyle(RadarTheme.secondaryText)
                Text(title)
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundStyle(RadarTheme.secondaryText)
            }
            content
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RadarTheme.tintFaint)
        .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
    }
}

private struct StrategyStat: View {
    let icon: String
    let label: String
    let value: String
    let tint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 4) {
                Image(systemName: icon).font(.system(size: 9, weight: .semibold))
                Text(label).font(.system(size: 9.5, weight: .medium))
            }
            .foregroundStyle(tint)
            Text(value)
                .font(.system(size: 11.5, weight: .semibold))
                .foregroundStyle(RadarTheme.primaryText)
                .lineLimit(1)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tint.opacity(0.10))
        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
    }
}

private struct StrategyTag: View {
    let text: String
    let color: Color
    var body: some View {
        Text(text)
            .font(.system(size: 9.5, weight: .semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(color.opacity(0.14))
            .clipShape(Capsule())
    }
}

private struct FreshnessTag: View {
    let freshness: String
    var body: some View {
        let isFixture = freshness.lowercased().contains("fixture") || freshness.lowercased().contains("mock")
        let color = isFixture ? RadarTheme.gold : (freshness.lowercased().contains("fresh") ? RadarTheme.positive : RadarTheme.secondaryText)
        return Text(Self.label(freshness))
            .font(.system(size: 9.5, weight: .semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(color.opacity(0.14))
            .clipShape(Capsule())
    }

    static func label(_ raw: String) -> String {
        switch raw.lowercased() {
        case "fixture", "mock": return "样例数据"
        case "fresh", "current_run": return "新鲜"
        case "stale": return "可能过期"
        case "degraded": return "降级"
        case "blocked": return "已阻断"
        case "data_gap": return "数据缺口"
        default: return raw
        }
    }
}
