import SwiftUI

struct PanelHeader: View {
    let icon: String
    let title: String
    let trailing: String

    var body: some View {
        HStack {
            ResearchSectionEyebrow(text: title, icon: icon)
            Spacer()
            Text(trailing)
                .font(.system(size: 10, weight: .bold, design: .monospaced))
                .foregroundStyle(RadarTheme.mutedText)
                .lineLimit(1)
        }
    }
}
