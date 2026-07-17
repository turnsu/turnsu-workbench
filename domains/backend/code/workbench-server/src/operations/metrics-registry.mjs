const METRIC_NAME = /^[a-z][a-z0-9_]{0,127}$/;
const LABEL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const LABEL_VALUE = /^[A-Za-z0-9_.:-]{0,128}$/;

export class MetricsRegistry {
  #metrics = new Map();

  increment(name, labels = {}, value = 1) {
    assertMetric(name, labels, value);
    const key = metricKey(name, labels);
    const current = this.#metrics.get(key) ?? { name, labels: Object.freeze({ ...labels }), value: 0 };
    current.value += value;
    this.#metrics.set(key, current);
    return current.value;
  }

  set(name, labels = {}, value) {
    assertMetric(name, labels, value);
    this.#metrics.set(metricKey(name, labels), { name, labels: Object.freeze({ ...labels }), value });
    return value;
  }

  observe(name, labels = {}, value) {
    if (!Number.isFinite(value) || value < 0) throw new TypeError("metric_observation_invalid");
    this.increment(`${name}_count`, labels, 1);
    this.increment(`${name}_sum`, labels, value);
  }

  snapshot() {
    return [...this.#metrics.values()]
      .sort((left, right) => metricKey(left.name, left.labels).localeCompare(metricKey(right.name, right.labels)))
      .map((item) => ({ name: item.name, labels: { ...item.labels }, value: item.value }));
  }

  renderPrometheus() {
    return `${this.snapshot().map(({ name, labels, value }) => (
      `${name}${renderLabels(labels)} ${Number.isInteger(value) ? value : value.toFixed(6)}`
    )).join("\n")}\n`;
  }
}

export async function collectMongoOperationalMetrics({ store, registry, clock = () => new Date() } = {}) {
  if (!registry || typeof registry.set !== "function") throw new TypeError("metrics_registry_required");
  try {
    const db = await store.connect();
    const now = clock();
    const [
      runQueued, runClaimed, turnQueued, turnRunning, activeLeases, oldestLease,
      memoryStatuses, invocationStatuses, attemptDurations,
    ] = await Promise.all([
      db.collection("run_jobs").countDocuments({ status: "queued" }),
      db.collection("run_jobs").countDocuments({ status: "claimed" }),
      db.collection("agent_turns").countDocuments({ status: "queued" }),
      db.collection("agent_turns").countDocuments({ status: "running" }),
      db.collection("capability_leases").countDocuments({ status: "active" }),
      db.collection("capability_leases").find({ status: "active" }, { projection: { issuedAt: 1, createdAt: 1 } })
        .sort({ issuedAt: 1, createdAt: 1 }).limit(1).next(),
      groupedCounts(db.collection("memory_candidates")),
      groupedCounts(db.collection("execution_invocations")),
      db.collection("execution_attempts").aggregate([
        { $match: { startedAt: { $exists: true }, finishedAt: { $exists: true } } },
        { $project: {
          durationMs: { $subtract: [
            { $convert: { input: "$finishedAt", to: "date", onError: null, onNull: null } },
            { $convert: { input: "$startedAt", to: "date", onError: null, onNull: null } },
          ] },
        } },
        { $match: { durationMs: { $gte: 0 } } },
        { $group: { _id: null, count: { $sum: 1 }, sum: { $sum: "$durationMs" } } },
      ]).toArray(),
    ]);
    registry.set("workbench_mongo_up", {}, 1);
    registry.set("workbench_run_queue_depth", {}, runQueued);
    registry.set("workbench_run_claimed", {}, runClaimed);
    registry.set("workbench_agent_turn_queue_depth", {}, turnQueued);
    registry.set("workbench_agent_turn_running", {}, turnRunning);
    registry.set("workbench_capability_leases_active", {}, activeLeases);
    for (const status of ["pending", "promoted", "rejected"]) {
      registry.set("workbench_memory_candidates_total", { status }, memoryStatuses.get(status) ?? 0);
    }
    for (const status of [
      "queued", "running", "completed", "failed", "cancelled", "blocked", "partial", "timeout",
      "permission_denied", "sandbox_unavailable", "remote_backend_unavailable",
    ]) {
      registry.set("workbench_execution_invocations_total", { status }, invocationStatuses.get(status) ?? 0);
    }
    registry.set("workbench_execution_attempt_duration_ms_count", {}, attemptDurations[0]?.count ?? 0);
    registry.set("workbench_execution_attempt_duration_ms_sum", {}, attemptDurations[0]?.sum ?? 0);
    const issuedAt = oldestLease?.issuedAt ?? oldestLease?.createdAt;
    const ageSeconds = issuedAt ? Math.max(0, (now.getTime() - new Date(issuedAt).getTime()) / 1000) : 0;
    registry.set("workbench_oldest_active_lease_age_seconds", {}, Number.isFinite(ageSeconds) ? ageSeconds : 0);
    return { ok: true };
  } catch {
    registry.set("workbench_mongo_up", {}, 0);
    return { ok: false };
  }
}

async function groupedCounts(collection) {
  const rows = await collection.aggregate([
    { $match: { status: { $type: "string" } } },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]).toArray();
  return new Map(rows.filter((item) => typeof item?._id === "string" && Number.isFinite(item?.count))
    .map((item) => [item._id, item.count]));
}

function assertMetric(name, labels, value) {
  if (!METRIC_NAME.test(name || "") || !Number.isFinite(value) || value < 0
    || !labels || typeof labels !== "object" || Array.isArray(labels)
    || Object.entries(labels).some(([key, item]) => !LABEL_NAME.test(key) || !LABEL_VALUE.test(String(item)))) {
    throw new TypeError("metric_invalid");
  }
}

function metricKey(name, labels) {
  return `${name}\u0000${Object.entries(labels).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`).join("\u0000")}`;
}

function renderLabels(labels) {
  const entries = Object.entries(labels).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return "";
  return `{${entries.map(([key, value]) => `${key}="${String(value)}"`).join(",")}}`;
}
