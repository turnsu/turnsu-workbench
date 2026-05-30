import SwiftUI

struct BriefingNoteView: View {
    let note: BriefingNote
    let copyStatus: String
    let onCopy: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "target")
                .foregroundStyle(RadarTheme.green)
                .padding(.top, 2)

            VStack(alignment: .leading, spacing: 5) {
                Text("今日简报")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(RadarTheme.green)
                Text(note.title)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(RadarTheme.primaryText)
                Text("\(note.body) 生成时间：\(note.generatedAt)")
                    .font(.system(size: 12))
                    .lineLimit(2)
                    .foregroundStyle(RadarTheme.secondaryText)
            }

            Spacer()

            Button(action: onCopy) {
                Label(copyStatus, systemImage: "doc.on.doc")
                    .font(.system(size: 12, weight: .medium))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .background(RadarTheme.panelElevated)
                    .clipShape(RoundedRectangle(cornerRadius: 6))
            }
            .buttonStyle(.plain)
            .foregroundStyle(RadarTheme.secondaryText)
        }
        .padding(14)
        .radarPanel()
    }
}
