const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
const SAFE_TOKEN = /^[A-Za-z0-9_.:/-]{1,256}$/;
const SAFE_FIELDS = new Set([
  "requestId", "traceId", "method", "operation", "statusCode", "durationMs", "code",
  "component", "invocationId", "attemptId", "runId", "sessionId", "turnId", "count",
]);

export function createJsonLogger({ stream = process.stdout, clock = () => new Date().toISOString(), level = "info" } = {}) {
  if (!stream || typeof stream.write !== "function" || typeof clock !== "function" || !Object.hasOwn(LEVELS, level)) {
    throw new TypeError("json_logger_options_invalid");
  }
  const write = (entryLevel, event, fields = {}) => {
    if (LEVELS[entryLevel] < LEVELS[level]) return false;
    if (!/^[a-z][a-z0-9._-]{0,127}$/.test(event || "")) throw new TypeError("log_event_invalid");
    const record = {
      timestamp: clock(),
      level: entryLevel,
      event,
      ...sanitizeFields(fields),
    };
    stream.write(`${JSON.stringify(record)}\n`);
    return true;
  };
  return Object.freeze({
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
  });
}

function sanitizeFields(fields) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return {};
  return Object.fromEntries(Object.entries(fields)
    .filter(([key, value]) => SAFE_FIELDS.has(key) && safeValue(key, value))
    .map(([key, value]) => [key, value]));
}

function safeValue(key, value) {
  if (["statusCode", "durationMs", "count"].includes(key)) return Number.isFinite(value) && value >= 0;
  return typeof value === "string" && SAFE_TOKEN.test(value);
}
