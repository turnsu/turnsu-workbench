import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  MEETING_ACTION_EXTRACTOR_EXECUTION_REF,
  MEETING_ACTION_EXTRACTOR_INPUT_SCHEMA,
  MEETING_ACTION_EXTRACTOR_OUTPUT_SCHEMA,
} from "../../../../../agent/code/agent-runtime/public-api.mjs";

import { inspectSkillPackage } from "../validation/skill-package-inspector.mjs";

export function createTrustedSkillActivationRegistry({ agentRuntimeRoot } = {}) {
  if (typeof agentRuntimeRoot !== "string" || agentRuntimeRoot.length === 0) {
    throw new TypeError("trusted_skill_activation_runtime_root_required");
  }
  const packageFiles = [{
    path: "SKILL.md",
    content: readFileSync(join(agentRuntimeRoot, "skills", "meeting-action-extractor.md"), "utf8"),
  }];
  const inspection = inspectSkillPackage({ files: packageFiles });
  if (inspection.status !== "passed") {
    throw new Error("trusted_skill_activation_package_invalid");
  }
  const activation = Object.freeze({
    packageContentHash: inspection.contentHash,
    manifest: inspection.manifest,
    executionRef: MEETING_ACTION_EXTRACTOR_EXECUTION_REF,
    inputSchema: MEETING_ACTION_EXTRACTOR_INPUT_SCHEMA,
    outputSchema: MEETING_ACTION_EXTRACTOR_OUTPUT_SCHEMA,
  });
  return Object.freeze({
    resolve(inspectionSummary) {
      if (inspectionSummary?.contentHash !== activation.packageContentHash) return null;
      return structuredClone(activation);
    },
  });
}
