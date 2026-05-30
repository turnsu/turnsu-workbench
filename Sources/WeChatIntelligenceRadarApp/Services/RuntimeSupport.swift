import Foundation

enum AgentDateFormatting {
    private static func iso8601Formatter() -> ISO8601DateFormatter {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }

    static func displayString(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd HH:mm"
        return formatter.string(from: date)
    }

    static func isoString(_ date: Date) -> String {
        iso8601Formatter().string(from: date)
    }

    static func parse(_ value: String) -> Date? {
        iso8601Formatter().date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}

struct RuntimePathResolver {
    let fileManager: FileManager
    let root: URL

    init(fileManager: FileManager = .default, root: URL? = nil) {
        self.fileManager = fileManager
        self.root = root ?? Self.findProjectRoot(fileManager: fileManager)
    }

    var runtimeDirectory: URL {
        root.appendingPathComponent("runtime", isDirectory: true)
    }

    var marketDirectory: URL {
        runtimeDirectory.appendingPathComponent("market", isDirectory: true)
    }

    var marketSnapshotURL: URL {
        marketDirectory.appendingPathComponent("latest-market-snapshot.json")
    }

    var runsDirectory: URL {
        runtimeDirectory.appendingPathComponent("runs", isDirectory: true)
    }

    static func findProjectRoot(fileManager: FileManager = .default) -> URL {
        var candidate = URL(fileURLWithPath: fileManager.currentDirectoryPath)
        for _ in 0..<8 {
            let packageFile = candidate.appendingPathComponent("Package.swift")
            if fileManager.fileExists(atPath: packageFile.path) {
                return candidate
            }
            candidate.deleteLastPathComponent()
        }

        let support = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        return support?.appendingPathComponent("WeChatIntelligenceRadarMVP", isDirectory: true)
            ?? URL(fileURLWithPath: fileManager.currentDirectoryPath)
    }
}

extension JSONEncoder {
    static func agentArtifactEncoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return encoder
    }
}

extension JSONDecoder {
    static func agentArtifactDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}
