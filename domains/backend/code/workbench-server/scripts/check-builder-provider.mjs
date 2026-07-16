import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { inspectPiBuilderProviderReadiness } from "../../../../agent/code/agent-runtime/core/proposals/pi-builder-provider-readiness.mjs";

const root = await mkdtemp(join(tmpdir(), "looloomi-builder-provider-check-"));

try {
  const readiness = await inspectPiBuilderProviderReadiness({ agentDir: root });
  process.stdout.write(`builder_provider_status=${readiness.code}\n`);
  process.stdout.write(`builder_provider_available_model_count=${readiness.availableModelCount}\n`);
  if (!readiness.ready) process.exitCode = 2;
} finally {
  await rm(root, { recursive: true, force: true });
}
