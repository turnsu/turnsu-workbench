import SwiftUI
import AppKit

extension Color {
    init(hex: UInt, opacity: Double = 1) {
        let red = Double((hex >> 16) & 0xFF) / 255.0
        let green = Double((hex >> 8) & 0xFF) / 255.0
        let blue = Double(hex & 0xFF) / 255.0
        self.init(.sRGB, red: red, green: green, blue: blue, opacity: opacity)
    }

    /// Appearance-adaptive color. Resolves `lightHex` under Aqua and `darkHex` under Dark Aqua,
    /// so a single token reads correctly in both system appearances.
    init(lightHex: UInt, darkHex: UInt, lightOpacity: Double = 1, darkOpacity: Double = 1) {
        let ns = NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            let hex = isDark ? darkHex : lightHex
            let opacity = isDark ? darkOpacity : lightOpacity
            let r = Double((hex >> 16) & 0xFF) / 255.0
            let g = Double((hex >> 8) & 0xFF) / 255.0
            let b = Double(hex & 0xFF) / 255.0
            return NSColor(srgbRed: r, green: g, blue: b, alpha: opacity)
        }
        self = Color(nsColor: ns)
    }
}

/// App typeface — native system UI. The workbench should feel like a durable macOS tool,
/// so labels, buttons and dense status text use SF through SwiftUI's system font stack.
enum RadarFont {
    static func display(_ size: CGFloat, _ weight: Font.Weight = .bold) -> Font {
        .system(size: size, weight: weight)
    }
    static func text(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight)
    }
}

enum RadarTheme {
    // Apple-minimal workbench: system-adaptive graphite surfaces, hairline separators and one
    // restrained blue accent. Dark mode is parity, not a separate black-gold identity.

    // Canvas — Light: bright cool-white. Dark: near-black metal, slightly lifted for depth.
    static let background = Color(lightHex: 0xF7F9FC, darkHex: 0x0D0E12)
    static let backgroundDeep = Color(lightHex: 0xEEF2F8, darkHex: 0x08090C)
    static let cyanBase = Color(lightHex: 0xEAF1FC, darkHex: 0x101820)
    static let purpleBase = Color(lightHex: 0xEEF1F8, darkHex: 0x14161C)

    // Surfaces — FLAT & opaque. White cards in Light; in Dark, lifted graphite so panels read
    // clearly ABOVE the canvas (the depth/contrast that was missing — no longer one flat slab).
    static let sidebar = Color(lightHex: 0xFFFFFF, darkHex: 0x16181E)
    static let panel = Color(lightHex: 0xFFFFFF, darkHex: 0x191B22)
    static let panelElevated = Color(lightHex: 0xFFFFFF, darkHex: 0x21242E)
    static let panelWash = Color(lightHex: 0xF1F4FA, darkHex: 0x23262F)

    static let border = Color(lightHex: 0x0F172A, darkHex: 0xFFFFFF, lightOpacity: 0.10, darkOpacity: 0.12)
    static let borderSoft = Color(lightHex: 0x0F172A, darkHex: 0xFFFFFF, lightOpacity: 0.06, darkOpacity: 0.08)
    static let borderStrong = Color(lightHex: 0x0F172A, darkHex: 0xFFFFFF, lightOpacity: 0.16, darkOpacity: 0.18)
    static let borderPurple = Color(lightHex: 0x0F172A, darkHex: 0xFFFFFF, lightOpacity: 0.06, darkOpacity: 0.08)

    static let tintFaint = Color(lightHex: 0x0F172A, darkHex: 0xFFFFFF, lightOpacity: 0.04, darkOpacity: 0.04)
    static let tintSoft = Color(lightHex: 0x0F172A, darkHex: 0xFFFFFF, lightOpacity: 0.06, darkOpacity: 0.06)
    static let tintMedium = Color(lightHex: 0x0F172A, darkHex: 0xFFFFFF, lightOpacity: 0.09, darkOpacity: 0.09)
    static let tintStrong = Color(lightHex: 0x0F172A, darkHex: 0xFFFFFF, lightOpacity: 0.13, darkOpacity: 0.13)

