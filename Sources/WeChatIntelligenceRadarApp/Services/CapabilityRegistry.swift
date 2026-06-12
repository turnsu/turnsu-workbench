import Foundation

struct CapabilityRegistry {
    func capabilities(cmcStatus: String = "degraded", web3Status: String = "mock") -> [Capability] {
        [
            Capability(
                id: "mock-wechat-adapter",
                title: "Mock WeChat Adapter",
                state: "enabled",
                detail: "读取本地 fixture，保持与未来 wechat-cli JSON 输出兼容。"
            ),
            Capability(
                id: "briefing-agent",
                title: "Briefing Agent",
                state: "enabled",
                detail: "生成摘要、重点信号、可行动项和来源排行。"
            ),
            Capability(
                id: "wechat-cli-live",
                title: "wechat-cli Live Bridge",
                state: "read_only",
                detail: "由 daemon 按 WECHAT_LIVE_ENABLED 控制只读刷新；发送能力保持阻断。"
            ),
            Capability(
                id: "cmc-mcp",
                title: "CoinMarketCap MCP",
                state: cmcStatus,
                detail: "通过 CMC Crypto Skill Hub 加载；状态来自 normalized MarketDataSnapshot。"
            ),
            Capability(
                id: "web3-enrichment",
                title: "Web3 Enrichment",
                state: web3Status,
                detail: "识别群聊中的 BTC/ETH/SOL/Web3 关键词，并关联 market context。"
            ),
            Capability(
                id: "mock-market-fixture",
                title: "Mock Market Fixture",
                state: web3Status == "mock" ? "enabled" : "standby",
                detail: "只作为明确标记的 fallback，不能称为 live CMC 数据。"
            )
        ]
    }
}
