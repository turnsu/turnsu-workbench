import { canonicalRequestHash } from "../store/serialization.mjs";

/**
 * Product runtime owner for active daily Automations.
 *
 * It decides whether a due occurrence may execute, mints no direct effects,
 * and always enters execution through Workflow Runner Command Intake.
 */
export class PostgresAutomationScheduler {
  #persistence;
  #workflowRunner;
  #workspaceId;
  #polling = null;

  constructor({ persistence, workflowRunner, workspaceId } = {}) {
    for (const method of ["prepareNext", "acceptOccurrence"]) {
      if (typeof persistence?.[method] !== "function") {
        throw new TypeError("postgres_automation_scheduler_persistence_required");
      }
    }
    if (typeof workflowRunner?.startRunWithCompanion !== "function") {
      throw new TypeError("postgres_automation_scheduler_runner_required");
    }
    if (typeof workspaceId !== "string" || !workspaceId) {
      throw new TypeError("postgres_automation_scheduler_workspace_required");
    }
    this.#persistence = persistence;
    this.#workflowRunner = workflowRunner;
    this.#workspaceId = workspaceId;
  }

  async pollDue({ limit = 10 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError("automation_poll_limit_invalid");
    }
    if (this.#polling) return this.#polling;
    this.#polling = this.#poll(limit).finally(() => { this.#polling = null; });
    return this.#polling;
  }

  async #poll(limit) {
    const outcomes = [];
    for (let index = 0; index < limit; index += 1) {
      const work = await this.#persistence.prepareNext({
        workspaceId: this.#workspaceId,
        classify: ({ source, now }) => classifyOccurrence(source, now),
      });
      if (!work) break;
      if (work.kind === "terminal") {
        outcomes.push(work.occurrence);
        continue;
      }
      outcomes.push(await this.#dispatch(work));
    }
    return {
      inspected: outcomes.length,
      accepted: outcomes.filter((item) => item.status === "accepted").length,
      blocked: outcomes.filter((item) => item.status === "blocked").length,
      skipped: outcomes.filter((item) => item.status === "skipped").length,
      misfired: outcomes.filter((item) => item.status === "misfired").length,
      occurrences: outcomes,
    };
  }

  async #dispatch({ source, decisionId }) {
    const result = await this.#workflowRunner.startRunWithCompanion({
      workflowId: source.workflow_id,
      workflowRevisionId: source.workflow_revision_id,
      inputs: {},
      resourceRefs: source.resource_refs,
      materialBindings: [],
      idempotencyKey: source.occurrence_id,
      requestId: `automation:${source.occurrence_id}`,
      requestedBy: source.owner_user_id,
      authorizationDecisionId: decisionId,
      commandAuthority: {
        actorPrincipalId: source.scheduler_principal_id,
        actorPrincipalKind: "scheduler",
        effectivePrincipalId: source.automation_principal_id,
        effectivePrincipalKind: "automation",
      },
      automationRevisionId: source.automation_revision_id,
    }, {
      kind: "automation-occurrence",
      persist: ({ run, transactionSession }) => this.#persistence.acceptOccurrence({
        source,
        decisionId,
        run,
        uow: transactionSession,
      }),
    });
    if (!result.companion || result.companion.status !== "accepted") {
      throw coded("automation_occurrence_acceptance_missing");
    }
    return result.companion;
  }
}

function classifyOccurrence(source, now) {
  const blockedReason = authorityBlockReason(source, now);
  if (blockedReason) {
    return { kind: "terminal", status: "blocked", reasonCode: blockedReason };
  }
  const latenessSeconds = Math.max(
    0,
    (Date.parse(now) - Date.parse(source.scheduled_for)) / 1000,
  );
  if (latenessSeconds >= 60 && source.misfire_policy === "skip") {
    return { kind: "terminal", status: "skipped", reasonCode: "automation_misfire_skipped" };
  }
  if (latenessSeconds > 60 + Number(source.misfire_max_lateness_seconds)) {
    return {
      kind: "terminal",
      status: "misfired",
      reasonCode: "automation_misfire_lateness_exceeded",
    };
  }

  const request = automationRunRequest(source);
  return {
    kind: "dispatch",
    request,
    argumentDigest: canonicalRequestHash(request),
    decisionId: derivedId("automation-decision", source.occurrence_id),
  };
}

function authorityBlockReason(source, now) {
  if (source.automation_status !== "active"
    || source.scope_status !== "active"
    || source.owner_membership_status !== "active"
    || source.owner_principal_status !== "active"
    || source.owner_scope_grant_status !== "active"
    || source.automation_principal_status !== "active"
    || source.current_automation_revision_id !== source.automation_revision_id
    || Number(source.current_automation_revision_number) !== Number(source.automation_revision_number)
    || source.pins_finalized !== true
    || source.current_policy_revision_id !== source.scope_policy_revision_id
    || source.policy_grant_status !== "active"
    || source.automation_scope_grant_status !== "active"
    || Number(source.policy_grant_revision) !== Number(source.observed_policy_grant_revision)
    || !isFuture(source.policy_grant_expires_at, now)) {
    return "automation_authority_inactive";
  }
  if (!source.scheduler_principal_id || !source.scheduler_scope_grant_id) {
    return "automation_scheduler_authority_missing";
  }
  const permitsWorkflowRun = source.permission_mode === "auto"
    ? (source.auto_approved_effect_classes ?? []).includes("execute")
    : source.permission_mode === "custom"
      ? (source.auto_approved_action_ids ?? []).includes("workflow_run")
      : false;
  if (source.approval_policy !== "policy_grant_only" || !permitsWorkflowRun) {
    return "automation_execution_approval_required";
  }
  return null;
}

function automationRunRequest(source) {
  return {
    workflowId: source.workflow_id,
    workflowRevisionId: source.workflow_revision_id,
    inputs: {},
    resourceRefs: source.resource_refs,
    materialBindings: [],
    requestedBy: source.owner_user_id,
    retryOf: null,
    companionKind: "automation-occurrence",
  };
}

function derivedId(kind, ...parts) {
  const digest = canonicalRequestHash({ kind, parts }).slice("sha256:".length);
  return `${kind}-${digest}`.slice(0, 128);
}

function isFuture(value, now) {
  const candidate = Date.parse(value);
  const reference = Date.parse(now);
  return Number.isFinite(candidate) && Number.isFinite(reference) && candidate > reference;
}

function coded(code) { const error = new Error(code); error.code = code; return error; }
