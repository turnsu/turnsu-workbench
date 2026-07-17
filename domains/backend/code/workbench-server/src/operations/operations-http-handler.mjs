import { collectMongoOperationalMetrics } from "./metrics-registry.mjs";

const OPERATIONS_PATHS = new Set(["/healthz", "/readyz", "/metrics"]);

export function createOperationsHttpHandler({ readiness, metrics, store, logger, clock = () => Date.now() } = {}) {
  if (!readiness?.check || !metrics?.renderPrometheus || !logger?.info || typeof clock !== "function") {
    throw new TypeError("operations_http_dependencies_invalid");
  }
  return async function operationsHttpHandler(req, res) {
    const pathname = new URL(req.url, "http://127.0.0.1").pathname;
    if (!OPERATIONS_PATHS.has(pathname)) return false;
    const startedAt = clock();
    if (!["GET", "HEAD"].includes(req.method)) {
      writeJson(req, res, 405, { status: "method_not_allowed" }, { allow: "GET, HEAD" });
      observe(req, res, pathname, startedAt);
      return true;
    }
    if (pathname === "/healthz") {
      metrics.increment("workbench_health_requests_total", { status: "ok" });
      writeJson(req, res, 200, { status: "alive" });
      observe(req, res, pathname, startedAt);
      return true;
    }
    if (pathname === "/readyz") {
      const report = await readiness.check();
      metrics.increment("workbench_readiness_requests_total", { status: report.ready ? "ready" : "not_ready" });
      writeJson(req, res, report.ready ? 200 : 503, {
        status: report.ready ? "ready" : "not_ready",
        checks: Object.fromEntries(report.checks.map((item) => [item.name, item.status])),
      });
      observe(req, res, pathname, startedAt);
      return true;
    }
    if (store) await collectMongoOperationalMetrics({ store, registry: metrics }).catch(() => {});
    const body = metrics.renderPrometheus();
    res.writeHead(200, {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(body),
    });
    if (req.method !== "HEAD") res.end(body);
    else res.end();
    observe(req, res, pathname, startedAt);
    return true;
  };

  function observe(req, res, operation, startedAt) {
    const durationMs = Math.max(0, clock() - startedAt);
    const status = String(res.statusCode);
    metrics.increment("workbench_http_requests_total", { operation: operation.slice(1), status });
    metrics.observe("workbench_http_request_duration_ms", { operation: operation.slice(1), status }, durationMs);
    logger.info("operations.request.completed", {
      method: req.method,
      operation: operation.slice(1),
      statusCode: res.statusCode,
      durationMs,
      component: "operations",
    });
  }
}

function writeJson(req, res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  if (req.method !== "HEAD") res.end(body);
  else res.end();
}
