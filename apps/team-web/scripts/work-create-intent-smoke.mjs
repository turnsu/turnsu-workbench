import assert from "node:assert/strict";

import {
  createStableCreationIntent,
  isCreationOutcomeUnknown,
} from "../src/components/work/create-intent.js";

const ids = ["project-create-1", "project-create-2", "project-create-3"];
const intent = createStableCreationIntent({
  kind: "project-create",
  idFactory: () => ids.shift(),
});
const original = { title: "Launch", objective: "Ship safely", members: [{ userId: "user-b" }] };

assert.equal(intent.begin(), "project-create-1");
assert.equal(intent.keyFor(original), "project-create-1");
assert.equal(intent.keyFor({ members: [{ userId: "user-b" }], objective: "Ship safely", title: "Launch" }), "project-create-1");
assert.equal(intent.keyFor({ ...original, objective: "Ship safely this week" }), "project-create-2");
assert.equal(intent.begin(), "project-create-3");
assert.equal(intent.keyFor(original), "project-create-3");
assert.equal(isCreationOutcomeUnknown({ code: "workbench_unreachable", retryable: true }), true);
assert.equal(isCreationOutcomeUnknown({ code: "project_forbidden", retryable: false }), false);

process.stdout.write("work_create_intent_smoke:ok\n");
