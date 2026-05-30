import SwiftUI

struct ActionItemsView: View {
    let actions: [ActionItem]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            PanelHeader(icon: "scope", title: "可行动项", trailing: "\(actions.count) 个可跟进")

            VStack(spacing: 10) {
                ForEach(actions) { action in
                    VStack(alignment: .leading, spacing: 7) {
                        HStack {
                            Text(action.category)
                                .font(.system(size: 10, weight: .semibold))
                                .padding(.horizontal, 7)
                                .padding(.vertical, 4)
                                .background(RadarTheme.gold.opacity(0.16))
                                .foregroundStyle(RadarTheme.gold)
                                .clipShape(RoundedRectangle(cornerRadius: 4))
                            Spacer()
                            Text(action.dueTime)
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundStyle(RadarTheme.mutedText)
                        }

                        Text(action.title)
                            .font(.system(size: 12, weight: .semibold))
                            .lineLimit(2)
                            .foregroundStyle(RadarTheme.primaryText)

                        Text(action.detail)
                            .font(.system(size: 10))
                            .lineLimit(1)
                            .foregroundStyle(RadarTheme.secondaryText)
                    }
                    .padding(11)
                    .background(RadarTheme.panelElevated.opacity(0.7))
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                }
            }
        }
        .padding(14)
        .radarPanel()
    }
}
