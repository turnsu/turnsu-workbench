import assert from "node:assert/strict";
import test from "node:test";

import { mergeSkillDraftProposal } from "../../src/agents/agent-proposal-merge.mjs";

function draft() {
  return {
    skillDraftId: "skill-draft-a",
    revision: 3,
    name: "Research",
    description: "Base description",
    category: "research",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false,
    },
    risk: { level: "low", externalAction: false, summary: "Read only." },
    dependencies: [],
    connectionRequirements: [],
  };
}

test("Skill proposal rebases non-overlapping editable fields", () => {
  const base = draft();
  const current = { ...structuredClone(base), description: "Collaborator description", revision: 4 };
  const result = mergeSkillDraftProposal({
    base,
    current,
    operations: [{ op: "replace", path: "/category", value: "analysis" }],
  });

  assert.equal(result.status, "merged");
  assert.deepEqual(result.patch, { category: "analysis" });
  assert.equal(current.description, "Collaborator description");
});

test("Skill proposal persists same-field conflict evidence without a patch", () => {
  const base = draft();
  const current = { ...structuredClone(base), description: "Collaborator description", revision: 4 };
  const result = mergeSkillDraftProposal({
    base,
    current,
    operations: [{ op: "replace", path: "/description", value: "Agent description" }],
  });

  assert.equal(result.status, "conflicted");
  assert.equal(result.patch, null);
  assert.equal(result.conflicts[0].path, "/description");
  assert.match(result.conflicts[0].currentValueHash, /^sha256:[a-f0-9]{64}$/);
});

test("Skill proposal cannot mutate ownership or execution metadata", () => {
  assert.throws(
    () => mergeSkillDraftProposal({
      base: draft(),
      current: draft(),
      operations: [{ op: "replace", path: "/updatedBy", value: "attacker" }],
    }),
    (error) => error.code === "agent_proposal_path_forbidden",
  );
});
