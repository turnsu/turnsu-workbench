import Foundation

struct MockWeChatDataAdapter: WeChatDataAdapter {
    let adapterName = "Mock WeChat Fixture Adapter"
    let liveIntegrationAllowed = false

    private enum IDs {
        static let allGroups = UUID(uuidString: "11111111-1111-1111-1111-111111111111")!
        static let aiProduct = UUID(uuidString: "22222222-2222-2222-2222-222222222222")!
        static let waytoAGI = UUID(uuidString: "33333333-3333-3333-3333-333333333333")!
        static let howOneAI = UUID(uuidString: "44444444-4444-4444-4444-444444444444")!
        static let vibeCoding = UUID(uuidString: "55555555-5555-5555-5555-555555555555")!
        static let aiAcademia = UUID(uuidString: "66666666-6666-6666-6666-666666666666")!
        static let aiMarketing = UUID(uuidString: "77777777-7777-7777-7777-777777777777")!
    }

    func loadBatch(selectedGroupID: UUID?, date: Date) throws -> WeChatRawBatch {
        let groups = makeGroups()
        let messages = makeMessages()
        let filteredMessages: [IntelligenceMessage]

        if let selectedGroupID,
           let group = groups.first(where: { $0.id == selectedGroupID }),
           selectedGroupID != IDs.allGroups {
            filteredMessages = messages.filter { $0.groupName == group.name }
        } else {
            filteredMessages = messages
        }

        return WeChatRawBatch(
            groups: groups,
            messages: filteredMessages,
            sourceMode: "mock_fixture_no_live_wechat",
            notes: [
                "Local fixture data is used when live WeChat refresh is disabled or unavailable.",
                "wechat-cli_raw remains a read-only reference for CLI adapter wiring.",
                "Live WeChat refresh is read-only and controlled by WECHAT_LIVE_ENABLED."
            ]
        )
    }

    private func makeGroups() -> [ChatGroup] {
        [
            ChatGroup(id: IDs.allGroups, name: "所有群", memberCount: 165, unreadCount: 27, collection: "GROUPS", colorHex: 0x8AE6B8),
            ChatGroup(id: IDs.aiProduct, name: "AI产品蛙虫团", memberCount: 3, unreadCount: 3, collection: "COLLECTIONS", colorHex: 0xFF756E),
            ChatGroup(id: IDs.waytoAGI, name: "WaytoAGI", memberCount: 10, unreadCount: 2, collection: "COLLECTIONS", colorHex: 0x50B4FF),
            ChatGroup(id: IDs.howOneAI, name: "HowOneAI", memberCount: 3, unreadCount: 1, collection: "COLLECTIONS", colorHex: 0x6C7DFF),
            ChatGroup(id: IDs.vibeCoding, name: "Vibe Coding · 编程", memberCount: 14, unreadCount: 6, collection: "COLLECTIONS", colorHex: 0xB27CFF),
            ChatGroup(id: IDs.aiAcademia, name: "AI 学术", memberCount: 7, unreadCount: 0, collection: "COLLECTIONS", colorHex: 0x56D6B1),
            ChatGroup(id: IDs.aiMarketing, name: "AI 商业 · 营销", memberCount: 19, unreadCount: 4, collection: "COLLECTIONS", colorHex: 0xFFC857)
        ]
    }