    // Text — higher contrast both ways. Light: deeper graphite. Dark: brighter warm-white,
    // FULLY OPAQUE (no alpha) so glyphs render crisp — fixes the "blurry / fatiguing" text.
    static let primaryText = Color(lightHex: 0x16181F, darkHex: 0xF4F6FA)
    static let secondaryText = Color(lightHex: 0x4B5563, darkHex: 0xB4BAC6)
    static let mutedText = Color(lightHex: 0x8A92A0, darkHex: 0x7E8795)

    static let blue = Color(lightHex: 0x2563EB, darkHex: 0x5EA0FF)
    static let cyan = Color(lightHex: 0x0EA5E9, darkHex: 0x64D2FF)
    static let indigo = Color(lightHex: 0x1D4ED8, darkHex: 0x8E8CFF)
    static let lime = Color(lightHex: 0x6FA84A, darkHex: 0x8FC56A)   // minor accent only
    static let ink = Color(hex: 0x0C1426)
    static let green = Color(lightHex: 0x15A34A, darkHex: 0x47CF88)  // positive / up
    static let gold = Color(lightHex: 0xB45309, darkHex: 0xE8A93F)
    static let violet = Color(lightHex: 0x4E6A9E, darkHex: 0xA78BFA)
    static let red = Color(lightHex: 0xDC2626, darkHex: 0xEE8579)    // negative / down
    static let positive = Color(lightHex: 0x15A34A, darkHex: 0x47CF88)
    static let negative = Color(lightHex: 0xDC2626, darkHex: 0xEE8579)

    static let brandGradient = LinearGradient(
        colors: [Color(lightHex: 0x2563EB, darkHex: 0x5EA0FF), Color(lightHex: 0x0EA5E9, darkHex: 0x64D2FF)],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )

    static let accentGradient = brandGradient

    static let ctaGradient = LinearGradient(
        colors: [Color(lightHex: 0x2563EB, darkHex: 0x5EA0FF), Color(lightHex: 0x2563EB, darkHex: 0x5EA0FF)],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )

    /// A *gentle* hero wash — present but quiet; no saturated slab.
    static let heroGradient = LinearGradient(
        colors: [
            Color(lightHex: 0x2563EB, darkHex: 0x5EA0FF, lightOpacity: 0.08, darkOpacity: 0.08),
            Color(lightHex: 0x0EA5E9, darkHex: 0x64D2FF, lightOpacity: 0.04, darkOpacity: 0.04),
            .clear
        ],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )

    /// Restrained ambient shadow — flat design uses ONE soft drop, kept tight.
    static let cardShadow = Color(lightHex: 0x1B2A4A, darkHex: 0x000000, lightOpacity: 0.08, darkOpacity: 0.45)
    /// Tight contact line directly under an element.
    static let contactShadow = Color(lightHex: 0x162542, darkHex: 0x000000, lightOpacity: 0.06, darkOpacity: 0.55)

    static let metalSheen = Color(lightHex: 0xFFFFFF, darkHex: 0xFFFFFF, lightOpacity: 0.0, darkOpacity: 0.08)
}

/// Flat surface recipe (was frosted glass). A near-opaque solid fill + an optional thin metal
/// highlight along the top edge. No backdrop blur, no plusLighter slabs — cheap to composite.
/// Signature kept (`material`, `sheen`) so call sites compile unchanged; `material` is ignored.
struct GlassSurface: View {
    var cornerRadius: CGFloat
    var material: Material
    var tint: Color
    var sheen: Double

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        shape
            .fill(tint)
            .overlay(
                // Thin brushed-metal lip — only visible in Dark (champagne), clear in Light.
                shape
                    .fill(LinearGradient(colors: [RadarTheme.metalSheen, .clear], startPoint: .top, endPoint: .center))
            )
    }
}

/// Centralized motion curves — one cohesive sense of physics across the app.
enum RadarMotion {
    static let spring = Animation.spring(response: 0.34, dampingFraction: 0.86)
    static let snappy = Animation.spring(response: 0.24, dampingFraction: 0.9)
    static let gentle = Animation.spring(response: 0.46, dampingFraction: 0.9)
    static let smooth = Animation.easeInOut(duration: 0.2)
}

