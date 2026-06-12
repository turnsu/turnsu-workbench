import Foundation

enum AgentRuntimeContractChecks {
    static func run() throws {
        try checkPolicyBoundary()
        try checkCMCProviderRequiresBackendSnapshot()
        try checkFixtureMarketSnapshotIsNotPromoted()
        try checkDaemonAuthTokenLoading()
    }

    private static func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        if !condition() { throw ContractCheckError(message) }
    }

    private static func checkPolicyBoundary() throws {
        let gate = PolicyGate()
        try require(gate.check(.runLiveWeChatCLI).status == "blocked", "run_live_wechat_cli must remain blocked")
        try require(gate.check(.readLiveWeChat).status == "pass", "read_live_wechat read-only refresh should pass")
        try require(gate.check(.readWeChatCLIExportFile).status == "pass", "wechat export import should pass within local boundary")
        try require(gate.check(.requestMarketBridgeRefresh).status == "pass", "CMC bridge refresh should pass")
        try require(gate.check(.queryCMCMCP).status == "pass", "CMC normalized query policy should pass")
    }

    private static func checkCMCProviderRequiresBackendSnapshot() throws {
        let temp = try temporaryDirectory()
        let store = MarketSnapshotStore(pathResolver: RuntimePathResolver(root: temp))
        let market = CMCMarketDataProvider(refreshBridge: CMCRefreshBridge(store: store))
            .fetchMarketData(for: ["BTC"], date: contractDate)
        try require(market.status != "enabled", "Swift CMC provider must not synthesize enabled live data")
        try require(market.assets.isEmpty, "Swift CMC provider should wait for backend normalized market artifacts")
    }

    private static func checkFixtureMarketSnapshotIsNotPromoted() throws {
        let temp = try temporaryDirectory()
        let store = MarketSnapshotStore(snapshotURL: temp.appendingPathComponent("market.json"))
        let snapshot = MarketDataSnapshot(
            status: "enabled",
            sourceName: "Fixture Store",
            provider: "fixtureProvider",
            generatedAt: AgentDateFormatting.isoString(contractDate),
            observedAt: AgentDateFormatting.isoString(contractDate),
            expiresAt: AgentDateFormatting.isoString(contractDate.addingTimeInterval(3600)),
            freshness: "fixture",
            lastVerifiedAt: AgentDateFormatting.isoString(contractDate),
            assets: [
                MarketAsset(
                    symbol: "BTC",
                    name: "Bitcoin",
                    priceUSD: 1,
                    percentChange24h: 0,
                    volume24hUSD: 0,
                    marketCapUSD: 0,
                    source: "fixture",
                    isLive: false
                )
            ],
            evidence: ["fixture"],
            upstreamStatus: "fixture"
        )
        try store.write(snapshot)
        let loaded = try requireSnapshot(store.load(now: contractDate))
        try require(loaded.status == "degraded", "fixture market snapshot must be degraded")
        try require(loaded.freshness == "fixture", "fixture market snapshot must not become fresh")
        try require(loaded.assets.allSatisfy { !$0.isLive }, "fixture market assets must not become live")
    }

    private static func checkDaemonAuthTokenLoading() throws {
        let temp = try temporaryDirectory()
        let authDir = temp.appendingPathComponent("runtime/agent", isDirectory: true)
        try FileManager.default.createDirectory(at: authDir, withIntermediateDirectories: true)
        let authURL = authDir.appendingPathComponent("auth-token.json")
        let payload = #"{"schemaVersion":"agent-daemon-auth-token-v1","token":"contract-token"}"#
        try payload.data(using: .utf8)?.write(to: authURL)
        try require(AgentDaemonAuth.loadToken(pathResolver: RuntimePathResolver(root: temp)) == "contract-token", "daemon auth token must load from runtime/agent/auth-token.json")
    }

    private static var contractDate: Date {
        ISO8601DateFormatter().date(from: "2026-05-24T00:00:00Z")!
    }

    private static func requireSnapshot(_ snapshot: MarketDataSnapshot?) throws -> MarketDataSnapshot {
        guard let snapshot else { throw ContractCheckError("expected snapshot") }
        return snapshot
    }

    private static func temporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("wechat-radar-contract-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
}

struct ContractCheckError: LocalizedError {
    let message: String

    init(_ message: String) {
        self.message = message
    }

    var errorDescription: String? { message }
}
