#!/usr/bin/env node
import { assertSupportedNodeVersion } from "../src/runtime/node-version-gate.mjs";
import { startWorkbenchServer } from "../src/server.mjs";

assertSupportedNodeVersion();

let runner;
try {
  ({ runner } = await import("../src/runner/index.mjs"));
} catch {
  throw new Error("workflow_runner_module_not_available: start the Product API after the Runner wave is merged.");
}

await startWorkbenchServer({ runner, distDirectory: process.env.WORKBENCH_WEB_DIST });
