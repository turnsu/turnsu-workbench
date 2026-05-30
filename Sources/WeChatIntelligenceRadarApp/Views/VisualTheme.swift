import SwiftUI

extension Color {
    init(hex: UInt, opacity: Double = 1) {
        let red = Double((hex >> 16) & 0xFF) / 255.0
        let green = Double((hex >> 8) & 0xFF) / 255.0
        let blue = Double(hex & 0xFF) / 255.0
        self.init(.sRGB, red: red, green: green, blue: blue, opacity: opacity)
    }
}

enum RadarTheme {
    static let background = Color(hex: 0x101114)
    static let backgroundDeep = Color(hex: 0x08090B)
    static let cyanBase = Color(hex: 0x1E2A31)
    static let purpleBase = Color(hex: 0x23232B)
    static let sidebar = Color(hex: 0x15161A, opacity: 0.86)
    static let panel = Color(hex: 0x1B1C20, opacity: 0.68)
    static let panelElevated = Color(hex: 0x25262B, opacity: 0.70)
    static let panelWash = Color(hex: 0x2C2D33, opacity: 0.30)
    static let border = Color.white.opacity(0.12)
    static let borderSoft = Color.white.opacity(0.08)
    static let borderPurple = Color.white.opacity(0.06)
    static let primaryText = Color(hex: 0xF5F5F7)
    static let secondaryText = Color(hex: 0xB8BBC2)
    static let mutedText = Color(hex: 0x787D86)
    static let green = Color(hex: 0x34C759)
    static let gold = Color(hex: 0xE7BD58)
    static let blue = Color(hex: 0x0A84FF)
    static let violet = Color(hex: 0xBF5AF2)
    static let red = Color(hex: 0xFF453A)
    static let positive = Color(hex: 0x30D158)
    static let negative = Color(hex: 0xFF453A)

    static let accentGradient = LinearGradient(
        colors: [Color(hex: 0x0A84FF), Color(hex: 0x64D2FF)],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )

    static let heroGradient = LinearGradient(
        colors: [
            Color.white.opacity(0.08),
            Color.white.opacity(0.035),
            Color(hex: 0x0A84FF, opacity: 0.08)
        ],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )
}

struct PanelModifier: ViewModifier {
    var glow: Bool = false

    func body(content: Content) -> some View {
        content
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(RadarTheme.panel)
                    .background(
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .fill(.ultraThinMaterial)
                            .opacity(0.34)
                    )
            )
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(glow ? RadarTheme.blue.opacity(0.26) : RadarTheme.border, lineWidth: 1)
            )
            .shadow(color: .black.opacity(glow ? 0.18 : 0.12), radius: glow ? 18 : 10, x: 0, y: 8)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

extension View {
    func radarPanel() -> some View {
        modifier(PanelModifier())
    }

    func researchPanel(glow: Bool = false) -> some View {
        modifier(PanelModifier(glow: glow))
    }

    func researchCapsule(active: Bool = false) -> some View {
        padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(active ? RadarTheme.blue.opacity(0.16) : Color.white.opacity(0.055))
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(active ? RadarTheme.blue.opacity(0.35) : RadarTheme.borderSoft, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

struct ResearchOSBackground: View {
    var body: some View {
        ZStack {
            LinearGradient(
                colors: [
                    RadarTheme.background,
                    RadarTheme.backgroundDeep
                ],
                startPoint: .bottomLeading,
                endPoint: .topTrailing
            )
            LinearGradient(
                colors: [
                    Color.white.opacity(0.045),
                    .clear
                ],
                startPoint: .top,
                endPoint: .bottom
            )
        }
        .ignoresSafeArea()
    }
}

private struct ResearchGrid: View {
    var body: some View {
        Canvas { context, size in
            var path = Path()
            let step: CGFloat = 56
            var x: CGFloat = 0
            while x <= size.width {
                path.move(to: CGPoint(x: x, y: 0))
                path.addLine(to: CGPoint(x: x, y: size.height))
                x += step
            }
            var y: CGFloat = 0
            while y <= size.height {
                path.move(to: CGPoint(x: 0, y: y))
                path.addLine(to: CGPoint(x: size.width, y: y))
                y += step
            }
            context.stroke(path, with: .color(RadarTheme.borderSoft), lineWidth: 0.7)
        }
    }
}

struct ResearchSectionEyebrow: View {
    let text: String
    var icon: String = "sparkle"

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 9, weight: .semibold))
            Text(text.uppercased())
                .font(.system(size: 9, weight: .bold, design: .monospaced))
                .tracking(1.7)
        }
        .foregroundStyle(RadarTheme.blue)
    }
}

struct ResearchStatusChip: View {
    let label: String
    var icon: String? = nil
    var color: Color = RadarTheme.green

    var body: some View {
        HStack(spacing: 6) {
            if let icon {
                Image(systemName: icon)
                    .font(.system(size: 9, weight: .semibold))
            }
            Text(label)
                .font(.system(size: 10, weight: .semibold))
                .lineLimit(1)
        }
        .foregroundStyle(color)
        .researchCapsule()
    }
}

struct ResearchScoreBar: View {
    let value: Double
    var color: Color = RadarTheme.green

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule()
                    .fill(RadarTheme.borderSoft)
                Capsule()
                    .fill(
                        LinearGradient(
                            colors: [RadarTheme.violet, color],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                    )
                    .frame(width: max(8, proxy.size.width * min(max(value, 0), 1)))
            }
        }
        .frame(height: 4)
    }
}

struct ResearchSparkline: View {
    let values: [Double]
    var color: Color = RadarTheme.green

    var body: some View {
        GeometryReader { proxy in
            let normalized = normalize(values)
            Path { path in
                guard normalized.count > 1 else { return }
                for index in normalized.indices {
                    let x = proxy.size.width * CGFloat(index) / CGFloat(max(normalized.count - 1, 1))
                    let y = proxy.size.height * CGFloat(1 - normalized[index])
                    if index == normalized.startIndex {
                        path.move(to: CGPoint(x: x, y: y))
                    } else {
                        path.addLine(to: CGPoint(x: x, y: y))
                    }
                }
            }
            .stroke(color, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
        }
        .frame(height: 28)
    }

    private func normalize(_ input: [Double]) -> [Double] {
        guard let min = input.min(), let max = input.max(), max > min else {
            return input.map { _ in 0.5 }
        }
        return input.map { ($0 - min) / (max - min) }
    }
}

struct ResearchPrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: .bold))
            .foregroundStyle(.white)
            .padding(.horizontal, 15)
            .padding(.vertical, 10)
            .background(RadarTheme.blue.opacity(configuration.isPressed ? 0.78 : 1))
            .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
            .shadow(color: .black.opacity(configuration.isPressed ? 0.08 : 0.16), radius: configuration.isPressed ? 4 : 10, x: 0, y: 4)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
    }
}

struct ResearchSecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(RadarTheme.primaryText)
            .padding(.horizontal, 13)
            .padding(.vertical, 9)
            .background(Color.white.opacity(configuration.isPressed ? 0.10 : 0.065))
            .overlay(
                RoundedRectangle(cornerRadius: 11, style: .continuous)
                    .stroke(RadarTheme.borderSoft, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
    }
}

struct WorkspaceSurface<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        content
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.ultraThinMaterial)
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(RadarTheme.border, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

struct StatusDot: View {
    var color: Color = RadarTheme.green
    var size: CGFloat = 7

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: size, height: size)
    }
}
