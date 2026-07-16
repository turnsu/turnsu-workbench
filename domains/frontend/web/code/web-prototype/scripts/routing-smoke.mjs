import assert from "node:assert/strict";

import { normalizeWorkbenchRoute, parseWorkbenchPath, workbenchPathFor } from "../src/routing/workbenchRoutes.js";

assert.deepEqual(parseWorkbenchPath("/loops"), { page: "loops" });
assert.deepEqual(parseWorkbenchPath("/loops/new"), { page: "create-loop" });
assert.deepEqual(parseWorkbenchPath("/skills"), { page: "skills" });
assert.deepEqual(parseWorkbenchPath("/skills/skill-1"), { page: "skill-overview", skillId: "skill-1" });
assert.deepEqual(parseWorkbenchPath("/skills/skill-1/edit"), { page: "skill-editor", skillId: "skill-1" });
assert.deepEqual(parseWorkbenchPath("/skills/skill-1/instructions"), { page: "skill-instructions", skillId: "skill-1" });
assert.deepEqual(parseWorkbenchPath("/skills/skill-1/files"), { page: "skill-files", skillId: "skill-1" });
assert.deepEqual(parseWorkbenchPath("/skills/skill-1/tests"), { page: "skill-tests", skillId: "skill-1" });
assert.deepEqual(parseWorkbenchPath("/skills/skill-1/versions"), { page: "skill-versions", skillId: "skill-1" });
assert.deepEqual(parseWorkbenchPath("/library"), { page: "library" });
assert.deepEqual(parseWorkbenchPath("/library/skills/skill-1"), { page: "library-skill-detail", skillId: "skill-1" });
assert.deepEqual(parseWorkbenchPath("/library/loops/loop-1"), { page: "library-loop-detail", loopId: "loop-1" });
assert.deepEqual(parseWorkbenchPath("/builder"), { page: "builder" });
assert.deepEqual(parseWorkbenchPath("/loops/loop-1"), { page: "loop-overview", loopId: "loop-1" });
assert.deepEqual(parseWorkbenchPath("/loops/loop-1/edit"), { page: "builder", loopId: "loop-1" });
assert.deepEqual(parseWorkbenchPath("/loops/loop-1/run"), { page: "run-preflight", loopId: "loop-1" });
assert.deepEqual(parseWorkbenchPath("/loops/loop-1/publish"), { page: "loop-publish", loopId: "loop-1" });
assert.deepEqual(parseWorkbenchPath("/loops/loop-1/updates/skill-version-2"), { page: "loop-update", loopId: "loop-1", skillVersionId: "skill-version-2" });
assert.deepEqual(parseWorkbenchPath("/loops/loop-1/runs/run-2"), { page: "runs", loopId: "loop-1", runId: "run-2" });
assert.equal(workbenchPathFor({ page: "loop-overview", loopId: "loop with spaces" }), "/loops/loop%20with%20spaces");
assert.equal(workbenchPathFor({ page: "create-loop" }), "/loops/new");
assert.deepEqual(normalizeWorkbenchRoute({ page: "runs", loopId: "loop-1", runId: "run-2" }), { page: "runs", loopId: "loop-1", runId: "run-2" });
assert.equal(workbenchPathFor({ page: "builder" }), "/builder");
assert.equal(workbenchPathFor({ page: "skill-overview", skillId: "skill with spaces" }), "/skills/skill%20with%20spaces");
assert.equal(workbenchPathFor({ page: "skill-editor", skillId: "skill-1" }), "/skills/skill-1/edit");
assert.equal(workbenchPathFor({ page: "skill-instructions", skillId: "skill-1" }), "/skills/skill-1/instructions");
assert.equal(workbenchPathFor({ page: "skill-files", skillId: "skill-1" }), "/skills/skill-1/files");
assert.equal(workbenchPathFor({ page: "skill-tests", skillId: "skill-1" }), "/skills/skill-1/tests");
assert.equal(workbenchPathFor({ page: "skill-versions", skillId: "skill-1" }), "/skills/skill-1/versions");
assert.equal(workbenchPathFor({ page: "loop-publish", loopId: "loop-1" }), "/loops/loop-1/publish");
assert.equal(workbenchPathFor({ page: "loop-update", loopId: "loop-1", skillVersionId: "skill-version-2" }), "/loops/loop-1/updates/skill-version-2");
assert.equal(workbenchPathFor({ page: "library-loop-detail", loopId: "loop-1" }), "/library/loops/loop-1");
assert.equal(workbenchPathFor({ page: "library-skill-detail", skillId: "skill-1" }), "/library/skills/skill-1");

console.log("web_routing_smoke=pass");
