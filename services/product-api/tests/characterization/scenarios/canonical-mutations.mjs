import assert from "node:assert/strict";

const clone = (value) => structuredClone(value);

const loopDefinition = (purpose) => ({
  goal: purpose,
  context: "Characterization input.",
  constraints: ["Do not perform external effects."],
  doneWhen: ["The canonical mutation is committed once."],
  verify: ["Read the canonical object after the mutation."],
  expectedResult: "One stable canonical revision.",
  stopRules: ["Stop when the canonical precondition is stale."],
});

const expectedError = (error) => ({
  code: typeof error?.code === "string" ? error.code : "unexpected_error",
  retryable: false,
});

const requireContext = (context) => {
  assert.equal(typeof context?.core?.createSkillDraft, "function");
  assert.equal(typeof context?.core?.applySkillDraftDecision, "function");
  assert.equal(typeof context?.core?.createLoop, "function");
  assert.equal(typeof context?.core?.saveLoopRevision, "function");
  assert.equal(typeof context?.principal?.workspaceId, "string");
  assert.equal(typeof context?.principal?.userId, "string");
  assert.equal(typeof context?.ids, "function");
  return context;
};

const runTransactionRollback = async (rawContext) => {
  const { core, principal, ids } = requireContext(rawContext);
  const skillId = ids("rollback-skill");
  const draftId = ids("rollback-draft");
  const initialDescription = "Initial canonical description.";
  const committedDescription = "Description committed with the proposal decision.";
  const nestedDraftCommandId = ids("nested-draft-command");
  const created = await core.createSkillDraft({
    idempotencyKey: ids("create-skill-command"),
    name: "Canonical rollback characterization",
    description: initialDescription,
    skillId,
    skillDraftId: draftId,
  });

  const decision = {
    commandKey: ids("proposal-decision-command"),
    targetKey: nestedDraftCommandId,
    proposalId: ids("proposal"),
    skillId,
    draftId,
    description: committedDescription,
  };

  const errors = [];
  try {
    await core.applySkillDraftDecision({ ...decision, forceRollback: true });
    assert.fail("The forced rollback mutation unexpectedly committed.");
  } catch (error) {
    assert.equal(error?.code, "characterization_forced_rollback");
    errors.push(expectedError(error));
  }

  const afterRollback = await core.getSkillDraft({ skillId, draftId });
  assert.equal(afterRollback.draft.revision, 1);
  assert.equal(afterRollback.draft.description, initialDescription);

  const committed = await core.applySkillDraftDecision(decision);
  const replayed = await core.applySkillDraftDecision(decision);
  const afterCommit = await core.getSkillDraft({ skillId, draftId });
  assert.equal(committed.draft.revision, 2);
  assert.deepEqual(replayed, committed);
  assert.equal(afterCommit.draft.revision, 2);
  assert.equal(afterCommit.draft.description, committedDescription);

  return {
    result: "passed",
    errors,
    state: {
      before: { revision: 1, description: initialDescription },
      afterRollback: {
        revision: afterRollback.draft.revision,
        description: afterRollback.draft.description,
      },
      afterCommit: {
        revision: afterCommit.draft.revision,
        description: afterCommit.draft.description,
      },
    },
    events: [
      { sequence: 1, type: "canonical.transaction", status: "rolled_back" },
      { sequence: 2, type: "canonical.transaction", status: "committed" },
      { sequence: 3, type: "canonical.transaction", status: "replayed" },
    ],
    invariants: {
      target_write_rolled_back_with_command: true,
      rolled_back_idempotency_key_remains_reusable: true,
      recovered_command_commits_once: true,
    },
  };
};

