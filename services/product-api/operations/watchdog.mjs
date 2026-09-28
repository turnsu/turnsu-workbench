import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function runLocalWatchdog({
  statePath,
  check,
  notify = async () => {},
  clock = () => new Date().toISOString(),
  threshold = 3,
} = {}) {
  if (typeof statePath !== "string" || statePath.length === 0 || typeof check !== "function"
    || typeof notify !== "function" || typeof clock !== "function"
    || !Number.isInteger(threshold) || threshold < 1 || threshold > 100) {
    throw new TypeError("watchdog_options_invalid");
  }
  const previous = await readState(statePath);
  let report;
  try { report = await check(); }
  catch { report = { status: "not_ready", checks: [] }; }
  const ready = report?.status === "ready";
  const consecutiveFailures = ready ? 0 : Math.min((previous?.consecutiveFailures ?? 0) + 1, 1_000_000);
  const checkedAt = new Date(clock()).toISOString();
  const state = Object.freeze({
    schemaVersion: "looloomi-watchdog-state-v1",
    status: ready ? "ready" : "not_ready",
    checkedAt,
    consecutiveFailures,
    alertActive: consecutiveFailures >= threshold,
    failedChecks: safeFailedChecks(report?.checks),
  });
  await atomicState(statePath, state);
  if (consecutiveFailures === threshold) await notify(state);
  return state;
}

async function readState(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return value?.schemaVersion === "looloomi-watchdog-state-v1" ? value : null;
  } catch { return null; }
}

async function atomicState(path, state) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.partial-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

function safeFailedChecks(checks) {
  if (!Array.isArray(checks)) return [];
  return checks.filter((item) => item?.ok === false && /^[a-z][a-z0-9_]{0,63}$/.test(item?.name || ""))
    .map((item) => item.name).sort().slice(0, 64);
}