struct PanelModifier: ViewModifier {
    var glow: Bool = false
    var cornerRadius: CGFloat = 16

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        content
            // Flat, near-opaque surface — no material, no blur. This is the main perf win.
            .background(GlassSurface(cornerRadius: cornerRadius, material: .thinMaterial, tint: RadarTheme.panel, sheen: 0))
            .overlay(
                shape.strokeBorder(glow ? RadarTheme.blue.opacity(0.40) : RadarTheme.border, lineWidth: 1)
            )
            .clipShape(shape)
            // Single restrained ambient shadow. `glow` accent surfaces lift slightly more.
            .shadow(color: RadarTheme.cardShadow.opacity(glow ? 0.9 : 0.6), radius: glow ? 14 : 8, x: 0, y: glow ? 6 : 4)
    }
}

extension View {
    func radarPanel(cornerRadius: CGFloat = 16) -> some View {
        modifier(PanelModifier(cornerRadius: cornerRadius))
    }

    func researchPanel(glow: Bool = false, cornerRadius: CGFloat = 16) -> some View {
        modifier(PanelModifier(glow: glow, cornerRadius: cornerRadius))
    }

    func researchCapsule(active: Bool = false) -> some View {
        padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(
                Capsule().fill(active ? RadarTheme.blue.opacity(0.16) : RadarTheme.tintFaint)
            )
            .overlay(
                Capsule().strokeBorder(active ? RadarTheme.blue.opacity(0.42) : RadarTheme.borderSoft, lineWidth: 1)
            )
            .clipShape(Capsule())
    }

    /// Tappable card with hover lift + clear selected state.
    func interactiveCard(selected: Bool = false, cornerRadius: CGFloat = 14, hoverScale: CGFloat = 1.0) -> some View {
        modifier(InteractiveCardModifier(selected: selected, cornerRadius: cornerRadius, hoverScale: hoverScale))
    }

    /// Lightweight list / nav row that warms on hover and fills when selected.
    func interactiveRow(selected: Bool = false, cornerRadius: CGFloat = 12) -> some View {
        modifier(InteractiveRowModifier(selected: selected, cornerRadius: cornerRadius))
    }

    /// Quiet list item — a flat, low-contrast well (NOT a floating card). Stays calm so a
    /// list reads as one surface; only the hovered / selected item gains color + a hairline.
    func quietRow(selected: Bool = false, cornerRadius: CGFloat = 12) -> some View {
        modifier(QuietRowModifier(selected: selected, cornerRadius: cornerRadius))
    }
}

struct QuietRowModifier: ViewModifier {
    var selected: Bool
    var cornerRadius: CGFloat
    @State private var hovering = false

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        content
            .background(
                shape.fill(
                    selected ? RadarTheme.blue.opacity(0.12)
                        : (hovering ? RadarTheme.tintSoft : Color.clear)
                )
            )
            .overlay(
                shape.strokeBorder(
                    selected ? RadarTheme.blue.opacity(0.45)
                        : (hovering ? RadarTheme.borderSoft : Color.clear),
                    lineWidth: 1
                )
            )
            .clipShape(shape)
            .animation(RadarMotion.snappy, value: hovering)
            .animation(RadarMotion.spring, value: selected)
            .onHover { hovering = $0 }
    }
}

struct InteractiveCardModifier: ViewModifier {
    var selected: Bool
    var cornerRadius: CGFloat
    var hoverScale: CGFloat
    @State private var hovering = false

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        content
            // Flat tile that warms + lifts a touch on hover. No material, no blur, no sheen slab.
            .background(GlassSurface(cornerRadius: cornerRadius, material: .thinMaterial, tint: RadarTheme.panelElevated, sheen: 0))
            .overlay(shape.fill(hovering && !selected ? RadarTheme.tintFaint : Color.clear))
            .overlay(shape.fill(RadarTheme.blue.opacity(selected ? 0.10 : 0)))
            .overlay(
                shape.strokeBorder(
                    selected ? RadarTheme.blue.opacity(0.55)
                        : (hovering ? RadarTheme.borderStrong : RadarTheme.border),
                    lineWidth: 1
                )
            )
            .clipShape(shape)
            // ONE light shadow whose opacity (not radius) reacts to state — avoids re-blurring
            // per frame. Kept subtle so a grid of cards reads calm, not like a wall of boxes.
            .shadow(
                color: RadarTheme.cardShadow.opacity(selected ? 0.9 : (hovering ? 0.7 : 0.4)),
                radius: 9,
                x: 0,
                y: selected ? 5 : 3
            )
            .scaleEffect(hovering ? hoverScale : 1)
            .animation(RadarMotion.snappy, value: hovering)
            .animation(RadarMotion.spring, value: selected)
            .onHover { hovering = $0 }
    }
}