    private func makeMessages() -> [IntelligenceMessage] {
        [
            IntelligenceMessage(
                id: UUID(uuidString: "A0000000-0000-0000-0000-000000000001")!,
                title: "每日情报（2026-05-23，UTC+8）生成时间：08:30，BTC ETF 与 AI Agent 热度上升",
                excerpt: "覆盖 165 个群，聚合产品发布、融资、招聘、Web3 市场和工具链信号。",
                groupName: "WaytoAGI",
                sender: "WaytoAGI vibe coding交流群",
                timestamp: "17:36",
                sentAt: fixedDate("2026-05-23T17:36:00Z"),
                sourceDateText: "2026-05-23 17:36",
                weight: 12,
                tags: [
                    SignalTag(label: "工具/产品", style: .product),
                    SignalTag(label: "链接信号", style: .link),
                    SignalTag(label: "可跟进", style: .action),
                    SignalTag(label: "Web3", style: .web3)
                ]
            ),
            IntelligenceMessage(
                id: UUID(uuidString: "A0000000-0000-0000-0000-000000000002")!,
                title: "5月22日群日报和龙王榜：资源分享 120 美元，找一个 AI 产品合伙人",
                excerpt: "多群重复出现 AI 产品合伙人需求，适合进入关系链验证。",
                groupName: "AI产品蛙虫团",
                sender: "SimolinonAI学术交流",
                timestamp: "10:37",
                sentAt: fixedDate("2026-05-22T10:37:00Z"),
                sourceDateText: "2026-05-22 10:37",
                weight: 12,
                tags: [
                    SignalTag(label: "工具/产品", style: .product),
                    SignalTag(label: "链接信号", style: .link),
                    SignalTag(label: "可跟进", style: .action)
                ]
            ),
            IntelligenceMessage(
                id: UUID(uuidString: "A0000000-0000-0000-0000-000000000003")!,
                title: "京津冀 · 宇树全系机器人商演 & 项目合作，官方认证团队",
                excerpt: "商演、设备齐全、项目合作，适合登记为线下活动与代理合作线索。",
                groupName: "AI 商业 · 营销",
                sender: "南乔River",
                timestamp: "09:56",
                sentAt: fixedDate("2026-05-20T09:56:00Z"),
                sourceDateText: "2026-05-20 09:56",
                weight: 12,
                tags: [
                    SignalTag(label: "机会需求", style: .demand),
                    SignalTag(label: "可跟进", style: .action)
                ]
            ),
            IntelligenceMessage(
                id: UUID(uuidString: "A0000000-0000-0000-0000-000000000004")!,
                title: "通往AGI之路 知识库更新：6个月红队计划、ETH L2 数据和知识库治理",
                excerpt: "知识库、Agent 组织、ETH L2 数据面板和长期信息治理讨论升温。",
                groupName: "AI 学术",
                sender: "千丸",
                timestamp: "09:04",
                sentAt: fixedDate("2026-05-12T09:04:00Z"),
                sourceDateText: "2026-05-12 09:04",
                weight: 12,
                tags: [
                    SignalTag(label: "工具/产品", style: .product),
                    SignalTag(label: "链接信号", style: .link),
                    SignalTag(label: "Web3", style: .web3)
                ]
            ),
            IntelligenceMessage(
                id: UUID(uuidString: "A0000000-0000-0000-0000-000000000005")!,
                title: "是帮 8G 快本，还是 640 版本？AppSail 做了一个云端开发讨论",
                excerpt: "开发环境、算力成本和端云协同是 Vibe Coding 群高频问题。",
                groupName: "Vibe Coding · 编程",
                sender: "Deathhush",
                timestamp: "08:52",
                sentAt: fixedDate("2026-04-30T08:52:00Z"),
                sourceDateText: "2026-04-30 08:52",
                weight: 12,
                tags: [
                    SignalTag(label: "机会需求", style: .demand),
                    SignalTag(label: "工具/产品", style: .product),
                    SignalTag(label: "链接信号", style: .link)
                ]
            ),
            IntelligenceMessage(
                id: UUID(uuidString: "A0000000-0000-0000-0000-000000000006")!,
                title: "和 @闫阳乔 老师一起做了一个安克飞书录音互动问答格，顺带讨论 SOL 生态活动",
                excerpt: "实时会议、飞书记录、音频问答产品和 SOL 生态活动进入小范围测试。",
                groupName: "HowOneAI",
                sender: "BU红薯",
                timestamp: "01:30",
                sentAt: fixedDate("2026-03-04T01:30:00Z"),
                sourceDateText: "2026-03-04 01:30",
                weight: 9,
                tags: [
                    SignalTag(label: "链接信号", style: .link),
                    SignalTag(label: "风险观察", style: .risk),
                    SignalTag(label: "Web3", style: .web3)
                ]
            ),
            IntelligenceMessage(
                id: UUID(uuidString: "A0000000-0000-0000-0000-000000000007")!,
                title: "你们谁有 CLIProxyAPI 作者的联系方式或邮箱",
                excerpt: "API 代理、渠道联络和供应链稳定性需要记录。",
                groupName: "Vibe Coding · 编程",
                sender: "火星人",
                timestamp: "16:50",
                sentAt: fixedDate("2025-10-18T16:50:00Z"),
                sourceDateText: "2025-10-18 16:50",
                weight: 8,
                tags: [
                    SignalTag(label: "可跟进", style: .action)
                ]
            )
        ]
    }

    private func fixedDate(_ value: String) -> Date {
        ISO8601DateFormatter().date(from: value) ?? Date(timeIntervalSince1970: 0)
    }
}
