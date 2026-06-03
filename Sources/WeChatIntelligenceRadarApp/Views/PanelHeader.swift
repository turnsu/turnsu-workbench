import SwiftUI

struct PanelHeader: View {
    let icon: String
    let title: String
    let trailing: String
    var tint: Color = RadarTheme.blue

    var body: some View {
        HStack(spacing: 10) {
            IconChip(systemName: icon, tint: tint, size: 28)
            Text(title)
                .font(RadarFont.text(14.5, .semibold))
                .foregroundStyle(RadarTheme.primaryText)
                .lineLimit(1)
            Spacer(minLength: 8)
            if !trailing.isEmpty {
                Text(trailing)
                    .font(.system(size: 11, weight: .semibold, design: .rounded))
                    .foregroundStyle(RadarTheme.secondaryText)
                    .lineLimit(1)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(RadarTheme.tintSoft)
                    .clipShape(Capsule())
            }
        }
    }
}
