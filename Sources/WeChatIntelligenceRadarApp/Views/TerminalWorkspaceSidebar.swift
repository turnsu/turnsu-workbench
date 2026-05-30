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

    var body: some View {
        VStack(alignment: sidebarCollapsed ? .center : .leading, spacing: 18) {
            brand

            VStack(alignment: .leading, spacing: 6) {
                MinimalNavRow(
                    title: "今日",
                    subtitle: "5 条重点情报",
                    icon: "sparkles",
                    badge: "",
                    selected: selectedWorkspace == .home,
                    collapsed: sidebarCollapsed,
                    action: { onSelectWorkspace(.home) }
                )
                MinimalNavRow(
                    title: "Agent",
                    subtitle: "任务与对话",
                    icon: "bubble.left.and.text.bubble.right",
                    badge: "",
                    selected: selectedWorkspace == .agents,
                    collapsed: sidebarCollapsed,
                    action: { onSelectWorkspace(.agents) }
                )
                MinimalNavRow(
                    title: "资料库",
                    subtitle: "微信 / Token / 观察",
                    icon: "folder",
                    badge: "\(tokenCount)",
                    selected: isLibrarySelected,
                    collapsed: sidebarCollapsed,
                    action: { onSelectWorkspace(.inbox) }
                )
                MinimalNavRow(
                    title: "设置",
                    subtitle: "运行状态与隐私",
                    icon: "gearshape",
                    badge: "",
                    selected: selectedWorkspace == .ops,
                    collapsed: sidebarCollapsed,
                    action: { onSelectWorkspace(.ops) }
                )
            }

            Spacer(minLength: 0)
            if sidebarCollapsed {
                Button {
                    sidebarCollapsed.toggle()
                } label: {
                    Image(systemName: "sidebar.left")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(RadarTheme.secondaryText)
                        .frame(width: 34, height: 34)
                        .background(Color.white.opacity(0.055))
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                .buttonStyle(.plain)
            } else {
                safetyFooter
            }
        }
        .padding(sidebarCollapsed ? 12 : 16)
        .frame(width: sidebarCollapsed ? 72 : 238)
        .frame(maxHeight: .infinity)
        .background(.ultraThinMaterial)
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(RadarTheme.border, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .shadow(color: .black.opacity(0.10), radius: 18, x: 0, y: 10)
    }

    private var brand: some View {
        VStack(alignment: sidebarCollapsed ? .center : .leading, spacing: 8) {
            HStack(spacing: 11) {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(RadarTheme.blue)
                    .frame(width: 28, height: 28)
                    .overlay(Image(systemName: "sparkles").font(.system(size: 13, weight: .bold)).foregroundStyle(.white))
                if !sidebarCollapsed {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("情报工作台")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(RadarTheme.primaryText)
                        Text("本地优先")
                            .font(.system(size: 11))
                            .foregroundStyle(RadarTheme.mutedText)
                    }
                    Spacer()
                    Button {
                        sidebarCollapsed.toggle()
                    } label: {
                        Image(systemName: "sidebar.left")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(RadarTheme.mutedText)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private var safetyFooter: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 7) {
                StatusDot(color: RadarTheme.gold)
                Text("真实微信 live 已阻断")
            }
            Text("运行细节已收进设置页，主工作台只保留操作入口。")
                .font(.system(size: 10))
                .foregroundStyle(RadarTheme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
        }
        .font(.system(size: 10))
        .padding(12)
        .background(Color.white.opacity(0.045))
        .researchPanel()
    }

    private var isLibrarySelected: Bool {
        selectedWorkspace == .inbox || selectedWorkspace == .token || selectedWorkspace == .watchlist
    }
}

private struct MinimalNavRow: View {
    let title: String
    let subtitle: String
    let icon: String
    let badge: String
    let selected: Bool
    let collapsed: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 11) {
                Image(systemName: icon)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(selected ? RadarTheme.blue : RadarTheme.secondaryText)
                    .frame(width: 22)
                if !collapsed {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title)
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(RadarTheme.primaryText)
                            .lineLimit(1)
                        Text(subtitle)
                            .font(.system(size: 10))
                            .foregroundStyle(RadarTheme.mutedText)
                            .lineLimit(1)
                    }
                    Spacer()
                    if !badge.isEmpty {
                        Text(badge)
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(RadarTheme.mutedText)
                    }
                }
            }
            .padding(.horizontal, collapsed ? 9 : 10)
            .padding(.vertical, 10)
            .background(selected ? Color.white.opacity(0.085) : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}

private struct SourceGroupRow: View {
    let group: ChatGroup
    let selectedGroupID: UUID?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Circle()
                    .fill(Color(hex: group.colorHex))
                    .frame(width: 7, height: 7)
                Text(group.name)
                    .font(.system(size: 12))
                    .lineLimit(1)
                Spacer()
                Text("\(group.memberCount)")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(RadarTheme.mutedText)
            }
            .foregroundStyle(selectedGroupID == group.id ? RadarTheme.green : RadarTheme.secondaryText)
            .padding(.vertical, 3)
        }
        .buttonStyle(.plain)
    }
}