struct InteractiveRowModifier: ViewModifier {
    var selected: Bool
    var cornerRadius: CGFloat
    @State private var hovering = false

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        content
            .background(
                shape.fill(selected ? RadarTheme.tintStrong : (hovering ? RadarTheme.tintSoft : Color.clear))
            )
            .overlay(shape.strokeBorder(selected ? RadarTheme.borderStrong : Color.clear, lineWidth: 1))
            .clipShape(shape)
            .animation(RadarMotion.snappy, value: hovering)
            .animation(RadarMotion.spring, value: selected)
            .onHover { hovering = $0 }
    }
}

/// Calm, STATIC canvas. Flat near-solid base with a single whisper of accent in one corner —
/// tech-blue in Light, champagne in Dark. Recedes completely so the eye rests on content.
struct ResearchOSBackground: View {
    var body: some View {
        ZStack {
            LinearGradient(
                colors: [RadarTheme.background, RadarTheme.backgroundDeep],
                startPoint: .top,
                endPoint: .bottom
            )
            RadialGradient(
                colors: [RadarTheme.blue.opacity(0.05), .clear],
                center: .topLeading,
                startRadius: 0,
                endRadius: 720
            )
        }
        .ignoresSafeArea()
    }
}

/// Quiet section label — a clean caption rather than a terminal banner.
struct ResearchSectionEyebrow: View {
    let text: String
    var icon: String = "sparkle"

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(RadarTheme.blue)
            Text(text)
                .font(.system(size: 11.5, weight: .semibold))
                .tracking(0.2)
                .foregroundStyle(RadarTheme.secondaryText)
        }
    }
}

struct ResearchStatusChip: View {
    let label: String
    var icon: String? = nil
    var color: Color = RadarTheme.green

    var body: some View {
        HStack(spacing: 5) {
            if let icon {
                Image(systemName: icon)
                    .font(.system(size: 9, weight: .semibold))
            }
            Text(label)
                .font(.system(size: 10.5, weight: .semibold))
                .lineLimit(1)
        }
        .foregroundStyle(color)
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .background(color.opacity(0.14))
        .overlay(Capsule().strokeBorder(color.opacity(0.22), lineWidth: 0.8))
        .clipShape(Capsule())
    }
}

/// Rounded-rect glyph chip — tinted by default, gradient-filled when `gradient` is set.
/// A signature of the refined product look; use it as the leading mark on rows, cards, nav.
struct IconChip: View {
    let systemName: String
    var tint: Color = RadarTheme.blue
    var size: CGFloat = 34
    var gradient: LinearGradient? = nil

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: size * 0.30, style: .continuous)
        Image(systemName: systemName)
            .font(.system(size: size * 0.46, weight: .semibold))
            .foregroundStyle(gradient == nil ? AnyShapeStyle(tint) : AnyShapeStyle(Color.white))
            .frame(width: size, height: size)
            .background(
                Group {
                    if let gradient {
                        shape.fill(gradient)
                    } else {
                        shape.fill(tint.opacity(0.15))
                    }
                }
            )
            .overlay(shape.strokeBorder(gradient == nil ? tint.opacity(0.18) : Color.white.opacity(0.18), lineWidth: 0.8))
            .clipShape(shape)
    }
}

/// Circular confidence/score gauge with a gradient sweep and optional center label.
struct ProgressRing: View {
    let value: Double
    var size: CGFloat = 46
    var lineWidth: CGFloat = 5
    var colors: [Color] = [RadarTheme.blue, RadarTheme.cyan]
    var label: String? = nil

