export const MINIMUM_NODE_VERSION = Object.freeze({ major: 22, minor: 19, patch: 0 });

export function nodeVersionSatisfiesRuntime(version) {
  const match = String(version || "").match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const current = match.slice(1).map(Number);
  const required = [22, 19, 0];
  for (let index = 0; index < required.length; index += 1) {
    if (current[index] > required[index]) return true;
    if (current[index] < required[index]) return false;
  }
  return true;
}

export function assertSupportedNodeVersion(version = process.version) {
  if (nodeVersionSatisfiesRuntime(version)) return version;
  const error = new Error(`unsupported_node_version:${version}:requires_>=22.19.0`);
  error.code = "unsupported_node_version";
  throw error;
}
