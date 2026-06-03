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

/// App typeface — bundled Manrope (registered at launch), system font as graceful fallback.
enum RadarFont {
    static func display(_ size: CGFloat, _ weight: Font.Weight = .bold) -> Font {
        .custom("Manrope", size: size).weight(weight)
    }
    static func text(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .custom("Manrope", size: size).weight(weight)
    }
}

enum RadarTheme {
    // === Banking-blue + AI palette ===========================================
    // Sober, trustworthy deep-blue (banking) with an electric-blue "AI" shimmer on gradients,
    // on a calm neutral-graphite canvas. Tuned for long viewing: comfortable (non-glare)
    // contrast, muted accents used sparingly, a STATIC background. green↑ / red↓ semantics.
    // `blue`/`cyan`/`indigo` token NAMES are kept but hold BLUE hues so every accent shifts.

    // Canvas — clean graphite with a faint cool-blue cast (the AI/tech undertone).
    static let background = Color(lightHex: 0xF4F6FB, darkHex: 0x0F1117)
    static let backgroundDeep = Color(lightHex: 0xE8ECF4, darkHex: 0x0A0C12)
    static let cyanBase = Color(lightHex: 0xE2ECFB, darkHex: 0x141A2A)
    static let purpleBase = Color(lightHex: 0xE6EAF6, darkHex: 0x161A28)

    // Surfaces — calm and fairly solid (readable, not busy). White in light, graphite in dark.
    static let sidebar = Color(lightHex: 0xFFFFFF, darkHex: 0x181C26, lightOpacity: 0.72, darkOpacity: 0.62)
    static let panel = Color(lightHex: 0xFFFFFF, darkHex: 0x191D28, lightOpacity: 0.70, darkOpacity: 0.60)
    static let panelElevated = Color(lightHex: 0xFFFFFF, darkHex: 0x232838, lightOpacity: 0.85, darkOpacity: 0.72)
    static let panelWash = Color(lightHex: 0xEEF1F8, darkHex: 0x272D3C, lightOpacity: 0.5, darkOpacity: 0.3)

    // Hairlines — soft, cool-neutral, low contrast.
    static let border = Color(lightHex: 0x1E2A44, darkHex: 0xC9D4EC, lightOpacity: 0.10, darkOpacity: 0.10)
    static let borderSoft = Color(lightHex: 0x1E2A44, darkHex: 0xC9D4EC, lightOpacity: 0.06, darkOpacity: 0.06)
    static let borderStrong = Color(lightHex: 0x1E2A44, darkHex: 0xC9D4EC, lightOpacity: 0.15, darkOpacity: 0.18)
    static let borderPurple = Color(lightHex: 0x1E2A44, darkHex: 0xC9D4EC, lightOpacity: 0.06, darkOpacity: 0.06)

    // Neutral tints for hover/fill washes.
    static let tintFaint = Color(lightHex: 0x1E2A44, darkHex: 0xC9D4EC, lightOpacity: 0.035, darkOpacity: 0.045)
    static let tintSoft = Color(lightHex: 0x1E2A44, darkHex: 0xC9D4EC, lightOpacity: 0.055, darkOpacity: 0.06)
    static let tintMedium = Color(lightHex: 0x1E2A44, darkHex: 0xC9D4EC, lightOpacity: 0.085, darkOpacity: 0.10)
    static let tintStrong = Color(lightHex: 0x1E2A44, darkHex: 0xC9D4EC, lightOpacity: 0.12, darkOpacity: 0.13)

    // Text — comfortable contrast (soft graphite / soft off-white, never pure black or white).
    static let primaryText = Color(lightHex: 0x1E2330, darkHex: 0xE7EAF2)
    static let secondaryText = Color(lightHex: 0x5A6271, darkHex: 0x99A1B2)
    static let mutedText = Color(lightHex: 0x929AAB, darkHex: 0x69707F)

    // Accents — deep-to-electric blue family + green/red market semantics.
    static let blue = Color(lightHex: 0x2D5BE6, darkHex: 0x5A86FF)   // primary, banking royal blue
    static let cyan = Color(lightHex: 0x1E86E0, darkHex: 0x46B6FF)   // electric sky (AI shimmer)
    static let indigo = Color(lightHex: 0x1B3FB0, darkHex: 0x2E55D8) // deep navy
    static let lime = Color(lightHex: 0x6FA84A, darkHex: 0x8FC56A)   // sage (minor accent only)
    static let ink = Color(hex: 0x0C1426)
    static let green = Color(lightHex: 0x2E9E63, darkHex: 0x43C281)  // positive / up
    static let gold = Color(lightHex: 0xC6892F, darkHex: 0xE0AC55)   // warning
    static let violet = Color(lightHex: 0x4E6A9E, darkHex: 0x6E8CC8) // steel-blue categorical (non-purple)
    static let red = Color(lightHex: 0xD2564C, darkHex: 0xE87B70)    // negative / down
    static let positive = Color(lightHex: 0x2E9E63, darkHex: 0x43C281)
    static let negative = Color(lightHex: 0xD2564C, darkHex: 0xE87B70)