    var body: some View {
        ZStack {
            Circle().stroke(RadarTheme.tintStrong, lineWidth: lineWidth)
            Circle()
                .trim(from: 0, to: max(0.02, min(value, 1)))
                .stroke(
                    AngularGradient(colors: colors, center: .center, startAngle: .degrees(0), endAngle: .degrees(330)),
                    style: StrokeStyle(lineWidth: lineWidth, lineCap: .round)
                )
                .rotationEffect(.degrees(-90))
                .animation(RadarMotion.gentle, value: value)
            if let label {
                Text(label)
                    .font(.system(size: size * 0.27, weight: .bold, design: .rounded))
                    .foregroundStyle(RadarTheme.primaryText)
            }
        }
        .frame(width: size, height: size)
    }
}

/// ▲/▼ percentage delta pill in positive/negative color.
struct TrendChip: View {
    let change: Double
    var showsBackground: Bool = true

    var body: some View {
        let up = change >= 0
        let color = up ? RadarTheme.positive : RadarTheme.negative
        return HStack(spacing: 3) {
            Image(systemName: up ? "arrow.up.right" : "arrow.down.right")
                .font(.system(size: 9, weight: .bold))
            Text(String(format: "%.2f%%", abs(change)))
                .font(.system(size: 10.5, weight: .semibold, design: .rounded))
        }
        .foregroundStyle(color)
        .padding(.horizontal, showsBackground ? 7 : 0)
        .padding(.vertical, showsBackground ? 3 : 0)
        .background(showsBackground ? color.opacity(0.14) : Color.clear)
        .clipShape(Capsule())
    }
}

struct ResearchScoreBar: View {
    let value: Double
    var color: Color = RadarTheme.blue

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(RadarTheme.tintStrong)
                Capsule()
                    .fill(RadarTheme.brandGradient)
                    .frame(width: max(8, proxy.size.width * min(max(value, 0), 1)))
                    .animation(RadarMotion.gentle, value: value)
            }
        }
        .frame(height: 6)
    }
}

struct ResearchSparkline: View {
    let values: [Double]
    var color: Color = RadarTheme.blue

    var body: some View {
        GeometryReader { proxy in
            let normalized = normalize(values)
            ZStack {
                areaPath(in: proxy.size, normalized: normalized)
                    .fill(LinearGradient(colors: [color.opacity(0.26), .clear], startPoint: .top, endPoint: .bottom))
                linePath(in: proxy.size, normalized: normalized)
                    .stroke(
                        LinearGradient(colors: [color.opacity(0.85), color], startPoint: .leading, endPoint: .trailing),
                        style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round)
                    )
            }
        }
        .frame(height: 30)
    }

    private func linePath(in size: CGSize, normalized: [Double]) -> Path {
        Path { path in
            guard normalized.count > 1 else { return }
            for index in normalized.indices {
                let x = size.width * CGFloat(index) / CGFloat(max(normalized.count - 1, 1))
                let y = size.height * CGFloat(1 - normalized[index])
                if index == normalized.startIndex { path.move(to: CGPoint(x: x, y: y)) }
                else { path.addLine(to: CGPoint(x: x, y: y)) }
            }
        }
    }

    private func areaPath(in size: CGSize, normalized: [Double]) -> Path {
        Path { path in
            guard normalized.count > 1 else { return }
            path.move(to: CGPoint(x: 0, y: size.height))
            for index in normalized.indices {
                let x = size.width * CGFloat(index) / CGFloat(max(normalized.count - 1, 1))
                let y = size.height * CGFloat(1 - normalized[index])
                path.addLine(to: CGPoint(x: x, y: y))
            }
            path.addLine(to: CGPoint(x: size.width, y: size.height))
            path.closeSubpath()
        }
    }

    private func normalize(_ input: [Double]) -> [Double] {
        guard let min = input.min(), let max = input.max(), max > min else {
            return input.map { _ in 0.5 }
        }
        return input.map { ($0 - min) / (max - min) }
    }
}

