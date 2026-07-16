import SwiftUI
import Charts

// MARK: - Extracted signal model

struct AssetSignal: Identifiable, Equatable {
    let id = UUID()
    let symbol: String
    let confidence: Double      // 0...1
}

struct ChangeSignal: Identifiable, Equatable {
    let id = UUID()
    let label: String           // subject if found, else "市场"
    let percent: Double         // signed
}

enum FreshnessKind: String { case fresh, degraded, stale }

struct AgentSignalDigest: Equatable {
    var assets: [AssetSignal] = []
    var changes: [ChangeSignal] = []
    var freshness: [FreshnessKind] = []

    var isEmpty: Bool { assets.isEmpty && changes.isEmpty && freshness.isEmpty }
}

// MARK: - Extractor

/// Pulls lightweight structured signals out of free-form agent prose. Deliberately conservative:
/// when a pattern isn't clearly present it returns nothing, so the UI degrades to markdown only.
/// This is the front-end-parse path — never authoritative, purely a readability aid.
enum AgentSignalExtractor {
    /// Common crypto tickers we trust as asset symbols (avoids matching AI/ETF/DEX/L2 as tokens).
    private static let knownSymbols: Set<String> = [
        "BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "ADA", "AVAX", "LINK", "MATIC",
        "ARB", "OP", "SUI", "TON", "PEPE", "RNDR", "WIF", "BONK", "TIA", "SEI",
        "APT", "NEAR", "INJ", "FET", "RUNE", "LDO", "UNI", "AAVE", "DOT", "ATOM"
    ]

    static func extract(from text: String) -> AgentSignalDigest {
        guard !text.isEmpty else { return AgentSignalDigest() }
        var digest = AgentSignalDigest()
        digest.assets = extractAssets(text)
        digest.changes = extractChanges(text)
        digest.freshness = extractFreshness(text)
        return digest
    }

    // Pair each "置信度 X.XX" with the nearest preceding asset symbol.
    private static func extractAssets(_ text: String) -> [AssetSignal] {
        let ns = text as NSString
        let symbolHits = symbolOccurrences(text)           // [(range.location, symbol)]
        guard !symbolHits.isEmpty else { return [] }

        var seen = Set<String>()
        var result: [AssetSignal] = []
        let pattern = "(?:置信度|可信度|confidence)\\s*[:：]?\\s*([01]?\\.[0-9]{1,2})"
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return [] }
        for match in regex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            guard match.numberOfRanges > 1 else { continue }
            let valueStr = ns.substring(with: match.range(at: 1))
            guard let value = Double(valueStr), value >= 0, value <= 1 else { continue }
            let loc = match.range.location
            // nearest symbol mentioned before this confidence value
            if let symbol = symbolHits.last(where: { $0.0 <= loc })?.1, !seen.contains(symbol) {
                seen.insert(symbol)
                result.append(AssetSignal(symbol: symbol, confidence: value))
            }
            if result.count >= 6 { break }
        }
        return result
    }

    private static func symbolOccurrences(_ text: String) -> [(Int, String)] {
        let ns = text as NSString
        var hits: [(Int, String)] = []
        // symbol:XYZ or XYZ—name or standalone known ticker
        let pattern = "(?:symbol[:：]\\s*)?\\b([A-Z]{2,6})\\b"
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
        for match in regex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            let sym = ns.substring(with: match.range(at: 1))
            if knownSymbols.contains(sym) { hits.append((match.range.location, sym)) }
        }
        return hits
    }

    private static func extractChanges(_ text: String) -> [ChangeSignal] {
        let ns = text as NSString
        var result: [ChangeSignal] = []
        // direction + number + %
        let pattern = "(上涨|上升|增长|涨|拉升|大涨|下跌|下降|回落|跌|大跌)\\s*([0-9]{1,3}(?:\\.[0-9]{1,2})?)\\s*%"
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
        let downs: Set<String> = ["下跌", "下降", "回落", "跌", "大跌"]
        for match in regex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            guard match.numberOfRanges > 2 else { continue }
            let dir = ns.substring(with: match.range(at: 1))
            guard let mag = Double(ns.substring(with: match.range(at: 2))) else { continue }
            let signed = downs.contains(dir) ? -mag : mag
            // try to grab a leading subject (symbol or short label) just before the match
            let label = leadingLabel(ns: ns, before: match.range.location) ?? "市场"
            result.append(ChangeSignal(label: label, percent: signed))
            if result.count >= 8 { break }
        }
        return result
    }

    private static func leadingLabel(ns: NSString, before loc: Int) -> String? {
        guard loc > 0 else { return nil }
        let start = max(0, loc - 12)
        let window = ns.substring(with: NSRange(location: start, length: loc - start))
        // last known symbol in the window
        if let regex = try? NSRegularExpression(pattern: "\\b([A-Z]{2,6})\\b") {
            let wns = window as NSString
            let matches = regex.matches(in: window, range: NSRange(location: 0, length: wns.length))
            if let last = matches.last {
                let sym = wns.substring(with: last.range(at: 1))
                if knownSymbols.contains(sym) { return sym }
            }
        }
        return nil
    }

    private static func extractFreshness(_ text: String) -> [FreshnessKind] {
        var kinds: [FreshnessKind] = []
        let lower = text.lowercased()
        if lower.contains("freshness:fresh") || lower.contains("freshness：fresh")
            || (lower.contains("fresh") && !lower.contains("freshness:degraded")) {
            kinds.append(.fresh)
        }
        if lower.contains("degraded") || text.contains("退化") || text.contains("降级") {
            kinds.append(.degraded)
        }
        if lower.contains("stale") || text.contains("过期") {
            kinds.append(.stale)
        }
        return kinds
    }
}

