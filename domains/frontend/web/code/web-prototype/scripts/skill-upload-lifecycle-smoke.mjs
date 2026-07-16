import assert from "node:assert/strict";

import {
  skillPackagePromotionData,
} from "../src/api/queries.js";

const readyDraft = { upload: { uploadId: "upload-ready", state: "ready_draft" } };
assert.deepEqual(
  skillPackagePromotionData(readyDraft),
  {},
  "ready_draft promotion must keep the existing empty request body",
);

const executableDraft = { upload: { uploadId: "upload-executable", state: "needs_decision" } };
assert.throws(
  () => skillPackagePromotionData(executableDraft),
  (error) => error?.code === "upload_review_acknowledgement_required",
  "needs_decision must not promote before explicit acknowledgement",
);

assert.deepEqual(
  skillPackagePromotionData(executableDraft, { permissionAcknowledged: true }),
  { permissionAcknowledged: true },
  "explicit acknowledgement must be the only path that adds permissionAcknowledged:true",
);

console.log("skill_upload_lifecycle_smoke=pass");
