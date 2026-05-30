import Foundation

struct WeChatRawBatch: Hashable, Codable {
    let groups: [ChatGroup]
    let messages: [IntelligenceMessage]
    let sourceMode: String
    let notes: [String]
}

protocol WeChatDataAdapter {
    var adapterName: String { get }
    var liveIntegrationAllowed: Bool { get }

    func loadBatch(selectedGroupID: UUID?, date: Date) throws -> WeChatRawBatch
}

enum WeChatAdapterError: Error {
    case liveIntegrationBlocked
    case fixtureFileUnavailable
    case wechatCLIExportRequiresConfirmation
}

struct WeChatCLIAdapterBoundary {
    let referenceDirectory = "../wechat-cli_raw"
    let plannedCommands = [
        "wechat-cli sessions --limit 20",
        "wechat-cli history <group> --limit 100 --format json",
        "wechat-cli search <keyword> --chat <group>"
    ]
    let liveIntegrationStatus = "blocked_for_mvp"
}
