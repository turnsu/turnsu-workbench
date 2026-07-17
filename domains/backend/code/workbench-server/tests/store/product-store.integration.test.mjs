import assert from "node:assert/strict";
import test from "node:test";

import {
  Check,
  RunEventSchema,
  RunReadModelSchema,
  WorkflowRevisionSchema,
  WorkflowSchema,
} from "@looloomi/workbench-contracts";

import {
  ProductMongoStore,
  formatWorkflowEtag,
} from "../../src/store/index.mjs";
import { MongoWorkbenchSessionStore } from "../../src/security/mongo-workbench-session-store.mjs";
import {
  compileResultExample,
  executionPlanExample,
  nodeRunExample,
  reviewDecisionExample,
  runEventExample,
  runReadModelExample,
  skillDefinitionExample,
  workflowRunExample,
  workflowTemplateExample,
} from "../../../workbench-contracts/examples/canonical-examples.mjs";

const ENABLED = process.env.WORKBENCH_MONGO_INTEGRATION === "1";
const MONGODB_URI =
  process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/?replicaSet=rs0";
const DATABASE_NAME =
  process.env.MONGODB_DB ?? "looloomi_workbench_test";

if (!DATABASE_NAME.endsWith("_test")) {
  throw new Error(`integration_database_must_end_in_test:${DATABASE_NAME}`);
}

const clone = (value) => structuredClone(value);

const changedTopLevelKeys = (before, after) => {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys]
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .sort();
};

