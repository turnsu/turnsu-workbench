import assert from "node:assert/strict";
import test from "node:test";

import { PostgresAutomationLifecycle } from "../../src/automations/postgres-automation-lifecycle.mjs";

const workspaceId = "workspace-automation-read";
const userId = "user-owner";
const now = "2026-08-12T09:00:00.000Z";
const hash = `sha256:${"a".repeat(64)}`;

function scriptedStore(steps) {
  const remaining = [...steps];
  return {
    async connect() {},
    async withTransaction(work) { return work(Object.freeze({ kind: "postgres_unit_of_work" })); },
    bindAdapter(factory) {
      return factory({
        async execute(_uow, { text, values }) {
          const step = remaining.shift();
          assert.ok(step, `unexpected PostgreSQL query: ${text}`);
          assert.match(text, step.match);
          if (step.values) assert.deepEqual(values, step.values);
          return { rows: step.rows ?? [] };
        },
      });
    },
    assertDrained() { assert.equal(remaining.length, 0); },
  };
}

test("PostgreSQL Automation read owner keeps display names and exposes only an accepted occurrence's Run state", async () => {
  const store = scriptedStore([
    {
      match: /SELECT automation_id\s+FROM public\.automations root/,
      values: [workspaceId, userId, null, 50],
      rows: [{ automation_id: "automation-daily" }],
    },
    {
      match: /SELECT root\.\*, revision\.scope_policy_revision_id/,
      values: [workspaceId, "automation-daily"],
      rows: [{
        workspace_id: workspaceId,
        automation_id: "automation-daily",
        scope_id: "scope-personal",
        owner_user_id: userId,
        display_name: "Daily planning digest",
        status: "active",
        current_revision_id: "automation-revision-1",
        current_revision_number: 1,
        write_version: 1,
        next_scheduled_at: now,
        last_occurrence_at: null,
        failure_streak: 0,
        created_at: now,
        updated_at: now,
      }],
    },
    {
      match: /SELECT revision\.\*, policy\.permission_mode/,
      values: [workspaceId, "automation-revision-1"],
      rows: [{
        automation_revision_id: "automation-revision-1",
        loop_version_id: "loop-daily-v1",
        loop_version_content_hash: hash,
        trigger_revision: 1,
        cron_expression: "0 9 * * *",
        timezone_name: "Etc/UTC",
        model_policy_revision_id: "model-policy-1",
        model_profile_revision_ids: [],
        max_cost_microunits: 1_000,
        max_duration_seconds: 300,
        scope_policy_revision_id: "scope-policy-1",
        permission_mode: "auto",
        auto_approved_effect_classes: ["execute"],
        auto_approved_action_ids: [],
        misfire_policy: "run_once",
        misfire_max_lateness_seconds: 300,
        policy_grant_id: "automation-grant-1",
        policy_grant_revision: 1,
        expires_at: "2026-08-30T09:00:00.000Z",
        review_at: "2026-08-20T09:00:00.000Z",
        last_outcome: "completed",
      }],
    },
    { match: /FROM public\.automation_input_pins/, values: [workspaceId, "automation-revision-1"], rows: [] },
    { match: /FROM public\.automation_connection_pins/, values: [workspaceId, "automation-revision-1"], rows: [] },
    {
      match: /SELECT root\.\*, revision\.scope_policy_revision_id/,
      values: [workspaceId, "automation-daily"],
      rows: [{ owner_user_id: userId }],
    },
    {
      match: /LEFT JOIN public\.workflow_runs run/,
      values: [workspaceId, "automation-daily", 10],
      rows: [
        {
          occurrence_id: "occurrence-accepted",
          automation_id: "automation-daily",
          trigger_revision: 1,
          scheduled_for: now,
          local_schedule_date: "2026-08-12",
          status: "accepted",
          product_command_id: "command-accepted",
          run_id: "run-accepted",
          workflow_id: "workflow-daily",
          run_status: "waiting_review",
          reason_code: null,
          created_at: now,
          updated_at: now,
        },
        {
          occurrence_id: "occurrence-misfired",
          automation_id: "automation-daily",
          trigger_revision: 1,
          scheduled_for: now,
          local_schedule_date: "2026-08-11",
          status: "misfired",
          product_command_id: null,
          run_id: null,
          run_status: null,
          reason_code: "scheduler_delayed",
          created_at: now,
          updated_at: now,
        },
      ],
    },
  ]);
  const lifecycle = new PostgresAutomationLifecycle({ store });
  const context = { workspaceId, userId, role: "owner" };

  const automations = await lifecycle.listAutomations({ context });
  assert.equal(automations[0].displayName, "Daily planning digest");
  assert.equal(automations[0].lastOutcome, "completed");
  assert.equal(automations[0].grantExpiresAt, "2026-08-30T09:00:00.000Z");
  assert.equal(automations[0].grantReviewAt, "2026-08-20T09:00:00.000Z");

  const occurrences = await lifecycle.listOccurrences({
    automationId: "automation-daily",
    query: { limit: 10 },
    context,
  });
  assert.deepEqual(occurrences.map((occurrence) => ({
    occurrenceId: occurrence.occurrenceId,
    status: occurrence.status,
    runId: occurrence.runId,
    workflowId: occurrence.workflowId,
    runStatus: occurrence.runStatus,
  })), [
    {
      occurrenceId: "occurrence-accepted",
      status: "accepted",
      runId: "run-accepted",
      workflowId: "workflow-daily",
      runStatus: "waiting_review",
    },
    {
      occurrenceId: "occurrence-misfired",
      status: "misfired",
      runId: null,
      workflowId: null,
      runStatus: null,
    },
  ]);
  store.assertDrained();
});
