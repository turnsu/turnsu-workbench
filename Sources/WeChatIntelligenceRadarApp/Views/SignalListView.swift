import SwiftUI

struct SignalListView: View {
    let messages: [IntelligenceMessage]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            PanelHeader(icon: "radar", title: "最值得关注", trailing: "\(messages.count) 条高信号")

            VStack(spacing: 0) {
                ForEach(Array(messages.enumerated()), id: \.element.id) { index, message in
                    SignalRow(index: index + 1, message: message)
                    if index != messages.count - 1 {
                        Divider().overlay(RadarTheme.borderSoft)
                    }
                }
            }
        }
        .padding(14)
        .radarPanel()
    }
}

private struct SignalRow: View {
    let index: Int
    let message: IntelligenceMessage

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Text("\(index)")
                .font(.system(size: 10, weight: .bold, design: .monospaced))
                .foregroundStyle(RadarTheme.mutedText)
                .frame(width: 16)

            VStack(alignment: .leading, spacing: 6) {
                Text(message.title)
                    .font(.system(size: 12, weight: .semibold))
                    .lineLimit(1)
                    .foregroundStyle(RadarTheme.primaryText)

                HStack(spacing: 6) {
                    Text(message.groupName)
                    Text(message.sender)
                    Text(message.timestamp)
                }
                .font(.system(size: 10))
                .foregroundStyle(RadarTheme.mutedText)

                HStack(spacing: 5) {
                    ForEach(message.tags) { tag in
                        TagPill(tag: tag)
                    }
                }
            }

            Spacer()

            VStack(alignment: .trailing, spacing: 8) {
                Text("\(message.weight)")
                    .font(.system(size: 11, weight: .bold, design: .monospaced))
                    .foregroundStyle(RadarTheme.secondaryText)
                Image(systemName: "arrow.up.right.square")
                    .font(.system(size: 10))
                    .foregroundStyle(RadarTheme.mutedText)
            }
        }
        .padding(.vertical, 10)
    }
}

struct TagPill: View {
    let tag: SignalTag

    var color: Color {
        switch tag.style {
        case .product:
            return RadarTheme.green
        case .demand:
            return RadarTheme.gold
        case .link:
            return RadarTheme.blue
        case .action:
            return Color(hex: 0x9AF0C8)
        case .risk:
            return RadarTheme.red
        case .web3:
            return RadarTheme.blue
        }
    }

    var body: some View {
        Text(tag.label)
            .font(.system(size: 10, weight: .medium))
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(color.opacity(0.16))
            .foregroundStyle(color)
            .clipShape(RoundedRectangle(cornerRadius: 4))
    }
}
