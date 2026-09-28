import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import test from "node:test";

import { runLocalWatchdog } from "../../operations/watchdog.mjs";

test("watchdog persists bounded state, alerts on third consecutive failure, and clears on recovery", async (t) => {
  const root = await mkdtemp("/private/tmp/looloomi-watchdog-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = `${root}/state/watchdog.json`;
  const alerts = [];
  const failed = () => ({ status: "not_ready", checks: [
    { name: "postgres", ok: false, secret: "must-not-persist" },
    { name: "invalid-name!", ok: false },
  ] });
  for (let index = 0; index < 3; index += 1) {
    await runLocalWatchdog({
      statePath,
      check: failed,
      notify: async (state) => alerts.push(state),
      clock: () => `2026-07-17T00:00:0${index}.000Z`,
    });
  }
  const persisted = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(persisted.consecutiveFailures, 3);
  assert.equal(persisted.alertActive, true);
  assert.deepEqual(persisted.failedChecks, ["postgres"]);
  assert.equal(JSON.stringify(persisted).includes("must-not-persist"), false);
  assert.equal(alerts.length, 1);
  assert.equal((await stat(statePath)).mode & 0o077, 0);

  const recovered = await runLocalWatchdog({
    statePath,
    check: async () => ({ status: "ready", checks: [] }),
    notify: async () => alerts.push("unexpected"),
    clock: () => "2026-07-17T00:01:00.000Z",
  });
  assert.equal(recovered.consecutiveFailures, 0);
  assert.equal(recovered.alertActive, false);
  assert.equal(alerts.length, 1);
});
