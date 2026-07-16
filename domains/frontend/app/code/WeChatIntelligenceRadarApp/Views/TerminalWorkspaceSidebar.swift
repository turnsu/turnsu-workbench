import AppKit
import SwiftUI

struct TerminalWorkspaceSidebar: View {
    let groups: [ChatGroup]
    let selectedWorkspace: TerminalWorkspace
    let selectedGroupID: UUID?
    let tokenCount: Int
    let alertCount: Int
    let onSelectWorkspace: (TerminalWorkspace) -> Void
    let onSelectGroup: (ChatGroup) -> Void
    let onSelectAll: () -> Void
    @AppStorage("minimalWorkbench.sidebarCollapsed") private var sidebarCollapsed = false
    @AppStorage("minimalWorkbench.sidebarWidth") private var sidebarWidth: Double = 240
    @Namespace private var navAccent
    @State private var dragBaseWidth: Double? = nil

    private let minSidebarWidth: Double = 200
    private let maxSidebarWidth: Double = 360

    var body: some View {
        VStack(alignment: sidebarCollapsed ? .center : .leading, spacing: 20) {
            brand

            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    navSectionTitle("Monitor")
                    MinimalNavRow(
                        title: "Tasks",
                        subtitle: "Runs / approvals / errors",
                        icon: "waveform.path.ecg",
                        tint: RadarTheme.blue,
                        badge: "",
                        selected: selectedWorkspace == .home,
                        collapsed: sidebarCollapsed,
                        namespace: navAccent,
                        accessibilityID: LoopOpsInteractionID.runsMonitorTable,
                        action: { onSelectWorkspace(.home) }
                    )
                }

                VStack(alignment: .leading, spacing: 4) {
                    navSectionTitle("Build")
                        .accessibilityIdentifier(LoopOpsInteractionID.buildNavigationGroup)
                    MinimalNavRow(
                        title: "Agents",
                        subtitle: "Loop contracts",
                        icon: "person.crop.circle.badge.gearshape",
                        tint: RadarTheme.cyan,
                        badge: "\(tokenCount)",
                        selected: selectedWorkspace == .inbox,
                        collapsed: sidebarCollapsed,
                        namespace: navAccent,
                        accessibilityID: LoopOpsInteractionID.buildAgentsList,
                        action: { onSelectWorkspace(.inbox) }
                    )
                    MinimalNavRow(
                        title: "Tools",
                        subtitle: "Skills / extensions",
                        icon: "wrench.and.screwdriver",
                        tint: RadarTheme.green,
                        badge: "",
                        selected: selectedWorkspace == .skills,
                        collapsed: sidebarCollapsed,
                        namespace: navAccent,
                        accessibilityID: LoopOpsInteractionID.buildToolsList,
                        action: { onSelectWorkspace(.skills) }
                    )
                    MinimalNavRow(
                        title: "Workforce",
                        subtitle: "Skill stacks",
                        icon: "person.3.sequence",
                        tint: RadarTheme.indigo,
                        badge: "",
                        selected: selectedWorkspace == .workforce,
                        collapsed: sidebarCollapsed,
                        namespace: navAccent,
                        accessibilityID: LoopOpsInteractionID.buildWorkforceList,
                        action: { onSelectWorkspace(.workforce) }
                    )
                    MinimalNavRow(
                        title: "Knowledge",
                        subtitle: "Sources and context",
                        icon: "tray.full",
                        tint: RadarTheme.gold,
                        badge: "",
                        selected: selectedWorkspace == .knowledge,
                        collapsed: sidebarCollapsed,
                        namespace: navAccent,
                        accessibilityID: LoopOpsInteractionID.buildKnowledgeList,
                        action: { onSelectWorkspace(.knowledge) }
                    )
                    MinimalNavRow(
                        title: "Chat",
                        subtitle: "Ask / attach / start loops",
                        icon: "bubble.left.and.text.bubble.right",
                        tint: RadarTheme.blue,
                        badge: "",
                        selected: selectedWorkspace == .chat,
                        collapsed: sidebarCollapsed,
                        namespace: navAccent,
                        accessibilityID: LoopOpsInteractionID.buildChatList,
                        action: { onSelectWorkspace(.chat) }
                    )
                    MinimalNavRow(
                        title: "Studio",
                        subtitle: "Builder / execution path",
                        icon: "slider.horizontal.3",
                        tint: RadarTheme.indigo,
                        badge: "",
                        selected: selectedWorkspace == .studio,
                        collapsed: sidebarCollapsed,
                        namespace: navAccent,
                        accessibilityID: LoopOpsInteractionID.buildCreateButton,
                        action: { onSelectWorkspace(.studio) }
                    )
                }

                VStack(alignment: .leading, spacing: 4) {
                    navSectionTitle("Account")
                    MinimalNavRow(
                        title: "Agent Console",
                        subtitle: "Ops workspace",
                        icon: "terminal",
                        tint: RadarTheme.secondaryText,
                        badge: "",
                        selected: selectedWorkspace == .agents,
                        collapsed: sidebarCollapsed,
                        namespace: navAccent,
                        action: { onSelectWorkspace(.agents) }
                    )
                    MinimalNavRow(
                        title: "设置",
                        subtitle: "运行状态与隐私",
                        icon: "gearshape",
                        tint: RadarTheme.secondaryText,
                        badge: alertCount > 0 ? "\(alertCount)" : "",
                        selected: selectedWorkspace == .ops,
                        collapsed: sidebarCollapsed,
                        namespace: navAccent,
                        action: { onSelectWorkspace(.ops) }
                    )
                }
            }
            .animation(RadarMotion.spring, value: selectedWorkspace)

