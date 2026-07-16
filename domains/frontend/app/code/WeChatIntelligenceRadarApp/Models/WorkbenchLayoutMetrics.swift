import SwiftUI

struct WorkbenchLayoutMetrics: Equatable {
    enum Breakpoint: String {
        case compact
        case regular
        case wide
    }

    let contentWidth: CGFloat
    let breakpoint: Breakpoint

    init(contentWidth: CGFloat) {
        let width = max(0, contentWidth)
        self.contentWidth = width
        if width < 1_100 {
            self.breakpoint = .compact
        } else if width < 1_500 {
            self.breakpoint = .regular
        } else {
            self.breakpoint = .wide
        }
    }

    var isCompact: Bool { breakpoint == .compact }
    var isWide: Bool { breakpoint == .wide }

    var workspaceSpacing: CGFloat {
        isCompact ? 12 : 14
    }

    var queueColumnWidth: CGFloat {
        guard !isCompact else { return contentWidth }
        if isWide {
            return min(max(contentWidth * 0.26, 360), 460)
        }
        return 320
    }

    var supportColumnWidth: CGFloat {
        guard !isCompact else { return contentWidth }
        if isWide {
            return min(max(contentWidth * 0.27, 360), 460)
        }
        return 330
    }

    var tokenColumnWidth: CGFloat {
        guard !isCompact else { return contentWidth }
        return isWide ? 340 : 300
    }
}
