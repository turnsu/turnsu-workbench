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
        let environment = ProcessInfo.processInfo.environment
        for key in ["LOOLOOMI_PROJECT_ROOT", "WECHAT_INTELLIGENCE_PROJECT_ROOT", "WECHAT_RADAR_PROJECT_ROOT"] {
            if let value = environment[key],
               let root = projectRootCandidate(startingAt: URL(fileURLWithPath: value), fileManager: fileManager) {
                return root
            }
        }

        if environment["LOOLOOMI_USE_APP_SUPPORT_RUNTIME"] == "1" {
            return appSupportRuntimeRoot(fileManager: fileManager)
        }

        if Bundle.main.object(forInfoDictionaryKey: "LooloomiUseAppSupportRuntime") as? Bool == true {
            return appSupportRuntimeRoot(fileManager: fileManager)
        }

        if let value = Bundle.main.object(forInfoDictionaryKey: "LooloomiProjectRoot") as? String,
           let root = projectRootCandidate(startingAt: URL(fileURLWithPath: value), fileManager: fileManager) {
            return root
        }

        let candidates = [
            URL(fileURLWithPath: fileManager.currentDirectoryPath),
            Bundle.main.bundleURL,
            Bundle.main.executableURL,
            Bundle.main.resourceURL
        ].compactMap { $0 }

        for candidate in candidates {
            if let root = projectRootCandidate(startingAt: candidate, fileManager: fileManager) {
                return root
            }
        }

        let support = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        return support?.appendingPathComponent("WeChatIntelligenceRadarMVP", isDirectory: true)
            ?? URL(fileURLWithPath: fileManager.currentDirectoryPath)
    }

    private static func appSupportRuntimeRoot(fileManager: FileManager = .default) -> URL {
        let support = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        return support?.appendingPathComponent("WeChatIntelligenceRadarMVP", isDirectory: true)
            ?? URL(fileURLWithPath: fileManager.currentDirectoryPath)
    }

    static func projectRootCandidate(startingAt start: URL, fileManager: FileManager = .default) -> URL? {
        var candidate = start.standardizedFileURL
        var isDirectory = ObjCBool(false)
        if fileManager.fileExists(atPath: candidate.path, isDirectory: &isDirectory), !isDirectory.boolValue {
            candidate.deleteLastPathComponent()
        }

        for _ in 0..<12 {
            if fileManager.fileExists(atPath: candidate.appendingPathComponent("Package.swift").path) {
                return candidate
            }
            let previous = candidate
            candidate.deleteLastPathComponent()
            if candidate.path == previous.path { break }
        }
        return nil
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
