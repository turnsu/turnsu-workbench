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

export async function collectProductOperationalMetrics({ store, registry } = {}) {
  if (!registry || typeof registry.set !== "function") throw new TypeError("metrics_registry_required");
  if (store?.persistenceDriver !== "postgres") throw new TypeError("postgres_product_store_required");
  const operations = store.createOperationalReadiness?.();
  if (!operations?.collectMetrics) {
    registry.set("workbench_postgres_up", {}, 0);
    return { ok: false };
  }
  try {
    const metrics = await operations.collectMetrics();
    registry.set("workbench_postgres_up", {}, 1);
    registry.set("workbench_run_queue_depth", {}, metrics.runQueued);
    registry.set("workbench_run_claimed", {}, metrics.runClaimed);
    registry.set("workbench_agent_turn_queue_depth", {}, metrics.turnQueued);
    registry.set("workbench_agent_turn_running", {}, metrics.turnRunning);
    registry.set("workbench_capability_leases_active", {}, metrics.activeLeases);
    for (const [status, count] of Object.entries(metrics.memoryCandidates)) {
      registry.set("workbench_memory_candidates_total", { status }, count);
    }
    for (const [status, count] of Object.entries(metrics.invocations)) {
      registry.set("workbench_execution_invocations_total", { status }, count);
    }
    registry.set("workbench_execution_attempt_duration_ms_count", {}, metrics.attemptDurationCount);
    registry.set("workbench_execution_attempt_duration_ms_sum", {}, metrics.attemptDurationSum);
    registry.set("workbench_oldest_active_lease_age_seconds", {}, metrics.oldestActiveLeaseAgeSeconds);
    return { ok: true };
  } catch {
    registry.set("workbench_postgres_up", {}, 0);
    return { ok: false };
  }
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
