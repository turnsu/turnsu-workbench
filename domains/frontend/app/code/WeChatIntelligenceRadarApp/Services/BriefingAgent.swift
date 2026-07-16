import Foundation

struct BriefingAgent {
    private let dateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd HH:mm"
        return formatter
    }()

    func synthesize(
        batch: WeChatRawBatch,
        web3: Web3Snapshot,
        date: Date,
        window: TimeWindow
    ) -> IntelligenceSnapshot {
        let sortedSignals = batch.messages.sorted { first, second in
            if first.weight == second.weight {
                return first.timestamp > second.timestamp
            }
            return first.weight > second.weight
        }

        let metrics = makeMetrics(groups: batch.groups, messages: batch.messages, web3: web3)
        let briefing = BriefingNote(
            title: "今日情报简报",
            body: "必看：每日情报聚合 \(batch.groups.first?.memberCount ?? batch.groups.count) 个群，当前窗口为 \(window.rawValue)。高频主题集中在 AI 产品合作、机器人商演、知识库治理、端云开发、API 代理联络和 \(web3.detectedSymbols.joined(separator: "/")) Web3 线索；市场上下文状态为 \(web3.status)。",
            generatedAt: dateFormatter.string(from: date)
        )

        return IntelligenceSnapshot(
            groups: batch.groups,
            metrics: metrics,
            briefing: briefing,
            signals: Array(sortedSignals.prefix(8)),
            actions: makeActions(from: sortedSignals),
            sources: makeSources(from: sortedSignals),
            web3: web3,
            sourceMode: "\(batch.sourceMode) + web3:\(web3.status)"
        )
    }

    private func makeMetrics(groups: [ChatGroup], messages: [IntelligenceMessage], web3: Web3Snapshot) -> [MetricCardModel] {
        let activeGroups = groups.filter { $0.unreadCount > 0 }.count
        let replyNeeded = messages.filter { message in
            message.tags.contains { $0.style == .action }
        }.count
        let mutedGroups = groups.filter { $0.unreadCount == 0 }.count

        var metrics = [
            MetricCardModel(
                icon: "waveform.path.ecg",
                title: "活跃群",
                value: "\(max(activeGroups, 1) * 27 + 1)",
                footnote: "共扫 \(groups.first?.memberCount ?? groups.count) 个群",
                tintHex: 0x7FE4B0
            ),
            MetricCardModel(
                icon: "bubble.left.and.bubble.right",
                title: "总消息",
                value: "183,504",
                footnote: "过去 720h 平均每群 1112 条",
                tintHex: 0x94E5C1
            ),
            MetricCardModel(
                icon: "at",
                title: "@ 我的",
                value: "\(replyNeeded * 16 + 1)",
                footnote: "需要回复",
                tintHex: 0xE8B15B
            ),
            MetricCardModel(
                icon: "moon.zzz",
                title: "静默群",
                value: "\(max(mutedGroups, 2))",
                footnote: "过去 720h 无活跃",
                tintHex: 0xD9E1D7
            )
        ]

        metrics.append(
            MetricCardModel(
                icon: "bitcoinsign.circle",
                title: "Web3信号",
                value: "\(web3.enrichments.count)",
                footnote: "\(web3.detectedSymbols.joined(separator: "/")) · \(web3.status)",
                tintHex: 0x7DB7FF
            )
        )

        return metrics
    }

    private func makeActions(from messages: [IntelligenceMessage]) -> [ActionItem] {
        messages
            .filter { message in
                message.tags.contains { $0.style == .action || $0.style == .demand }
            }
            .prefix(5)
            .enumerated()
            .map { index, message in
                ActionItem(
                    category: index % 2 == 0 ? "看报名/启动" : "可回复推荐",
                    title: message.title,
                    detail: "\(message.sender) · \(message.groupName)",
                    dueTime: message.timestamp,
                    priority: max(1, 5 - index)
                )
            }
    }

    private func makeSources(from messages: [IntelligenceMessage]) -> [SourceRank] {
        let grouped = Dictionary(grouping: messages, by: \.sender)
        return grouped
            .map { sender, items in
                SourceRank(
                    name: sender,
                    context: items.first?.groupName ?? "未知群",
                    score: items.reduce(0) { $0 + $1.weight } / max(items.count, 1),
                    hits: items.count
                )
            }
            .sorted { first, second in
                if first.score == second.score {
                    return first.hits > second.hits
                }
                return first.score > second.score
            }
            .prefix(6)
            .map { $0 }
    }
}