test(
  "ProductMongoStore proves indexes, transactions, immutability, idempotency, and event order on Mongo",
  { skip: !ENABLED, timeout: 60_000 },
  async (context) => {
    const store = new ProductMongoStore({
      uri: MONGODB_URI,
      dbName: DATABASE_NAME,
      serverSelectionTimeoutMS: 5_000,
    });

    await store.connect();
    await store.dropTestDatabase();
    const db = await store.connect();
    context.after(async () => {
      await store.dropTestDatabase();
      await store.close();
    });

    const health = await store.health();
    assert.deepEqual(health, {
      ok: true,
      database: DATABASE_NAME,
      replicaSet: "rs0",
      writablePrimary: true,
    });

    const expectedUniqueIndexes = new Map([
      ["product_users", ["userId_1"]],
      ["product_workspaces", ["workspaceId_1"]],
      ["workspace_memberships", ["workspaceId_1_userId_1"]],
      ["product_sessions", ["sessionId_1", "tokenHash_1"]],
      ["skill_assets", ["skillId_1"]],
      ["skill_drafts", ["skillDraftId_1"]],
      ["skill_versions", ["skillVersionId_1", "workspaceId_1_skillId_1_version_1"]],
      ["loop_versions", ["loopVersionId_1", "workspaceId_1_workflowId_1_version_1"]],
      ["loop_imports", ["importId_1"]],
      ["workspace_asset_releases", ["releaseId_1", "sourceWorkspaceId_1_asset_1_version_1"]],
      ["asset_installations", ["installationId_1", "workspaceId_1_releaseId_1"]],
      ["upload_sessions", ["uploadId_1"]],
      ["product_objects", ["objectId_1", "workspaceId_1_contentHash_1"]],
      ["workspace_connections", ["connectionId_1", "workspaceId_1_label_1"]],
      ["workspace_connection_bindings", ["workspaceId_1_target_1_requirementId_1"]],
      ["builder_proposals", ["proposalId_1"]],
      ["run_jobs", ["runJobId_1", "runId_1"]],
      ["run_leases", ["runId_1"]],
      ["run_checkpoints", ["checkpointId_1", "runId_1_attemptId_1_sequence_1", "runId_1_sequence_1"]],
      ["run_commands", ["runCommandId_1"]],
      ["skills", ["skillId_1_version_1"]],
      ["templates", ["templateId_1_templateVersion_1"]],
      ["workflows", ["workflowId_1"]],
      ["workflow_revisions", ["revisionId_1", "workflowId_1_revisionNumber_1"]],
      ["execution_plans", ["planId_1"]],
      ["runs", ["runId_1"]],
      ["run_node_attempts", ["runId_1_nodeId_1_attempt_1"]],
      ["run_events", ["runId_1_sequence_1", "eventId_1"]],
      ["run_read_models", ["runId_1"]],
      ["review_decisions", ["decisionId_1"]],
      ["idempotency_records", ["scope_1_key_1"]],
    ]);
    for (const [collectionName, expectedNames] of expectedUniqueIndexes) {
      const indexes = await db.collection(collectionName).listIndexes().toArray();
      const uniqueNames = indexes
        .filter((index) => index.unique)
        .map((index) => index.name)
        .sort();
      assert.deepEqual(uniqueNames, [...expectedNames].sort(), collectionName);
    }

    assert.deepEqual(Object.keys(store.repositories).sort(), [
      "agentBranches",
      "agentHandoffs",
      "agentMessages",
      "agentObjectProposals",
      "agentSessionEvents",
      "agentSessions",
      "agentTurns",
      "auditEvents",
      "assetInstallations",
      "assetReleases",
      "builderProposals",
      "capabilityLeases",
      "connections",
      "connectionBindings",
      "compileResults",
      "durableMemories",
      "executionAttempts",
      "executionCheckpoints",
      "executionEvents",
      "executionInvocations",
      "executionPlans",
      "idempotencyRecords",
      "loopVersions",
      "loopImports",
      "memberships",
      "memoryCandidates",
      "memoryDeletionTombstones",
      "memoryEvents",
      "mergeConflicts",
      "objects",
      "resources",
      "runCheckpoints",
      "runCommands",
      "reviewDecisions",
      "runEvents",
      "runJobs",
      "runLeases",
      "runNodeAttempts",
      "runReadModels",
      "runTerminalTransitions",
      "runs",
      "sessions",
      "skillAssets",
      "skillDrafts",
      "skillExecutionBindings",
      "skillTestEvidence",
      "skillTestRuns",
      "skillValidations",
      "skillVersions",
      "skills",
      "templates",
      "uploads",
      "users",
      "workflowRevisions",
      "workflows",
      "workspaces",
    ].sort());

    const localIdentity = await store.ensurePrivateWorkspace();
    assert.equal(localIdentity.membership.role, "owner");
    await assert.rejects(
      () => store.authorizeWorkspace({ userId: "user-unrelated", workspaceId: "workspace-local" }),
      (error) => error?.code === "workspace_access_forbidden",
    );
    const sessionStore = new MongoWorkbenchSessionStore({
      store,
      tokenFactory: () => "integration-browser-token",
      csrfTokenFactory: () => "c".repeat(32),
      idFactory: () => "session-integration-1",
    });
    await sessionStore.issue({ userId: "user-local", activeWorkspaceId: "workspace-local" });
    assert.equal((await sessionStore.get("integration-browser-token")).activeWorkspaceId, "workspace-local");
    const storedSession = await db.collection("product_sessions").findOne({ sessionId: "session-integration-1" });
    assert.equal(JSON.stringify(storedSession).includes("integration-browser-token"), false);

    const createSkillMutation = {
      idempotencyKey: "idem-create-skill-integration",
      request: {
        data: {
          name: "Meeting summary",
          description: "Summarize a reviewed meeting source.",
          category: "meetings",
        },
      },
      workspaceId: "workspace-local",
      authoredBy: "user-local",
      skillId: "skill-meeting-summary",
      skillDraftId: "skill-draft-meeting-summary-1",
    };
    const createdSkill = await store.createSkill(createSkillMutation);
    assert.equal(createdSkill.skill.lifecycle, "draft");
    assert.equal(createdSkill.skill.currentDraftId, "skill-draft-meeting-summary-1");
    assert.equal(createdSkill.draft.name, "Meeting summary");
    assert.deepEqual(await store.createSkill(createSkillMutation), createdSkill);
    assert.equal(
      (await store.getSkillDraft({
        skillId: "skill-meeting-summary",
        draftId: "skill-draft-meeting-summary-1",
        workspaceId: "workspace-local",
      })).draft.skillDraftId,
      "skill-draft-meeting-summary-1",
    );
    await assert.rejects(
      () => store.getSkillDraft({
        skillId: "skill-meeting-summary",
        draftId: "skill-draft-meeting-summary-1",
        workspaceId: "workspace-peer",
      }),
      (error) => error?.code === "skill_not_found",
    );

    const createLoopMutation = {
      idempotencyKey: "idem-create-loop-integration",
      request: {
        data: {
          name: "Meeting actions",
          description: "Turn a meeting into a reviewed action list.",
          definition: {
            goal: "Turn meeting notes into actions.",
            context: "Internal meeting notes.",
            constraints: ["Do not send messages."],
            doneWhen: ["Each action has an owner."],
            verify: ["A reviewer approves the result."],
            expectedResult: "A reviewed action list.",
            stopRules: ["Stop when source notes are missing."],
          },
        },
      },
      workspaceId: "workspace-local",
      authoredBy: "user-local",
      workflowId: "workflow-meeting-actions",
      revisionId: "revision-meeting-actions-1",
    };
    const createdLoop = await store.createLoop(createLoopMutation);
    assert.equal(createdLoop.workflow.lifecycle, "draft");
    assert.equal(createdLoop.revision.definition.goal, "Turn meeting notes into actions.");
    assert.equal(createdLoop.revision.graph.nodes.length, 2);
    assert.equal(Check(WorkflowSchema, createdLoop.workflow), true);
    assert.equal(Check(WorkflowRevisionSchema, createdLoop.revision), true);
    assert.deepEqual(await store.createLoop(createLoopMutation), createdLoop);
    const loopInitial = await store.getWorkflow("workflow-meeting-actions", { workspaceId: "workspace-local" });
    const savedLoop = await store.saveWorkflowRevision({
      workflowId: "workflow-meeting-actions",
      idempotencyKey: "idem-save-loop-definition",
      ifMatch: loopInitial.etag,
      workspaceId: "workspace-local",
      authoredBy: "user-local",
      request: {
        baseRevisionId: createdLoop.revision.revisionId,
        graph: clone(createdLoop.revision.graph),
        inputForm: clone(createdLoop.revision.inputForm),
        outputDefinition: clone(createdLoop.revision.outputDefinition),
        resourceRefs: [],
        runSettings: clone(createdLoop.revision.runSettings),
        definition: {
          ...createdLoop.revision.definition,
          context: "Updated meeting context.",
        },
        saveReason: "Preserve the Loop definition while editing graph details.",
      },
    });
    assert.equal(savedLoop.revision.definition.context, "Updated meeting context.");
    const copiedLoop = await store.duplicateLoop({
      workflowId: "workflow-meeting-actions",
      idempotencyKey: "idem-duplicate-loop-integration",
      request: { data: { name: "Meeting actions copy" } },
      workspaceId: "workspace-local",
      authoredBy: "user-local",
      duplicatedWorkflowId: "workflow-meeting-actions-copy",
      revisionId: "revision-meeting-actions-copy-1",
    });
    assert.equal(copiedLoop.workflow.name, "Meeting actions copy");
    assert.deepEqual(copiedLoop.workflow.sourceWorkflow, {
      workflowId: "workflow-meeting-actions",
      revisionId: savedLoop.revision.revisionId,
    });
    assert.equal(copiedLoop.revision.baseRevisionId, null);
    assert.equal(copiedLoop.revision.revisionNumber, 1);
    assert.equal(copiedLoop.revision.compile.status, "blocked");
    assert.deepEqual(copiedLoop.revision.graph, savedLoop.revision.graph);
    assert.equal(Check(WorkflowSchema, copiedLoop.workflow), true);
    assert.equal(Check(WorkflowRevisionSchema, copiedLoop.revision), true);
    assert.deepEqual(
      await store.duplicateLoop({
        workflowId: "workflow-meeting-actions",
        idempotencyKey: "idem-duplicate-loop-integration",
        request: { data: { name: "Meeting actions copy" } },
        workspaceId: "workspace-local",
        authoredBy: "user-local",
        duplicatedWorkflowId: "workflow-meeting-actions-copy",
        revisionId: "revision-meeting-actions-copy-1",
      }),
      copiedLoop,
    );
    await assert.rejects(
      () => store.duplicateLoop({
        workflowId: "workflow-meeting-actions",
        idempotencyKey: "idem-duplicate-loop-integration",
        request: { data: { name: "Meeting actions copy" } },
        workspaceId: "workspace-local",
        authoredBy: "user-local",
        sourceRevisionId: createdLoop.revision.revisionId,
      }),
      (error) => error?.code === "idempotency_key_reused",
    );

    const releaseTime = "2026-07-13T08:00:00.000Z";
    const baseLoopVersion = {
      schemaVersion: "workbench-v1",
      workflowId: "workflow-meeting-actions",
      workflowRevisionId: savedLoop.revision.revisionId,
      workspaceId: "workspace-local",
      definition: clone(savedLoop.revision.definition),
      pinnedSkills: [],
      contentHash: savedLoop.revision.contentHash,
      releasedBy: "user-local",
      releasedAt: releaseTime,
    };
    await store.repositories.loopVersions.insert({
      ...baseLoopVersion,
      loopVersionId: "loop-version-forkable-1",
      version: "1.0.0",
    });
    await store.repositories.assetReleases.insert({
      schemaVersion: "workbench-v1",
      releaseId: "release-loop-forkable-1",
      sourceWorkspaceId: "workspace-local",
      assetKind: "loop",
      assetId: "workflow-meeting-actions",
      versionId: "loop-version-forkable-1",
      contentHash: savedLoop.revision.contentHash,
      visibility: "workspace",
      startingPoint: false,
      releaseNotes: "Forkable, but not offered as a starting point.",
      dependencies: [],
      publishedBy: "user-local",
      publishedAt: releaseTime,
    });
    const forkMutation = {
      releaseId: "release-loop-forkable-1",
      idempotencyKey: "idem-fork-team-loop-integration",
      request: { data: { name: "Independent meeting actions" } },
      workspaceId: "workspace-local",
      authoredBy: "user-teammate",
      workflowId: "workflow-meeting-actions-fork",
      revisionId: "revision-meeting-actions-fork-1",
    };
    const forkedLoop = await store.forkTeamLibraryLoop(forkMutation);
    assert.equal(forkedLoop.workflow.name, "Independent meeting actions");
    assert.equal(forkedLoop.workflow.ownerId, "user-teammate");
    assert.equal(forkedLoop.workflow.visibility, "private");
    assert.equal(forkedLoop.workflow.lifecycle, "draft");
    assert.equal(forkedLoop.workflow.status, "draft");
    assert.equal(Object.hasOwn(forkedLoop.workflow, "latestCompile"), false);
    assert.equal(Object.hasOwn(forkedLoop.workflow, "latestRun"), false);
    assert.deepEqual(forkedLoop.workflow.sourceWorkflow, {
      workflowId: "workflow-meeting-actions",
      revisionId: savedLoop.revision.revisionId,
    });
    assert.deepEqual(forkedLoop.workflow.sourceRelease, {
      releaseId: "release-loop-forkable-1",
      sourceWorkspaceId: "workspace-local",
      versionId: "loop-version-forkable-1",
      forkedAt: forkedLoop.workflow.createdAt,
    });
    assert.equal(forkedLoop.revision.revisionNumber, 1);
    assert.equal(forkedLoop.revision.baseRevisionId, null);
    assert.deepEqual(forkedLoop.revision.graph, savedLoop.revision.graph);
    assert.deepEqual(forkedLoop.revision.definition, savedLoop.revision.definition);
    assert.deepEqual(forkedLoop.revision.inputForm, savedLoop.revision.inputForm);
    assert.deepEqual(forkedLoop.revision.outputDefinition, savedLoop.revision.outputDefinition);
    assert.deepEqual(forkedLoop.revision.resourceRefs, savedLoop.revision.resourceRefs);
    assert.deepEqual(forkedLoop.revision.runSettings, savedLoop.revision.runSettings);
    assert.deepEqual(forkedLoop.revision.compile, { status: "blocked", diagnostics: [] });
    assert.equal(Check(WorkflowSchema, forkedLoop.workflow), true);
    assert.equal(Check(WorkflowRevisionSchema, forkedLoop.revision), true);
    assert.deepEqual(await store.forkTeamLibraryLoop(forkMutation), forkedLoop);
    await assert.rejects(
      () => store.forkTeamLibraryLoop({
        ...forkMutation,
        request: { data: { name: "Different fork name" } },
      }),
      (error) => error?.code === "idempotency_key_reused",
    );
    await assert.rejects(
      () => store.repositories.workflowRevisions.update(forkedLoop.revision.revisionId, {}),
      (error) => error?.code === "workflow_revision_immutable",
    );
    await assert.rejects(
      () => store.useReleaseAsStartingPoint({
        releaseId: "release-loop-forkable-1",
        idempotencyKey: "idem-start-non-starting-point",
        request: { data: { name: "Must not start" } },
        workspaceId: "workspace-local",
        authoredBy: "user-teammate",
      }),
      (error) => error?.code === "release_not_available",
    );

    await store.repositories.loopVersions.insert({
      ...baseLoopVersion,
      loopVersionId: "loop-version-starting-point-1",
      version: "1.0.1",
    });
    await store.repositories.assetReleases.insert({
      schemaVersion: "workbench-v1",
      releaseId: "release-loop-starting-point-1",
      sourceWorkspaceId: "workspace-local",
      assetKind: "loop",
      assetId: "workflow-meeting-actions",
      versionId: "loop-version-starting-point-1",
      contentHash: savedLoop.revision.contentHash,
      visibility: "workspace",
      startingPoint: true,
      releaseNotes: "Explicit starting point.",
      dependencies: [],
      publishedBy: "user-local",
      publishedAt: releaseTime,
    });
    const startedLoop = await store.useReleaseAsStartingPoint({
      releaseId: "release-loop-starting-point-1",
      idempotencyKey: "idem-start-from-release-integration",
      request: { data: { name: "Started meeting actions" } },
      workspaceId: "workspace-local",
      authoredBy: "user-teammate",
      workflowId: "workflow-meeting-actions-started",
      revisionId: "revision-meeting-actions-started-1",
    });
    assert.equal(Object.hasOwn(startedLoop.workflow, "sourceRelease"), false);
    assert.equal(Object.hasOwn(startedLoop.workflow, "sourceWorkflow"), false);

    await store.repositories.assetReleases.insert({
      schemaVersion: "workbench-v1",
      releaseId: "release-skill-not-forkable",
      sourceWorkspaceId: "workspace-local",
      assetKind: "skill",
      assetId: "skill-meeting-summary",
      versionId: "skill-version-meeting-summary-1",
      contentHash: savedLoop.revision.contentHash,
      visibility: "workspace",
      startingPoint: false,
      releaseNotes: "A Skill release cannot be forked as a Loop.",
      dependencies: [],
      publishedBy: "user-local",
      publishedAt: releaseTime,
    });
    await store.repositories.assetReleases.insert({
      schemaVersion: "workbench-v1",
      releaseId: "release-loop-other-workspace",
      sourceWorkspaceId: "workspace-peer",
      assetKind: "loop",
      assetId: "workflow-meeting-actions",
      versionId: "loop-version-forkable-1",
      contentHash: savedLoop.revision.contentHash,
      visibility: "workspace",
      startingPoint: false,
      releaseNotes: "Not visible to this workspace.",
      dependencies: [],
      publishedBy: "user-peer",
      publishedAt: releaseTime,
    });
    for (const releaseId of [
      "release-skill-not-forkable",
      "release-loop-other-workspace",
      "release-does-not-exist",
    ]) {
      await assert.rejects(
        () => store.forkTeamLibraryLoop({
          releaseId,
          idempotencyKey: `idem-rejected-fork-${releaseId}`,
          request: { data: { name: "Rejected fork" } },
          workspaceId: "workspace-local",
          authoredBy: "user-teammate",
        }),
        (error) => error?.code === "release_not_available",
        releaseId,
      );
    }
    const forkAuditActions = (await store.repositories.auditEvents.list({ workspaceId: "workspace-local" }))
      .map((event) => event.action);
    assert.equal(forkAuditActions.filter((action) => action === "team_library.loop_forked").length, 1);
    await assert.rejects(
      () => store.getWorkflow("workflow-meeting-actions", { workspaceId: "workspace-peer" }),
      (error) => error?.code === "workflow_not_found",
    );

    const skill = clone(skillDefinitionExample);
    const template = clone(workflowTemplateExample);
    await store.repositories.skills.insert(skill);
    await store.repositories.templates.insert(template);

    await assert.rejects(
      () => store.repositories.templates.update(template.templateId, { name: "Changed" }),
      (error) => error?.code === "template_read_only",
    );
    await assert.rejects(
      () => store.repositories.templates.delete(template.templateId),
      (error) => error?.code === "template_read_only",
    );

    const useTemplateRequest = {
      templateVersion: template.templateVersion,
      name: "Owned evidence workflow",
    };
    const useTemplateMutation = {
      templateId: template.templateId,
      idempotencyKey: "idem-use-template-integration",
      request: useTemplateRequest,
      workspaceId: "workspace-local",
      authoredBy: "user-local",
    };
    const created = await store.useTemplate(useTemplateMutation);
    const replayed = await store.useTemplate(useTemplateMutation);
    assert.deepEqual(replayed, created);
    assert.equal(Object.hasOwn(created.workflow, "_id"), false);
    assert.equal(Object.hasOwn(created.workflow, "writeVersion"), false);
    assert.equal(Object.hasOwn(created.workflow, "revisionNumber"), false);
    assert.equal(Object.hasOwn(created.revision, "_id"), false);
    assert.equal(Check(WorkflowSchema, created.workflow), true);
    assert.equal(Check(WorkflowRevisionSchema, created.revision), true);

    await assert.rejects(
      () =>
        store.useTemplate({
          ...useTemplateMutation,
          request: { ...useTemplateRequest, name: "Different body" },
        }),
      (error) => error?.code === "idempotency_key_reused",
    );

    assert.equal(await db.collection("workflows").countDocuments(), 5);
    assert.equal(await db.collection("workflow_revisions").countDocuments(), 6);
    assert.equal(await db.collection("idempotency_records").countDocuments(), 7);
    const idempotencyRecord = await db.collection("idempotency_records").findOne({
      scope: `workspace:workspace-local:use-template:${template.templateId}`,
      key: useTemplateMutation.idempotencyKey,
    });
    assert.match(idempotencyRecord.requestHash, /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(idempotencyRecord.response, created);

    await store.ensurePrivateWorkspace({
      userId: "user-peer",
      workspaceId: "workspace-peer",
      displayName: "Peer",
      workspaceName: "Peer workspace",
    });
    const peerCreated = await store.useTemplate({
      ...useTemplateMutation,
      workspaceId: "workspace-peer",
      authoredBy: "user-peer",
    });
    assert.notEqual(peerCreated.workflow.workflowId, created.workflow.workflowId);
    await assert.rejects(
      () => store.getWorkflow(peerCreated.workflow.workflowId, { workspaceId: "workspace-local" }),
      (error) => error?.code === "workflow_not_found",
    );
    await assert.doesNotReject(
      () => store.authorizeWorkspace({ userId: "user-peer", workspaceId: "workspace-peer", minimumRole: "member" }),
    );

    const concurrentMutation = {
      ...useTemplateMutation,
      idempotencyKey: "idem-use-template-concurrent",
      request: { ...useTemplateRequest, name: "Concurrent owned workflow" },
    };
    const workflowsBeforeConcurrentReplay = await db
      .collection("workflows")
      .countDocuments();
    const [concurrentFirst, concurrentSecond] = await Promise.all([
      store.useTemplate(concurrentMutation),
      store.useTemplate(concurrentMutation),
    ]);
    assert.deepEqual(concurrentSecond, concurrentFirst);
    assert.equal(
      await db.collection("workflows").countDocuments(),
      workflowsBeforeConcurrentReplay + 1,
    );

    const initialWorkflow = await store.getWorkflow(created.workflow.workflowId);
    assert.equal(
      initialWorkflow.etag,
      `"wfv1:${created.workflow.workflowId}:1:${created.revision.revisionId}"`,
    );
    const rawBeforeSave = await db.collection("workflows").findOne({
      workflowId: created.workflow.workflowId,
    });

    const saveRequest = {
      baseRevisionId: created.revision.revisionId,
      graph: clone(created.revision.graph),
      inputForm: clone(created.revision.inputForm),
      outputDefinition: clone(created.revision.outputDefinition),
      resourceRefs: [],
      runSettings: clone(created.revision.runSettings),
      saveReason: "Save an immutable second revision.",
    };
    const saveMutation = {
      workflowId: created.workflow.workflowId,
      idempotencyKey: "idem-save-revision-integration",
      ifMatch: initialWorkflow.etag,
      request: saveRequest,
      authoredBy: "user-local",
      workspaceId: "workspace-local",
    };
    const saved = await store.saveWorkflowRevision(saveMutation);
    const savedReplay = await store.saveWorkflowRevision(saveMutation);
    assert.deepEqual(savedReplay, saved);
    assert.equal(saved.revision.revisionNumber, 2);
    assert.equal(
      saved.etag,
      formatWorkflowEtag({
        workflowId: saved.workflow.workflowId,
        writeVersion: 2,
        currentRevisionId: saved.revision.revisionId,
      }),
    );

    await assert.rejects(
      () =>
        store.saveWorkflowRevision({
          ...saveMutation,
          request: { ...saveRequest, saveReason: "Different body" },
        }),
      (error) => error?.code === "idempotency_key_reused",
    );
    await assert.rejects(
      () =>
        store.saveWorkflowRevision({
          ...saveMutation,
          ifMatch: '"wfv1:stale:1:revision-stale"',
        }),
      (error) => error?.code === "idempotency_key_reused",
    );
    await assert.rejects(
      () =>
        store.saveWorkflowRevision({
          ...saveMutation,
          idempotencyKey: "idem-save-stale-etag",
        }),
      (error) => error?.code === "workflow_revision_conflict",
    );

    const rawAfterSave = await db.collection("workflows").findOne({
      workflowId: created.workflow.workflowId,
    });
    assert.deepEqual(changedTopLevelKeys(rawBeforeSave, rawAfterSave), [
      "currentRevisionId",
      "revisionNumber",
      "updatedAt",
      "writeVersion",
    ]);
    assert.equal(
      await db.collection("workflow_revisions").countDocuments({
        workflowId: created.workflow.workflowId,
      }),
      2,
    );
    await assert.rejects(
      () => store.repositories.workflowRevisions.update(saved.revision.revisionId, {}),
      (error) => error?.code === "workflow_revision_immutable",
    );
    await assert.rejects(
      () => store.repositories.workflowRevisions.delete(saved.revision.revisionId),
      (error) => error?.code === "workflow_revision_immutable",
    );

    const compileResult = {
      ...clone(compileResultExample),
      workflowId: saved.workflow.workflowId,
      workflowRevisionId: saved.revision.revisionId,
    };
    const executionPlan = {
      ...clone(executionPlanExample),
      workflowId: saved.workflow.workflowId,
      workflowRevisionId: saved.revision.revisionId,
    };
    await store.repositories.compileResults.insert(compileResult);
    await store.repositories.executionPlans.insert("plan-integration-1", executionPlan);

    const run = {
      ...clone(workflowRunExample),
      runId: "run-product-store-integration",
      workflowId: saved.workflow.workflowId,
      workflowRevisionId: saved.revision.revisionId,
      nodeRuns: [],
      reviewDecisions: [],
    };
    const insertedRun = await store.repositories.runs.insert(run);
    assert.equal(Object.hasOwn(insertedRun, "eventSequence"), false);

    const attempt = {
      ...clone(nodeRunExample),
      nodeRunId: "node-run-product-store-integration",
      runId: run.runId,
      nodeId: "node-skill",
      attempt: 1,
    };
    await store.repositories.runNodeAttempts.insert(attempt);
    const decision = {
      ...clone(reviewDecisionExample),
      decisionId: "decision-product-store-integration",
      runId: run.runId,
    };
    await store.repositories.reviewDecisions.insert(decision);
    const readModel = {
      ...clone(runReadModelExample),
      runId: run.runId,
      workflowId: saved.workflow.workflowId,
      workflowRevisionId: saved.revision.revisionId,
    };
    const storedReadModel = await store.repositories.runReadModels.put(readModel);
    assert.equal(Check(RunReadModelSchema, storedReadModel), true);
    assert.deepEqual(
      await store.repositories.runReadModels.get(run.runId),
      storedReadModel,
    );
    await store.repositories.auditEvents.append({
      auditEventId: "audit-product-store-integration",
      action: "store.integration.proved",
      subjectId: run.runId,
      occurredAt: run.createdAt,
    });

    const eventBase = {
      ...clone(runEventExample),
      runId: run.runId,
      workflowId: saved.workflow.workflowId,
      workflowRevisionId: saved.revision.revisionId,
    };
    delete eventBase.sequence;
    const [firstResult, secondResult] = await Promise.all([
      store.appendRunEvent({ ...eventBase, eventId: "event-product-store-1" }),
      store.appendRunEvent({ ...eventBase, eventId: "event-product-store-2" }),
    ]);
    assert.deepEqual([firstResult.sequence, secondResult.sequence].sort(), [1, 2]);

    const events = await store.repositories.runEvents.listAfter(run.runId, 0);
    assert.deepEqual(events.map((event) => event.sequence), [1, 2]);
    assert.ok(events.every((event) => !Object.hasOwn(event, "_id")));
    assert.ok(events.every((event) => Check(RunEventSchema, event)));
    const publicRun = await store.repositories.runs.get(run.runId);
    assert.equal(Object.hasOwn(publicRun, "_id"), false);
    assert.equal(Object.hasOwn(publicRun, "eventSequence"), false);
    const rawRun = await db.collection("runs").findOne({ runId: run.runId });
    assert.equal(rawRun.eventSequence, 2);
  },
);
