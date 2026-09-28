import assert from "node:assert/strict";
import test from "node:test";

import { postgresScenariosForSuite } from "./postgres-regression-manifest.mjs";
import { withPostgresScenario } from "./postgres-scenario-factory.mjs";

const enabled = process.env.WORKBENCH_POSTGRES_INTEGRATION === "1";
const memoryScenarios = postgresScenariosForSuite("durability")
  .filter(({ id }) => id.startsWith("memory.") || id.startsWith("retention."));

test("PostgreSQL Product Memory uses real FTS, product retention, and physical deletion", {
  skip: enabled ? false : "set WORKBENCH_POSTGRES_INTEGRATION=1 explicitly",
}, async () => {
  const identities = [];
  for (const scenario of memoryScenarios) {
    const outcome = await withPostgresScenario({
      scenarioId: scenario.id,
      recordRuntimeIdentity(identity) { identities.push(identity); },
    }, scenario.run);
    assert.equal(outcome.result, "passed");
    assert.equal(Object.values(outcome.invariants).every(Boolean), true);
  }
  assert.equal(identities.length, memoryScenarios.length);
});

test("PostgreSQL FTS diagnostic proves the product search predicate can consume its GIN index", {
  skip: enabled ? false : "set WORKBENCH_POSTGRES_INTEGRATION=1 explicitly",
}, async () => {
  await withPostgresScenario({
    scenarioId: "memory-fts-index-proof",
    recordRuntimeIdentity() {},
  }, async (context) => {
    let sequence = 0;
    const id = (kind) => `fts-${kind}-${++sequence}`;
    const fixture = context.createMemoryFixture({ idFactory: id });
    const actor = { userId: context.principal.userId, workspaceId: context.principal.workspaceId, role: "owner" };
    const subject = { kind: "workflow", subjectId: id("subject") };
    const candidate = await fixture.service.submitCandidate({
      actor: { kind: "user", id: actor.userId }, context: actor,
      input: {
        scope: { kind: "workspace" }, subject, statement: "Planproof zephyrlattice recovery.",
        tags: ["fts"], source: { kind: "agent", sourceId: id("source"), versionId: null, verified: false },
        evidence: [{ kind: "artifact", ref: `artifact:${id("evidence")}`, hash: "sha256:0123456789abcdef" }],
        confidence: 0.8, sensitivity: "low", expiresAt: null,
      },
    });
    await fixture.service.approveCandidate({ candidateId: candidate.candidateId, reason: "FTS proof.", context: actor });
    const plan = await fixture.persistence.explainFullTextSearch({
      workspaceId: actor.workspaceId, scopes: ["workspace"], text: "zephyrlattice recovery", tags: [],
    });
    assert.match(JSON.stringify(plan), /search_document @@/);
    const indexPlan = await fixture.persistence.explainFullTextIndex({ text: "zephyrlattice recovery" });
    assert.match(JSON.stringify(indexPlan), /durable_memories_search_gin_idx/);
  });
});