            Spacer(minLength: 0)
            if sidebarCollapsed {
                Button {
                    withAnimation(RadarMotion.gentle) { sidebarCollapsed.toggle() }
                } label: {
                    Image(systemName: "sidebar.left")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(RadarTheme.secondaryText)
                }
                .buttonStyle(HoverIconButtonStyle(size: 34))
            } else {
                safetyFooter
            }
        }
        .padding(sidebarCollapsed ? 12 : 16)
        .frame(width: sidebarCollapsed ? 78 : CGFloat(sidebarWidth))
        .frame(maxHeight: .infinity)
        .background(GlassSurface(cornerRadius: 22, material: .regularMaterial, tint: RadarTheme.sidebar, sheen: 0.12))
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .strokeBorder(RadarTheme.border, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(alignment: .trailing) {
            if !sidebarCollapsed { resizeHandle }
        }
        .shadow(color: RadarTheme.contactShadow, radius: 2, x: 0, y: 1)
        .shadow(color: RadarTheme.cardShadow, radius: 26, x: 0, y: 14)
    }

    /// Drag the trailing edge to widen / narrow the nav. Persisted via @AppStorage.
    private var resizeHandle: some View {
        Rectangle()
            .fill(Color.clear)
            .frame(width: 10)
            .contentShape(Rectangle())
            .overlay(
                RoundedRectangle(cornerRadius: 2)
                    .fill(RadarTheme.borderStrong)
                    .frame(width: 3, height: 30)
                    .opacity(dragBaseWidth == nil ? 0 : 1)
            )
            .onHover { inside in
                if inside { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() }
            }
            .gesture(
                DragGesture(minimumDistance: 1)
                    .onChanged { value in
                        let base = dragBaseWidth ?? sidebarWidth
                        if dragBaseWidth == nil { dragBaseWidth = base }
                        sidebarWidth = min(maxSidebarWidth, max(minSidebarWidth, base + Double(value.translation.width)))
                    }
                    .onEnded { _ in dragBaseWidth = nil }
            )
            .offset(x: 5)
    }

    private var brand: some View {
        HStack(spacing: 11) {
            LooloomiBrandMark(size: 34)
            if !sidebarCollapsed {
                VStack(alignment: .leading, spacing: 1) {
                    Text("looloomi")
                        .font(RadarFont.display(18, .bold))
                        .foregroundStyle(RadarTheme.primaryText)
                    Text("本地优先 · 统一 Agent")
                        .font(.system(size: 10.5))
                        .foregroundStyle(RadarTheme.mutedText)
                }
                Spacer()
                Button {
                    withAnimation(RadarMotion.gentle) { sidebarCollapsed.toggle() }
                } label: {
                    Image(systemName: "sidebar.left")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(RadarTheme.mutedText)
                }
                .buttonStyle(HoverIconButtonStyle(size: 28))
            }
        }
    }

    private var safetyFooter: some View {
        HStack(spacing: 9) {
            IconChip(systemName: "checkmark.shield.fill", tint: RadarTheme.blue, size: 30)
            VStack(alignment: .leading, spacing: 2) {
                Text("真实微信 · 本地只读")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(RadarTheme.primaryText)
                Text("已授权读取，不发送 / 不外发")
                    .font(.system(size: 10))
                    .foregroundStyle(RadarTheme.mutedText)
            }
            Spacer(minLength: 0)
            StatusDot(color: RadarTheme.blue, pulsing: false)
        }
        .padding(11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RadarTheme.blue.opacity(0.08))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(RadarTheme.blue.opacity(0.18), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private var isLibrarySelected: Bool {
        selectedWorkspace == .inbox || selectedWorkspace == .token || selectedWorkspace == .watchlist
    }

    private func navSectionTitle(_ title: String) -> some View {
        Group {
            if !sidebarCollapsed {
                Text(title)
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundStyle(RadarTheme.mutedText)
                    .tracking(0.5)
                    .padding(.leading, 11)
                    .padding(.bottom, 2)
            }
        }
    }
}

private struct LooloomiBrandMark: View {
    let size: CGFloat

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: size * 0.31, style: .continuous)
        ZStack {
            shape
                .fill(RadarTheme.panelElevated)
            shape
                .strokeBorder(RadarTheme.borderStrong, lineWidth: 1)
            Image(systemName: "infinity")
                .font(.system(size: size * 0.54, weight: .bold))
                .foregroundStyle(RadarTheme.blue)
        }
        .frame(width: size, height: size)
        .clipShape(shape)
        .shadow(color: RadarTheme.cardShadow.opacity(0.18), radius: 4, x: 0, y: 2)
    }
}