// MARK: - Digest view

/// Compact "signal at a glance" strip rendered ABOVE the markdown body. Shows asset confidence
/// rings, a change bar chart and freshness chips — only the parts that were actually extracted.
/// Renders nothing when the digest is empty (pure degradation to markdown).
struct AgentSignalDigestView: View {
    let digest: AgentSignalDigest

    var body: some View {
        if digest.isEmpty {
            EmptyView()
        } else {
            VStack(alignment: .leading, spacing: 10) {
                if !digest.assets.isEmpty { assetRow }
                if digest.changes.count >= 2 {
                    changeChart
                } else if !digest.changes.isEmpty {
                    changeChips
                }
                if !digest.freshness.isEmpty { freshnessRow }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RadarTheme.tintFaint)
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(RadarTheme.borderSoft, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
    }

    private var assetRow: some View {
        VStack(alignment: .leading, spacing: 7) {
            ResearchSectionEyebrow(text: "资产置信度", icon: "gauge.medium")
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 14) {
                    ForEach(digest.assets) { asset in
                        HStack(spacing: 8) {
                            ProgressRing(
                                value: asset.confidence,
                                size: 38,
                                lineWidth: 4,
                                label: "\(Int((asset.confidence * 100).rounded()))"
                            )
                            Text(asset.symbol)
                                .font(.system(size: 12, weight: .bold, design: .rounded))
                                .foregroundStyle(RadarTheme.primaryText)
                        }
                    }
                }
            }
        }
    }

    private var changeChart: some View {
        VStack(alignment: .leading, spacing: 7) {
            ResearchSectionEyebrow(text: "涨跌幅", icon: "chart.bar.fill")
            Chart(digest.changes) { change in
                BarMark(
                    x: .value("幅度", change.percent),
                    y: .value("标的", change.label)
                )
                .foregroundStyle(change.percent >= 0 ? RadarTheme.positive : RadarTheme.negative)
                .cornerRadius(3)
                .annotation(position: change.percent >= 0 ? .trailing : .leading) {
                    Text(String(format: "%+.1f%%", change.percent))
                        .font(.system(size: 9, weight: .semibold, design: .rounded))
                        .foregroundStyle(RadarTheme.secondaryText)
                }
            }
            .chartXAxis {
                AxisMarks(position: .bottom) {
                    AxisGridLine().foregroundStyle(RadarTheme.borderSoft)
                    AxisValueLabel().font(.system(size: 8))
                }
            }
            .chartYAxis {
                AxisMarks(position: .leading) {
                    AxisValueLabel().font(.system(size: 9))
                }
            }
            .frame(height: CGFloat(digest.changes.count) * 26 + 24)
        }
    }

    private var changeChips: some View {
        HStack(spacing: 8) {
            ForEach(digest.changes) { change in
                HStack(spacing: 5) {
                    Text(change.label)
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(RadarTheme.secondaryText)
                    TrendChip(change: change.percent)
                }
            }
        }
    }

    private var freshnessRow: some View {
        HStack(spacing: 6) {
            ForEach(Array(Set(digest.freshness.map(\.rawValue))).sorted(), id: \.self) { kind in
                freshnessChip(kind)
            }
        }
    }

    @ViewBuilder
    private func freshnessChip(_ raw: String) -> some View {
        let (label, color): (String, Color) = {
            switch raw {
            case "fresh": return ("数据新鲜", RadarTheme.green)
            case "degraded": return ("数据降级", RadarTheme.gold)
            case "stale": return ("数据过期", RadarTheme.red)
            default: return (raw, RadarTheme.secondaryText)
            }
        }()
        ResearchStatusChip(label: label, icon: "dot.radiowaves.left.and.right", color: color)
    }
}