struct ResearchPrimaryButtonStyle: ButtonStyle {
    @State private var hovering = false
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: 11, style: .continuous)
        return configuration.label
            .font(RadarFont.text(12.5, .semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(
                shape
                    .fill(isEnabled ? RadarTheme.blue : RadarTheme.tintStrong)
                    .brightness(configuration.isPressed ? -0.06 : (hovering ? 0.03 : 0))
            )
            .overlay(
                shape.strokeBorder(Color.white.opacity(isEnabled ? 0.18 : 0), lineWidth: 0.8)
            )
            .clipShape(shape)
            .shadow(
                color: RadarTheme.blue.opacity(isEnabled ? (hovering ? 0.18 : 0.10) : 0),
                radius: hovering ? 7 : 4,
                x: 0,
                y: hovering ? 3 : 2
            )
            .opacity(isEnabled ? 1 : 0.55)
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(RadarMotion.snappy, value: configuration.isPressed)
            .animation(RadarMotion.snappy, value: hovering)
            .onHover { hovering = $0 }
    }
}

struct ResearchSecondaryButtonStyle: ButtonStyle {
    @State private var hovering = false
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: 11, style: .continuous)
        return configuration.label
            .font(.system(size: 12.5, weight: .medium))
            .foregroundStyle(isEnabled ? RadarTheme.primaryText : RadarTheme.mutedText)
            .padding(.horizontal, 13)
            .padding(.vertical, 9)
            .background(
                shape
                    .fill(RadarTheme.panelElevated)
                    .overlay(shape.fill(isEnabled ? (configuration.isPressed ? RadarTheme.tintStrong : (hovering ? RadarTheme.tintSoft : Color.clear)) : RadarTheme.tintFaint))
            )
            .overlay(
                shape.strokeBorder(hovering && isEnabled ? RadarTheme.borderStrong : RadarTheme.borderSoft, lineWidth: 1)
            )
            .clipShape(shape)
            .shadow(color: RadarTheme.cardShadow.opacity(hovering && isEnabled ? 0.35 : 0.18), radius: 4, x: 0, y: 2)
            .opacity(isEnabled ? 1 : 0.62)
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(RadarMotion.snappy, value: configuration.isPressed)
            .animation(RadarMotion.snappy, value: hovering)
            .onHover { hovering = $0 }
    }
}

/// Compact glyph button — flat surface with hover lift.
struct HoverIconButtonStyle: ButtonStyle {
    var size: CGFloat = 32
    var circular: Bool = false
    @State private var hovering = false
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: circular ? size / 2 : 9, style: .continuous)
        return configuration.label
            .frame(width: size, height: size)
            .background(
                shape
                    .fill(RadarTheme.panelElevated)
                    .overlay(shape.fill(isEnabled ? (configuration.isPressed ? RadarTheme.tintStrong : (hovering ? RadarTheme.tintSoft : Color.clear)) : RadarTheme.tintFaint))
            )
            .overlay(shape.strokeBorder(hovering && isEnabled ? RadarTheme.borderStrong : RadarTheme.borderSoft, lineWidth: 1))
            .clipShape(shape)
            .shadow(color: RadarTheme.cardShadow.opacity(hovering && isEnabled ? 0.3 : 0.12), radius: 4, x: 0, y: 2)
            .opacity(isEnabled ? 1 : 0.55)
            .scaleEffect(configuration.isPressed ? 0.92 : 1)
            .animation(RadarMotion.snappy, value: configuration.isPressed)
            .animation(RadarMotion.snappy, value: hovering)
            .onHover { hovering = $0 }
    }
}

struct WorkspaceSurface<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        content
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(GlassSurface(cornerRadius: 16, material: .regularMaterial, tint: RadarTheme.panel, sheen: 0))
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(RadarTheme.border, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

struct StatusDot: View {
    var color: Color = RadarTheme.green
    var size: CGFloat = 7
    var pulsing: Bool = false
    @State private var animate = false

    var body: some View {
        ZStack {
            if pulsing {
                Circle()
                    .fill(color.opacity(0.35))
                    .frame(width: size, height: size)
                    .scaleEffect(animate ? 2.6 : 1)
                    .opacity(animate ? 0 : 0.7)
            }
            Circle()
                .fill(color)
                .frame(width: size, height: size)
                .shadow(color: color.opacity(pulsing ? 0.6 : 0), radius: 4)
        }
        .frame(width: size, height: size)
        .onAppear {
            guard pulsing else { return }
            withAnimation(.easeOut(duration: 1.6).repeatForever(autoreverses: false)) {
                animate = true
            }
        }
    }
}
