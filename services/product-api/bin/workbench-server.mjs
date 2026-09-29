#!/usr/bin/env node
import { assertSupportedNodeVersion } from "../src/runtime/node-version-gate.mjs";
import { runProductionWorkbenchServerCli } from "../src/production-composition.mjs";

assertSupportedNodeVersion();
await runProductionWorkbenchServerCli();