    /// Royal-blue → electric-sky. The "AI" shimmer — used on the brand mark, big numbers,
    /// progress rings and gradient accents. Soft enough to live on screen all day.
    static let brandGradient = LinearGradient(
        colors: [Color(lightHex: 0x2D5BE6, darkHex: 0x5A86FF), Color(lightHex: 0x1E86E0, darkHex: 0x46B6FF)],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )

    static let accentGradient = brandGradient

    /// Deep navy → royal — for filled CTAs so white text stays legible in both appearances.
    static let ctaGradient = LinearGradient(
        colors: [Color(lightHex: 0x1B3FB0, darkHex: 0x2E55D8), Color(lightHex: 0x2D5BE6, darkHex: 0x3E6BF0)],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )

    /// A *gentle* blue→indigo wash for the hero — present but quiet; no saturated slab.
    static let heroGradient = LinearGradient(
        colors: [
            Color(lightHex: 0x2D5BE6, darkHex: 0x5A86FF, lightOpacity: 0.13, darkOpacity: 0.18),
            Color(lightHex: 0x1E86E0, darkHex: 0x46B6FF, lightOpacity: 0.08, darkOpacity: 0.11),
            .clear
        ],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )

    /// Soft ambient shadow — the wide, diffuse drop that gives a surface its float.
    static let cardShadow = Color(lightHex: 0x1B2A4A, darkHex: 0x000000, lightOpacity: 0.10, darkOpacity: 0.28)
    /// Tight contact shadow — the close, darker line directly under an element. Pairing the two
    /// (contact + ambient) is what reads as real, layered depth rather than a flat blur.
    static let contactShadow = Color(lightHex: 0x162542, darkHex: 0x000000, lightOpacity: 0.10, darkOpacity: 0.38)
}

/// Shared frosted-glass recipe: a backmost material (blurs the real backdrop), a thin color
/// wash to set the hue, and a top sheen. Used so every surface shares one consistent glass.
struct GlassSurface: View {
    var cornerRadius: CGFloat
    var material: Material
    var tint: Color
    var sheen: Double

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        shape
            .fill(material)
            .overlay(shape.fill(tint))
            .overlay(
                shape
                    .fill(LinearGradient(colors: [Color.white.opacity(sheen), .clear], startPoint: .top, endPoint: .center))
                    .blendMode(.plusLighter)
            )
    }
}

/// Centralized motion curves — one cohesive sense of physics across the app.
enum RadarMotion {
    static let spring = Animation.spring(response: 0.36, dampingFraction: 0.82)
    static let snappy = Animation.spring(response: 0.26, dampingFraction: 0.86)
    static let gentle = Animation.spring(response: 0.5, dampingFraction: 0.88)
    static let smooth = Animation.easeInOut(duration: 0.24)
}

struct PanelModifier: ViewModifier {
    var glow: Bool = false
    var cornerRadius: CGFloat = 18

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        content
            // Frosted glass: the material is the backmost layer, so it blurs the real backdrop.
            // .thinMaterial lets the colorful aurora bleed through for true glassmorphism.
            .background(GlassSurface(cornerRadius: cornerRadius, material: .thinMaterial, tint: RadarTheme.panel, sheen: 0.14))
            .overlay(
                shape.strokeBorder(glow ? RadarTheme.blue.opacity(0.35) : RadarTheme.border, lineWidth: 1)
            )
            .overlay(
                // Rim light along the top edge — the bright lip a glass panel catches.
                shape
                    .strokeBorder(
                        LinearGradient(colors: [Color.white.opacity(0.28), .clear], startPoint: .top, endPoint: .center),
                        lineWidth: 1
                    )
                    .blendMode(.plusLighter)
                    .opacity(0.55)
            )
            .clipShape(shape)
            .shadow(color: RadarTheme.contactShadow.opacity(glow ? 1 : 0.7), radius: 2, x: 0, y: 1)
            // Calm base sheets sit low; the colorful `glow` (hero) floats high — elevation = hierarchy.
            .shadow(color: RadarTheme.cardShadow.opacity(glow ? 1 : 0.7), radius: glow ? 32 : 13, x: 0, y: glow ? 18 : 7)
    }
}