const runConcurrentIdempotency = async (rawContext) => {
  const { core, ids } = requireContext(rawContext);
  const mutation = {
    idempotencyKey: ids("concurrent-create-command"),
    name: "Concurrent idempotency characterization",
    description: "Two callers submit the same command concurrently.",
    definition: loopDefinition("Create one canonical Loop for two identical commands."),
  };

  const [first, second] = await Promise.all([
    core.createLoop(mutation),
    core.createLoop(mutation),
  ]);
  assert.deepEqual(second, first);

  const replay = await core.createLoop(mutation);
  assert.deepEqual(replay, first);
  const canonical = await core.getLoop(first.workflow.workflowId);
  const workflows = await core.listLoops();
  const revisions = await core.listLoopRevisions(first.workflow.workflowId);
  assert.equal(canonical.workflow.currentRevisionId, first.revision.revisionId);
  assert.equal(workflows.length, 1);
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0].revisionId, first.revision.revisionId);

  return {
    result: "passed",
    errors: [],
    state: {
      lifecycle: canonical.workflow.lifecycle,
      currentRevisionNumber: first.revision.revisionNumber,
      canonicalIdentityMatches: true,
    },
    events: [
      { sequence: 1, type: "canonical.command", status: "committed" },
      { sequence: 2, type: "canonical.command", status: "replayed" },
    ],
    invariants: {
      concurrent_same_command_has_one_result: true,
      committed_response_replays_exactly: true,
      canonical_object_points_to_returned_revision: true,
      concurrent_command_leaves_no_orphan_target: workflows.length === 1,
      concurrent_command_leaves_no_orphan_revision: revisions.length === 1,
    },
  };
};

const runCanonicalCompareAndSet = async (rawContext) => {
  const { core, ids } = requireContext(rawContext);
  const created = await core.createLoop({
    idempotencyKey: ids("create-cas-loop-command"),
    name: "Canonical ETag characterization",
    description: "Two writers share one canonical base revision.",
    definition: loopDefinition("Permit one writer for one canonical ETag."),
  });
  const initial = await core.getLoop(created.workflow.workflowId);

  const baseRequest = {
    baseRevisionId: created.revision.revisionId,
    graph: clone(created.revision.graph),
    inputForm: clone(created.revision.inputForm),
    outputDefinition: clone(created.revision.outputDefinition),
    resourceRefs: clone(created.revision.resourceRefs),
    runSettings: clone(created.revision.runSettings),
  };
  const save = (writer) => core.saveLoopRevision({
    workflowId: created.workflow.workflowId,
    idempotencyKey: ids(`cas-${writer}-command`),
    ifMatch: initial.etag,
    request: {
      ...baseRequest,
      definition: {
        ...clone(created.revision.definition),
        context: `Canonical update proposed by ${writer}.`,
      },
      saveReason: `Characterize compare-and-set writer ${writer}.`,
    },
    revisionId: ids(`cas-${writer}-revision`),
  });

  const attempts = await Promise.allSettled([save("one"), save("two")]);
  const committed = attempts.filter((attempt) => attempt.status === "fulfilled");
  const conflicted = attempts.filter((attempt) => attempt.status === "rejected");
  assert.equal(committed.length, 1);
  assert.equal(conflicted.length, 1);
  assert.equal(conflicted[0].reason?.code, "workflow_revision_conflict");

  const current = await core.getLoop(created.workflow.workflowId);
  const revisions = await core.listLoopRevisions(created.workflow.workflowId);
  assert.equal(committed[0].value.revision.revisionNumber, 2);
  assert.equal(current.etag, committed[0].value.etag);
  assert.equal(
    current.workflow.currentRevisionId,
    committed[0].value.revision.revisionId,
  );
  assert.notEqual(current.etag, initial.etag);
  assert.equal(revisions.length, 2);
  assert.deepEqual(
    new Set(revisions.map(({ revisionId }) => revisionId)),
    new Set([created.revision.revisionId, committed[0].value.revision.revisionId]),
  );

  return {
    result: "passed",
    errors: conflicted.map((attempt) => expectedError(attempt.reason)),
    state: {
      initialRevisionNumber: created.revision.revisionNumber,
      currentRevisionNumber: committed[0].value.revision.revisionNumber,
      canonicalMatchesCommittedWriter: true,
    },
    events: [
      { sequence: 1, type: "canonical.compare_and_set", status: "committed" },
      { sequence: 2, type: "canonical.compare_and_set", status: "conflicted" },
    ],
    invariants: {
      one_etag_allows_one_canonical_commit: true,
      stale_writer_receives_revision_conflict: true,
      canonical_pointer_matches_winning_revision: true,
      losing_writer_leaves_no_orphan_revision: revisions.length === 2,
    },
  };
};

export const scenarios = [
  { id: "tx.command-target-rollback", run: runTransactionRollback },
  { id: "idempotency.concurrent-command", run: runConcurrentIdempotency },
  { id: "etag.canonical-cas", run: runCanonicalCompareAndSet },
];