private struct MinimalNavRow: View {
    let title: String
    let subtitle: String
    let icon: String
    let tint: Color
    let badge: String
    let selected: Bool
    let collapsed: Bool
    let namespace: Namespace.ID
    var accessibilityID: String? = nil
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 11) {
                IconChip(
                    systemName: icon,
                    tint: tint,
                    size: collapsed ? 34 : 30
                )
                if !collapsed {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(title)
                            .font(RadarFont.text(13, .semibold))
                            .foregroundStyle(RadarTheme.primaryText)
                            .lineLimit(1)
                        Text(subtitle)
                            .font(RadarFont.text(10))
                            .foregroundStyle(RadarTheme.mutedText)
                            .lineLimit(1)
                    }
                    Spacer()
                    if !badge.isEmpty {
                        Text(badge)
                            .font(.system(size: 10, weight: .semibold, design: .rounded))
                            .foregroundStyle(selected ? RadarTheme.blue : RadarTheme.secondaryText)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 2)
                            .background((selected ? RadarTheme.blue : RadarTheme.mutedText).opacity(0.14))
                            .clipShape(Capsule())
                    }
                }
            }
            .padding(.horizontal, collapsed ? 8 : 10)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: collapsed ? .center : .leading)
            .background(
                ZStack {
                    if selected {
                        RoundedRectangle(cornerRadius: 13, style: .continuous)
                            .fill(RadarTheme.blue.opacity(0.12))
                            .matchedGeometryEffect(id: "navAccent", in: namespace)
                    } else if hovering {
                        RoundedRectangle(cornerRadius: 13, style: .continuous)
                            .fill(RadarTheme.tintSoft)
                    }
                }
            )
            .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(accessibilityID ?? "nav.\(title.lowercased().replacingOccurrences(of: " ", with: "-"))")
        .onHover { hovering = $0 }
        .animation(RadarMotion.snappy, value: hovering)
    }
}
