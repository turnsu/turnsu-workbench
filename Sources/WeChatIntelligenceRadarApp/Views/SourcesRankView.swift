import SwiftUI

struct SourcesRankView: View {
    let sources: [SourceRank]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            PanelHeader(icon: "person.2.wave.2", title: "情报源", trailing: "\(sources.count) 人")

            VStack(spacing: 11) {
                ForEach(Array(sources.enumerated()), id: \.element.id) { index, source in
                    HStack(alignment: .top, spacing: 10) {
                        Text("\(index + 1)")
                            .font(.system(size: 10, weight: .bold, design: .monospaced))
                            .foregroundStyle(RadarTheme.mutedText)
                            .frame(width: 14)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(source.name)
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(RadarTheme.primaryText)
                                .lineLimit(1)
                            Text(source.context)
                                .font(.system(size: 10))
                                .foregroundStyle(RadarTheme.mutedText)
                                .lineLimit(1)
                        }
                        Spacer()
                        VStack(alignment: .trailing, spacing: 3) {
                            Text("\(source.score)")
                                .font(.system(size: 13, weight: .bold, design: .rounded))
                                .foregroundStyle(RadarTheme.green)
                            Text("\(source.hits) 群")
                                .font(.system(size: 9))
                                .foregroundStyle(RadarTheme.mutedText)
                        }
                    }
                }
            }
        }
        .padding(14)
        .radarPanel()
    }
}
