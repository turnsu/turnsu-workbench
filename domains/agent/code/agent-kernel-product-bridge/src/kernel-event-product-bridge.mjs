import {
  AgentKernelError,
  KERNEL_EVENT_SCHEMA_VERSION,
} from "../../agent-kernel/src/index.mjs";

/**
 * Routing is intentionally data-only.  MinimalAgentKernel writes
 * model-visible events through SessionPort before callers can observe them;
 * this observer therefore never writes a second transcript.  It routes only
 * safe metadata to telemetry and immutable Artifact references to a Product
 * artifact port.
 */
export function classifyKernelEventForProduct(event) {
  if (!event || typeof event !== "object" || event.schemaVersion !== KERNEL_EVENT_SCHEMA_VERSION
    || typeof event.type !== "string" || typeof event.runId !== "string"
    || typeof event.session?.sessionId !== "string") {
    throw new AgentKernelError("product_kernel_event_invalid");
  }
  const destinations = ["telemetry"];
  if (event.modelVisible === true) destinations.unshift("session_ledger");
  const artifactRefs = collectArtifactRefs(event.payload);
  if (artifactRefs.length > 0) destinations.push("artifact");
  return Object.freeze({
    destinations: Object.freeze(destinations),
    artifactRefs: Object.freeze(artifactRefs.map((item) => Object.freeze({ ...item }))),
    telemetry: Object.freeze({
      schemaVersion: "agent-kernel-product-telemetry-v1",
      runId: event.runId,
      sessionId: event.session.sessionId,
      ...(event.session.branchId === null ? {} : { branchId: event.session.branchId }),
      sequence: event.sequence,
      type: event.type,
      modelVisible: event.modelVisible === true,
      occurredAt: event.occurredAt,
    }),
  });
}

export class ProductKernelEventObserver {
  #telemetry;
  #artifacts;

  constructor({ telemetry = null, artifacts = null } = {}) {
    if (telemetry !== null && typeof telemetry.record !== "function") {
      throw new AgentKernelError("product_kernel_telemetry_port_invalid");
    }
    if (artifacts !== null && typeof artifacts.recordReferences !== "function") {
      throw new AgentKernelError("product_kernel_artifact_port_invalid");
    }
    this.#telemetry = telemetry;
    this.#artifacts = artifacts;
  }

  async observe(event) {
    const route = classifyKernelEventForProduct(event);
    await this.#telemetry?.record(structuredClone(route.telemetry));
    if (route.artifactRefs.length > 0) {
      await this.#artifacts?.recordReferences({
        event: structuredClone(route.telemetry),
        artifactRefs: route.artifactRefs.map((item) => ({ ...item })),
      });
    }
    return route;
  }
}

function collectArtifactRefs(payload) {
  const candidates = [];
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    if (typeof payload.artifactId === "string") candidates.push({ artifactId: payload.artifactId });
    if (Array.isArray(payload.artifactRefs)) candidates.push(...payload.artifactRefs);
  }
  const seen = new Set();
  const values = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || typeof candidate.artifactId !== "string"
      || !candidate.artifactId || seen.has(candidate.artifactId)) continue;
    seen.add(candidate.artifactId);
    values.push({ artifactId: candidate.artifactId });
  }
  return values;
}