extension View {
    func radarPanel(cornerRadius: CGFloat = 18) -> some View {
        modifier(PanelModifier(cornerRadius: cornerRadius))
    }

    func researchPanel(glow: Bool = false, cornerRadius: CGFloat = 18) -> some View {
        modifier(PanelModifier(glow: glow, cornerRadius: cornerRadius))
    }

    func researchCapsule(active: Bool = false) -> some View {
        padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(
                Capsule()
                    .fill(.ultraThinMaterial)
                    .overlay(Capsule().fill(active ? RadarTheme.blue.opacity(0.20) : RadarTheme.tintFaint))
            )
            .overlay(
                Capsule().strokeBorder(active ? RadarTheme.blue.opacity(0.40) : RadarTheme.borderSoft, lineWidth: 1)
            )
            .clipShape(Capsule())
    }

    /// Tappable card with hover lift + clear selected state.
    func interactiveCard(selected: Bool = false, cornerRadius: CGFloat = 16, hoverScale: CGFloat = 1.0) -> some View {
        modifier(InteractiveCardModifier(selected: selected, cornerRadius: cornerRadius, hoverScale: hoverScale))
    }

    /// Lightweight list / nav row that warms on hover and fills when selected.
    func interactiveRow(selected: Bool = false, cornerRadius: CGFloat = 12) -> some View {
        modifier(InteractiveRowModifier(selected: selected, cornerRadius: cornerRadius))
    }

