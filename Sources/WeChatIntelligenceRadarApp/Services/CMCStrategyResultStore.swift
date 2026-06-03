import Foundation

/// Reads CMC strategist read models from local run artifacts (manifest-first). It scans
/// `runtime/agent/runs/{runID}/cmc-*.json` for a `strategyReadModel` field (schema
/// `cmc-strategist-result-v1`) and decodes the lightweight `CMCStrategistResult`. Raw provider
/// payloads stay in the artifact; only the read model + an artifact pointer reach the UI.
struct CMCStrategyResultStore {
    let resolver: AgentRuntimePathResolver
    let fileManager: FileManager

    init(resolver: AgentRuntimePathResolver = AgentRuntimePathResolver(), fileManager: FileManager = .default) {
        self.resolver = resolver
        self.fileManager = fileManager
    }

    private struct ResultEnvelope: Decodable {
        let strategyReadModel: CMCStrategistResult?
    }

    /// Decode every `strategyReadModel` written under the run directory. Returns [] when the run
    /// has not produced strategy artifacts yet (e.g. Node Phase 2 not run / daemon offline).
    func results(forRunID runID: String?) -> [CMCStrategistResult] {
        guard let runID, !runID.isEmpty else { return [] }
        let runDir = resolver.runsDirectory.appendingPathComponent(runID, isDirectory: true)
        guard let files = try? fileManager.contentsOfDirectory(at: runDir, includingPropertiesForKeys: nil) else {
            return []
        }
        let decoder = JSONDecoder()
        return files
            .filter { $0.lastPathComponent.hasPrefix("cmc-") && $0.pathExtension == "json" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
            .compactMap { url -> CMCStrategistResult? in
                guard let data = try? Data(contentsOf: url),
                      let envelope = try? decoder.decode(ResultEnvelope.self, from: data),
                      var model = envelope.strategyReadModel else {
                    return nil
                }
                model.artifactPath = "runtime/agent/runs/\(runID)/\(url.lastPathComponent)"
                return model
            }
    }
}
