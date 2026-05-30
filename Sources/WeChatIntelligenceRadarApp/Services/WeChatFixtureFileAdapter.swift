import Foundation

struct WeChatFixtureFileAdapter: WeChatDataAdapter {
    let adapterName = "WeChat Fixture File Adapter"
    let liveIntegrationAllowed = false

    private let fixtureURL: URL?
    private let fallback: MockWeChatDataAdapter

    init(fixtureURL: URL? = nil, fallback: MockWeChatDataAdapter = MockWeChatDataAdapter()) {
        self.fixtureURL = fixtureURL
        self.fallback = fallback
    }

    func loadBatch(selectedGroupID: UUID?, date: Date) throws -> WeChatRawBatch {
        guard let url = fixtureURL ?? Self.defaultFixtureURL() else {
            var batch = try fallback.loadBatch(selectedGroupID: selectedGroupID, date: date)
            batch = WeChatRawBatch(
                groups: batch.groups,
                messages: batch.messages,
                sourceMode: "hardcoded_fixture_fallback_degraded",
                notes: batch.notes + ["Fixture JSON was unavailable; fell back to hardcoded fixture."]
            )
            return batch
        }

        do {
            let data = try Data(contentsOf: url)
            let decoded = try JSONDecoder.agentArtifactDecoder().decode(WeChatFixtureFile.self, from: data)
            let groups = decoded.groups.map { $0.toModel() }
            let messages = decoded.messages.map { $0.toModel() }
            let filteredMessages: [IntelligenceMessage]

            if let selectedGroupID,
               let selectedGroup = groups.first(where: { $0.id == selectedGroupID }),
               selectedGroup.name != "所有群" {
                filteredMessages = messages.filter { $0.groupName == selectedGroup.name }
            } else {
                filteredMessages = messages
            }

            return WeChatRawBatch(
                groups: groups,
                messages: filteredMessages,
                sourceMode: "fixture_file",
                notes: decoded.notes + ["Loaded fixture file: \(url.lastPathComponent)."]
            )
        } catch {
            let batch = try fallback.loadBatch(selectedGroupID: selectedGroupID, date: date)
            return WeChatRawBatch(
                groups: batch.groups,
                messages: batch.messages,
                sourceMode: "hardcoded_fixture_fallback_degraded",
                notes: batch.notes + ["Fixture JSON decode failed: \(error)."]
            )
        }
    }

    private static func defaultFixtureURL(fileManager: FileManager = .default) -> URL? {
        var candidates: [URL] = []

        if let resourceURL = Bundle.main.resourceURL {
            candidates.append(
                resourceURL
                    .appendingPathComponent("WeChatIntelligenceRadarMVP_WeChatIntelligenceRadarApp.bundle", isDirectory: true)
                    .appendingPathComponent("messages.sample.json")
            )
            candidates.append(resourceURL.appendingPathComponent("messages.sample.json"))
        }

        let executableRelativeBundle = Bundle.main.bundleURL
            .deletingLastPathComponent()
            .appendingPathComponent("WeChatIntelligenceRadarMVP_WeChatIntelligenceRadarApp.bundle", isDirectory: true)
            .appendingPathComponent("messages.sample.json")
        candidates.append(executableRelativeBundle)

        let sourceFixture = RuntimePathResolver.findProjectRoot(fileManager: fileManager)
            .appendingPathComponent("Sources/WeChatIntelligenceRadarApp/Fixtures/wechat/messages.sample.json")
        candidates.append(sourceFixture)

        return candidates.first { fileManager.fileExists(atPath: $0.path) }
    }
}

struct WeChatCLIExportAdapter: WeChatDataAdapter {
    let adapterName = "WeChat CLI Export File Adapter"
    let liveIntegrationAllowed = false
    let exportURL: URL

    func loadBatch(selectedGroupID: UUID?, date: Date) throws -> WeChatRawBatch {
        throw WeChatAdapterError.wechatCLIExportRequiresConfirmation
    }
}

private struct WeChatFixtureFile: Decodable {
    let groups: [GroupDTO]
    let messages: [MessageDTO]
    let notes: [String]
}

private struct GroupDTO: Decodable {
    let id: UUID
    let name: String
    let memberCount: Int
    let unreadCount: Int
    let collection: String
    let colorHex: String

    func toModel() -> ChatGroup {
        ChatGroup(
            id: id,
            name: name,
            memberCount: memberCount,
            unreadCount: unreadCount,
            collection: collection,
            colorHex: UInt(colorHex.trimmingCharacters(in: CharacterSet(charactersIn: "#")), radix: 16) ?? 0x8AE6B8
        )
    }
}

private struct MessageDTO: Decodable {
    let id: UUID
    let title: String
    let excerpt: String
    let groupName: String
    let sender: String
    let timestamp: String
    let sentAt: Date
    let sourceDateText: String
    let weight: Int
    let tags: [TagDTO]

    func toModel() -> IntelligenceMessage {
        IntelligenceMessage(
            id: id,
            title: title,
            excerpt: excerpt,
            groupName: groupName,
            sender: sender,
            timestamp: timestamp,
            sentAt: sentAt,
            sourceDateText: sourceDateText,
            weight: weight,
            tags: tags.map { $0.toModel() }
        )
    }
}

private struct TagDTO: Decodable {
    let label: String
    let style: TagStyle

    func toModel() -> SignalTag {
        SignalTag(label: label, style: style)
    }
}
