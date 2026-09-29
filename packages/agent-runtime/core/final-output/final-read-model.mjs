// This projection describes execution output. Product authorization and commit decisions
// remain in the Product service; output generation does not grant mutation authority.
export function buildAgentFinalReadModelV1({ runID, taskID, sessionID, status, finalText, finalTextSource, toolObservations, artifactPath, now = () => new Date().toISOString() }) {
  return {
    schemaVersion: 'agent-final-read-model-v1', runID, taskID, sessionID, status,
    finalText, finalTextSource,
    outputGuardStatus: toolObservations?.outputGuard?.status || 'unknown',
    outputGuardReason: toolObservations?.outputGuard?.reason || null,
    modelRouteSummary: toolObservations?.modelRouteSummary || null,
    generatedAt: now(), artifactPath,
  };
}
