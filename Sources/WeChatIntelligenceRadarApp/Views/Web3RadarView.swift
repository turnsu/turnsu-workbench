import SwiftUI

struct Web3RadarView: View {
    let web3: Web3Snapshot

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            VStack(alignment: .leading, spacing: 10) {
                PanelHeader(icon: "chart.line.uptrend.xyaxis", title: "链上与行情雷达", trailing: "CMC \(RuntimeStatusPresenter.label(web3.sourceStatus)) · \(RuntimeStatusPresenter.label(web3.market.freshness))")
                Text(web3.note)
                    .font(.system(size: 11))
                    .foregroundStyle(RadarTheme.secondaryText)
                    .lineLimit(2)
                Text("最近验证 \(web3.market.lastVerifiedAt) · 有效期至 \(web3.market.expiresAt)")
                    .font(.system(size: 9))
                    .foregroundStyle(RadarTheme.mutedText)
                    .lineLimit(1)

                HStack(spacing: 7) {
                    ForEach(web3.detectedSymbols, id: \.self) { symbol in
                        Text(symbol)
                            .font(.system(size: 10, weight: .bold, design: .monospaced))
                            .foregroundStyle(RadarTheme.blue)
                            .researchCapsule()
                    }
                    if web3.detectedSymbols.isEmpty {
                        Text("暂无 Token")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(RadarTheme.mutedText)
                    }
                }
            }
            .frame(width: 260, alignment: .leading)

            VStack(alignment: .leading, spacing: 8) {
                Text("市场概况")
                    .font(.system(size: 9, weight: .bold, design: .monospaced))
                    .tracking(1.2)
                    .foregroundStyle(RadarTheme.mutedText)

                HStack(spacing: 8) {
                    ForEach(web3.market.assets.prefix(3)) { asset in
                        VStack(alignment: .leading, spacing: 5) {
                            HStack {
                                Text(asset.symbol)
                                    .font(.system(size: 12, weight: .bold, design: .monospaced))
                                Spacer()
                                Text(asset.isLive ? "实时" : "示例")
                                    .font(.system(size: 8, weight: .bold))
                                    .foregroundStyle(asset.isLive ? RadarTheme.green : RadarTheme.gold)
                            }
                            Text(formatPrice(asset.priceUSD))
                                .font(.system(size: 14, weight: .semibold, design: .rounded))
                                .foregroundStyle(RadarTheme.primaryText)
                            Text("24h \(formatPercent(asset.percentChange24h))")
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundStyle(asset.percentChange24h >= 0 ? RadarTheme.green : RadarTheme.red)
                        }
                        .padding(10)
                        .frame(width: 116, alignment: .leading)
                        .background(RadarTheme.panelElevated)
                        .researchPanel()
                    }
                }
            }

            VStack(alignment: .leading, spacing: 8) {
                Text("关联微信群")
                    .font(.system(size: 9, weight: .bold, design: .monospaced))
                    .tracking(1.2)
                    .foregroundStyle(RadarTheme.mutedText)
                ForEach(web3.enrichments.prefix(3)) { enrichment in
                    HStack(spacing: 8) {
                        Text(enrichment.symbol)
                            .font(.system(size: 10, weight: .bold, design: .monospaced))
                            .foregroundStyle(RadarTheme.blue)
                            .frame(width: 28, alignment: .leading)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(enrichment.groupName)
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(RadarTheme.primaryText)
                                .lineLimit(1)
                            Text(enrichment.marketContext)
                                .font(.system(size: 10))
                                .foregroundStyle(RadarTheme.secondaryText)
                                .lineLimit(1)
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(14)
        .frame(minHeight: 118)
        .radarPanel()
    }

    private func formatPrice(_ value: Double) -> String {
        if value >= 1_000 {
            return "$\(String(format: "%.0f", value))"
        }
        return "$\(String(format: "%.2f", value))"
    }

    private func formatPercent(_ value: Double) -> String {
        let sign = value >= 0 ? "+" : ""
        return "\(sign)\(String(format: "%.2f", value))%"
    }
}