    /// Quiet list item — a flat, low-contrast well (NOT a floating glass card). Stays calm so a
    /// list reads as one surface; only the hovered / selected item gains color + a hairline.
    /// This is what keeps lists from turning into a wall of competing glass tiles.
    func quietRow(selected: Bool = false, cornerRadius: CGFloat = 14) -> some View {
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
                        : (hovering ? RadarTheme.tintSoft : RadarTheme.tintFaint)
                )
            )
            .overlay(
                shape.strokeBorder(
                    selected ? RadarTheme.blue.opacity(0.45)
                        : (hovering ? RadarTheme.borderSoft : Color.clear),
                    lineWidth: 1
                )
            )
            // Selected item gets a thin colored glow to lift it just slightly off the surface.
            .shadow(color: selected ? RadarTheme.blue.opacity(0.18) : .clear, radius: 10, x: 0, y: 4)
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
            // Frosted-glass tile (material backmost) that brightens + lifts on hover.
            .background(GlassSurface(cornerRadius: cornerRadius, material: .thinMaterial, tint: RadarTheme.panelElevated, sheen: 0.14))
            .overlay(shape.fill(hovering && !selected ? RadarTheme.tintFaint : Color.clear))
            .overlay(shape.fill(RadarTheme.blue.opacity(selected ? 0.12 : 0)))
            .overlay(
                shape.strokeBorder(
                    selected ? RadarTheme.blue.opacity(0.55)
                        : (hovering ? RadarTheme.borderStrong : RadarTheme.border),
                    lineWidth: 1
                )
            )
            .overlay(
                shape
                    .strokeBorder(LinearGradient(colors: [Color.white.opacity(0.22), .clear], startPoint: .top, endPoint: .center), lineWidth: 0.8)
                    .blendMode(.plusLighter)
                    .opacity(0.5)
            )
            .clipShape(shape)
            .shadow(color: RadarTheme.contactShadow.opacity(hovering || selected ? 1 : 0.7), radius: 2, x: 0, y: 1)
            .shadow(
                color: RadarTheme.cardShadow.opacity(selected ? 1.0 : (hovering ? 0.9 : 0.6)),
                radius: selected ? 24 : (hovering ? 20 : 12),
                x: 0,
                y: selected ? 12 : (hovering ? 10 : 6)
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

/// Calm, STATIC canvas tuned for long viewing — a near-neutral warm gradient with only a
/// whisper of violet in the corners. No drifting, no saturated color: the background should
/// recede completely so the eye rests on content, not the wallpaper.
struct ResearchOSBackground: View {
    var body: some View {
        ZStack {
            LinearGradient(
                colors: [RadarTheme.background, RadarTheme.backgroundDeep],
                startPoint: .top,
                endPoint: .bottom
            )
            // Subtle, STATIC blue→indigo glow — a quiet "AI/tech" depth without arousal.
            RadialGradient(
                colors: [RadarTheme.blue.opacity(0.07), .clear],
                center: .topLeading,
                startRadius: 0,
                endRadius: 740
            )
            RadialGradient(
                colors: [RadarTheme.indigo.opacity(0.05), .clear],
                center: .bottomTrailing,
                startRadius: 0,
                endRadius: 620
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
            .shadow(color: gradient == nil ? .clear : tint.opacity(0.35), radius: 8, x: 0, y: 4)
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

    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
        return configuration.label
            .font(RadarFont.text(12.5, .semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(
                shape
                    .fill(RadarTheme.ctaGradient)
                    .overlay(
                        shape
                            .fill(LinearGradient(colors: [Color.white.opacity(0.20), .clear], startPoint: .top, endPoint: .center))
                            .blendMode(.plusLighter)
                    )
                    .brightness(configuration.isPressed ? -0.05 : (hovering ? 0.05 : 0))
            )
            .overlay(
                shape.strokeBorder(Color.white.opacity(0.22), lineWidth: 0.8)
            )
            .clipShape(shape)
            .shadow(color: .black.opacity(configuration.isPressed ? 0.08 : 0.12), radius: 2, x: 0, y: 1)
            .shadow(color: RadarTheme.blue.opacity(configuration.isPressed ? 0.10 : (hovering ? 0.30 : 0.18)),
                    radius: configuration.isPressed ? 5 : (hovering ? 14 : 9), x: 0, y: 5)
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(RadarMotion.snappy, value: configuration.isPressed)
            .animation(RadarMotion.snappy, value: hovering)
            .onHover { hovering = $0 }
    }
}

struct ResearchSecondaryButtonStyle: ButtonStyle {
    @State private var hovering = false

    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
        return configuration.label
            .font(.system(size: 12.5, weight: .medium))
            .foregroundStyle(RadarTheme.primaryText)
            .padding(.horizontal, 13)
            .padding(.vertical, 9)
            .background(
                // Frosted glass button — material backdrop + a hover-reactive wash + top sheen.
                shape
                    .fill(.thinMaterial)
                    .overlay(shape.fill(configuration.isPressed ? RadarTheme.tintStrong : (hovering ? RadarTheme.tintMedium : RadarTheme.tintFaint)))
                    .overlay(
                        shape.fill(LinearGradient(colors: [Color.white.opacity(0.16), .clear], startPoint: .top, endPoint: .center))
                            .blendMode(.plusLighter)
                    )
            )
            .overlay(
                shape.strokeBorder(hovering ? RadarTheme.borderStrong : RadarTheme.borderSoft, lineWidth: 1)
            )
            .clipShape(shape)
            .shadow(color: RadarTheme.contactShadow.opacity(0.6), radius: 1, x: 0, y: 1)
            .shadow(color: RadarTheme.cardShadow.opacity(hovering ? 0.8 : 0.45), radius: hovering ? 12 : 7, x: 0, y: hovering ? 6 : 3)
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(RadarMotion.snappy, value: configuration.isPressed)
            .animation(RadarMotion.snappy, value: hovering)
            .onHover { hovering = $0 }
    }
}

/// Compact glyph button — frosted glass with hover lift.
struct HoverIconButtonStyle: ButtonStyle {
    var size: CGFloat = 32
    var circular: Bool = false
    @State private var hovering = false

    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: circular ? size / 2 : 10, style: .continuous)
        return configuration.label
            .frame(width: size, height: size)
            .background(
                shape
                    .fill(.thinMaterial)
                    .overlay(shape.fill(configuration.isPressed ? RadarTheme.tintStrong : (hovering ? RadarTheme.tintMedium : RadarTheme.tintFaint)))
                    .overlay(
                        shape.fill(LinearGradient(colors: [Color.white.opacity(0.16), .clear], startPoint: .top, endPoint: .center))
                            .blendMode(.plusLighter)
                    )
            )
            .overlay(shape.strokeBorder(hovering ? RadarTheme.borderStrong : RadarTheme.borderSoft, lineWidth: 1))
            .clipShape(shape)
            .shadow(color: RadarTheme.cardShadow.opacity(hovering ? 0.7 : 0.4), radius: hovering ? 10 : 5, x: 0, y: hovering ? 5 : 2)
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
            .background(GlassSurface(cornerRadius: 18, material: .regularMaterial, tint: RadarTheme.panel, sheen: 0.12))
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .strokeBorder(RadarTheme.border, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
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
