import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  RUNTIME_ROOT_ENV,
  resolveRuntimePaths,
} from "./runtime-paths.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const agentRuntimeRoot = resolve(testDir, "..");
const expectedRepoRoot = resolve(agentRuntimeRoot, "../..");
const tempRuntimeRoot = mkdtempSync(join(tmpdir(), "looloomi-runtime-paths-"));

try {
  const defaults = resolveRuntimePaths({ env: {} });
  assert.equal(defaults.repoRoot, expectedRepoRoot);
  assert.equal(defaults.agentRuntimeRoot, agentRuntimeRoot);
  assert.equal(defaults.runtimeRoot, join(expectedRepoRoot, "runtime"));
  assert.equal(defaults.agentDataRoot, join(expectedRepoRoot, "runtime", "agent"));

  assert.throws(
    () => resolveRuntimePaths({ env: { [RUNTIME_ROOT_ENV]: tempRuntimeRoot } }),
    /runtime_override_requires_test_mode/,
  );
  assert.throws(
    () => resolveRuntimePaths({
      env: { TURNSU_AGENT_TEST_MODE: "1", [RUNTIME_ROOT_ENV]: "relative/runtime" },
    }),
    /runtime_override_must_be_absolute/,
  );
  assert.throws(
    () => resolveRuntimePaths({ env: { TURNSU_AGENT_TEST_MODE: "1" } }),
    /test_runtime_override_required/,
  );
  assert.throws(
    () => resolveRuntimePaths({
      env: { TURNSU_AGENT_TEST_MODE: "1", [RUNTIME_ROOT_ENV]: join(expectedRepoRoot, "runtime-test") },
    }),
    /runtime_override_must_be_temporary/,
  );
  assert.throws(
    () => resolveRuntimePaths({
      env: { TURNSU_AGENT_TEST_MODE: "1", [RUNTIME_ROOT_ENV]: join(dirname(tmpdir()), "outside-system-temp") },
    }),
    /runtime_override_must_be_temporary/,
  );

  const isolated = resolveRuntimePaths({
    env: { TURNSU_AGENT_TEST_MODE: "1", [RUNTIME_ROOT_ENV]: tempRuntimeRoot },
  });
  assert.equal(isolated.runtimeRoot, tempRuntimeRoot);
  assert.equal(isolated.agentDataRoot, join(tempRuntimeRoot, "agent"));
  assert.equal(isolated.opsRoot, join(tempRuntimeRoot, "ops"));
  assert.equal(isolated.isTestMode, true);
  assert.equal(isolated.usesRuntimeOverride, true);

  const childEnv = { ...process.env };
  delete childEnv.TURNSU_AGENT_TEST_MODE;
  delete childEnv[RUNTIME_ROOT_ENV];
  const cli = spawnSync(process.execPath, [
    join(agentRuntimeRoot, "lib", "runtime-paths.mjs"),
    "--print",
    "repoRoot",
  ], {
    cwd: tempRuntimeRoot,
    env: childEnv,
    encoding: "utf8",
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout.trim(), expectedRepoRoot);

  console.log("runtime_paths=pass");
} finally {
  rmSync(tempRuntimeRoot, { recursive: true, force: true });
}
