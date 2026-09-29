import { canonicalRequestHash } from "../serialization.mjs";

const TERMINAL_STATUSES = new Set(["blocked", "skipped", "misfired"]);

/** PostgreSQL transaction owner for the daily Automation scheduler. */
export class PostgresAutomationSchedulerPersistence {
  #store;
  #sql;

  constructor({ store } = {}) {
    if (!store?.bindAdapter || !store?.withTransaction) {
      throw new TypeError("postgres_automation_scheduler_persistence_store_required");
    }
    this.#store = store;
    this.#sql = store.bindAdapter(({ execute }) => Object.freeze({
      query: (uow, text, values = []) => execute(uow, { text, values }),
    }));
  }

  async prepareNext({ workspaceId, classify } = {}) {
    requiredId(workspaceId, "automation_scheduler_workspace_required");
    if (typeof classify !== "function") {
      throw new TypeError("automation_scheduler_classifier_required");
    }
    return this.#store.withTransaction(async (uow) => {
      const now = (await this.#query(uow, "SELECT clock_timestamp() AS now")).rows[0].now;
      let source = await this.#lockNextDueOccurrence(uow, workspaceId);
      if (!source) source = await this.#materializeNextOccurrence(uow, workspaceId, now);
      if (!source) return null;

      const action = classify({ source: Object.freeze({ ...source }), now });
      if (!action || typeof action !== "object") {
        throw new TypeError("automation_scheduler_classification_invalid");
      }
      if (action.kind === "terminal") {
        if (!TERMINAL_STATUSES.has(action.status)
          || typeof action.reasonCode !== "string"
          || !action.reasonCode) {
          throw new TypeError("automation_scheduler_terminal_classification_invalid");
        }
        return {
          kind: "terminal",
          occurrence: await this.#terminalize(
            uow,
            source,
            action.status,
            action.reasonCode,
            now,
          ),
        };
      }
      if (action.kind !== "dispatch"
        || typeof action.request !== "object"
        || action.request === null
        || !/^sha256:[a-f0-9]{64}$/.test(action.argumentDigest ?? "")) {
        throw new TypeError("automation_scheduler_dispatch_classification_invalid");
      }
      requiredId(action.decisionId, "automation_scheduler_decision_id_required");
      await this.#insertDecision(uow, source, action, now);
      return {
        kind: "dispatch",
        source,
        decisionId: action.decisionId,
        request: action.request,
      };
    });
  }

  async acceptOccurrence({ source, decisionId, run, uow } = {}) {
    if (!uow) throw new TypeError("automation_scheduler_acceptance_uow_required");
    requiredId(source?.workspace_id, "automation_scheduler_occurrence_workspace_required");
    requiredId(source?.occurrence_id, "automation_scheduler_occurrence_id_required");
    requiredId(decisionId, "automation_scheduler_decision_id_required");
    requiredId(run?.creationCommandId, "automation_scheduler_command_id_required");
    requiredId(run?.runId, "automation_scheduler_run_id_required");
    return this.#store.withTransaction(async (transaction) => {
      const now = (await this.#query(
        transaction,
        "SELECT clock_timestamp() AS now",
      )).rows[0].now;
      const updated = (await this.#query(transaction, `
        UPDATE public.automation_occurrences
           SET status = 'accepted', reason_code = NULL,
               authorization_decision_id = $3, product_command_id = $4,
               run_id = $5, observed_policy_grant_revision = $6,
               accepted_at = $7, terminal_at = $7, updated_at = $7
         WHERE workspace_id = $1 AND occurrence_id = $2 AND status = 'due'
         RETURNING *
      `, [
        source.workspace_id,
        source.occurrence_id,
        decisionId,
        run.creationCommandId,
        run.runId,
        Number(source.observed_policy_grant_revision),
        now,
      ])).rows[0];
      if (updated) return occurrenceView(updated);
      const existing = (await this.#query(transaction, `
        SELECT * FROM public.automation_occurrences
         WHERE workspace_id = $1 AND occurrence_id = $2
      `, [source.workspace_id, source.occurrence_id])).rows[0];
      if (existing?.status !== "accepted"
        || existing.authorization_decision_id !== decisionId
        || existing.run_id !== run.runId
        || existing.product_command_id !== run.creationCommandId) {
        throw coded("automation_occurrence_acceptance_conflict");
      }
      return occurrenceView(existing);
    }, { uow });
  }

  async #insertDecision(uow, source, action, now) {
    await this.#query(uow, `
      INSERT INTO public.authorization_decisions (
        workspace_id, authorization_decision_id, scope_id, policy_revision_id,
        actor_principal_id, actor_principal_kind, actor_scope_grant_id,
        effective_principal_id, effective_principal_kind, effective_scope_grant_id,
        authorization_source, policy_grant_id, action_id, effect_class, argument_digest,
        permission_mode, auto_approved_effect_classes, auto_approved_action_ids,
        destructive_rule_version, disposition, reason_code, decided_at, expires_at
      ) VALUES (
        $1, $2, $3, $4,
        $5, 'scheduler', $6,
        $7, 'automation', $8,
        'policy_grant', $9, 'workflow_run', 'execute', $10,
        $11, $12::text[], $13::text[],
        'authority-v1', 'authorized', 'scheduler_policy_grant', $14, $15
      )
      ON CONFLICT (workspace_id, authorization_decision_id) DO NOTHING
    `, [
      source.workspace_id,
      action.decisionId,
      source.scope_id,
      source.scope_policy_revision_id,
      source.scheduler_principal_id,
      source.scheduler_scope_grant_id,
      source.automation_principal_id,
      source.automation_scope_grant_id,
      source.policy_grant_id,
      action.argumentDigest,
      source.permission_mode,
      source.auto_approved_effect_classes,
      source.auto_approved_action_ids,
      now,
      source.policy_grant_expires_at,
    ]);
    const decision = (await this.#query(uow, `
      SELECT authorization_decision_id, scope_id, policy_revision_id,
             actor_principal_id, actor_principal_kind,
             effective_principal_id, effective_principal_kind,
             authorization_source, policy_grant_id, action_id, effect_class,
             argument_digest, disposition, expires_at
        FROM public.authorization_decisions
       WHERE workspace_id = $1 AND authorization_decision_id = $2
    `, [source.workspace_id, action.decisionId])).rows[0];
    if (!decision
      || decision.scope_id !== source.scope_id
      || decision.policy_revision_id !== source.scope_policy_revision_id
      || decision.actor_principal_id !== source.scheduler_principal_id
      || decision.actor_principal_kind !== "scheduler"
      || decision.effective_principal_id !== source.automation_principal_id
      || decision.effective_principal_kind !== "automation"
      || decision.authorization_source !== "policy_grant"
      || decision.policy_grant_id !== source.policy_grant_id
      || decision.action_id !== "workflow_run"
      || decision.effect_class !== "execute"
      || decision.argument_digest !== action.argumentDigest
      || decision.disposition !== "authorized"
      || !isFuture(decision.expires_at, now)) {
      throw coded("automation_decision_identity_conflict");
    }
  }

  async #lockNextDueOccurrence(uow, workspaceId) {
    return (await this.#query(uow, `${automationSourceSql()}
      WHERE occurrence.workspace_id = $1 AND occurrence.status = 'due'
      ORDER BY occurrence.scheduled_for ASC, occurrence.occurrence_id ASC
      FOR UPDATE OF occurrence SKIP LOCKED
      LIMIT 1
    `, [workspaceId])).rows[0] ?? null;
  }

  async #materializeNextOccurrence(uow, workspaceId, now) {
    const due = (await this.#query(uow, `
      SELECT root.*, revision.automation_revision_id, revision.trigger_revision,
             revision.cron_expression, revision.timezone_name
        FROM public.automations root
        JOIN public.automation_revisions revision
          ON revision.workspace_id = root.workspace_id
         AND revision.automation_revision_id = root.current_revision_id
       WHERE root.workspace_id = $1
         AND root.status = 'active' AND root.next_scheduled_at <= $2
       ORDER BY root.next_scheduled_at ASC, root.automation_id ASC
       FOR UPDATE OF root SKIP LOCKED
       LIMIT 1
    `, [workspaceId, now])).rows[0];
    if (!due) return null;
    const [minute, hour] = String(due.cron_expression).split(" ").map(Number);
    const schedule = (await this.#query(uow, `
      SELECT ($1::timestamptz AT TIME ZONE $2)::date AS local_schedule_date,
             (((($1::timestamptz AT TIME ZONE $2)::date + 1)::timestamp)
               + make_interval(hours => $3, mins => $4)) AT TIME ZONE $2 AS next_scheduled_at
    `, [due.next_scheduled_at, due.timezone_name, hour, minute])).rows[0];
    const occurrenceId = derivedId(
      "automation-occurrence",
      due.workspace_id,
      due.automation_id,
      due.trigger_revision,
      schedule.local_schedule_date,
    );
    await this.#query(uow, `
      INSERT INTO public.automation_occurrences (
        workspace_id, occurrence_id, automation_id, automation_revision_id,
        trigger_revision, local_schedule_date, scheduled_for, status,
        schema_version, created_at, updated_at, payload
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        'due', 'workbench-automation-occurrence-v1', $8, $8, '{}'::jsonb
      )
      ON CONFLICT (workspace_id, automation_id, trigger_revision, local_schedule_date)
      DO NOTHING
    `, [
      due.workspace_id,
      occurrenceId,
      due.automation_id,
      due.automation_revision_id,
      due.trigger_revision,
      schedule.local_schedule_date,
      due.next_scheduled_at,
      now,
    ]);
    await this.#query(uow, `
      UPDATE public.automations
         SET next_scheduled_at = $3, last_occurrence_at = $4,
             write_version = write_version + 1, updated_at = $5
       WHERE workspace_id = $1 AND automation_id = $2
         AND current_revision_id = $6 AND status = 'active'
    `, [
      due.workspace_id,
      due.automation_id,
      schedule.next_scheduled_at,
      due.next_scheduled_at,
      now,
      due.automation_revision_id,
    ]);
    return (await this.#query(uow, `${automationSourceSql()}
      WHERE occurrence.workspace_id = $1
        AND occurrence.automation_id = $2
        AND occurrence.trigger_revision = $3
        AND occurrence.local_schedule_date = $4
      FOR UPDATE OF occurrence
    `, [
      due.workspace_id,
      due.automation_id,
      due.trigger_revision,
      schedule.local_schedule_date,
    ])).rows[0] ?? null;
  }

  async #terminalize(uow, source, status, reasonCode, now) {
    const updated = (await this.#query(uow, `
      UPDATE public.automation_occurrences
         SET status = $3, reason_code = $4, terminal_at = $5, updated_at = $5
       WHERE workspace_id = $1 AND occurrence_id = $2 AND status = 'due'
       RETURNING *
    `, [source.workspace_id, source.occurrence_id, status, reasonCode, now])).rows[0];
    if (!updated) throw coded("automation_occurrence_transition_conflict");
    const inboxItemId = derivedId("automation-inbox", source.occurrence_id);
    await this.#query(uow, `
      INSERT INTO public.inbox_items (
        workspace_id, inbox_item_id, recipient_user_id,
        source_domain, source_id, source_revision, source_cursor,
        reason_code, severity, title, summary, target_kind, target_id,
        status, schema_version, created_at, updated_at
      ) VALUES (
        $1, $2, $3,
        'automation_occurrence', $4::public.product_identifier, $5, $4::text,
        $6, 'warning', 'Automation needs attention',
        'A daily Automation did not start and requires review.',
        'automation_occurrence', $4::public.product_identifier,
        'unread', 'workbench-inbox-item-v1', $7, $7
      )
      ON CONFLICT (
        workspace_id, recipient_user_id, source_domain, source_id, source_revision
      ) DO NOTHING
    `, [
      source.workspace_id,
      inboxItemId,
      source.owner_user_id,
      source.occurrence_id,
      Number(source.trigger_revision),
      reasonCode,
      now,
    ]);
    return occurrenceView(updated);
  }

  #query(uow, text, values = []) { return this.#sql.query(uow, text, values); }
}

function automationSourceSql() {
  return `
    SELECT occurrence.*,
           root.scope_id, root.owner_user_id, root.status AS automation_status,
           root.current_revision_id AS current_automation_revision_id,
           root.current_revision_number AS current_automation_revision_number,
           revision.workflow_id, revision.workflow_revision_id,
           revision.revision_number AS automation_revision_number,
           revision.automation_principal_id, revision.scope_policy_revision_id,
           revision.policy_grant_id, revision.observed_policy_grant_revision,
           revision.approval_policy, revision.misfire_policy,
           revision.misfire_max_lateness_seconds, revision.pins_finalized,
           policy_grant.subject_scope_grant_id AS automation_scope_grant_id,
           policy_grant.status AS policy_grant_status,
           policy_grant.revision AS policy_grant_revision,
           policy_grant.expires_at AS policy_grant_expires_at,
           automation_grant.status AS automation_scope_grant_status,
           automation_principal.status AS automation_principal_status,
           owner_membership.status AS owner_membership_status,
           owner_principal.status AS owner_principal_status,
           owner_grant.status AS owner_scope_grant_status,
           scope.status AS scope_status,
           scope.current_policy_revision_id,
           policy.permission_mode, policy.auto_approved_effect_classes,
           policy.auto_approved_action_ids,
           scheduler.principal_id AS scheduler_principal_id,
           scheduler.scope_grant_id AS scheduler_scope_grant_id,
           COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
               'resourceId', input_pin.resource_id,
               'version', input_pin.resource_version,
               'label', resource.label,
               'contentHash', input_pin.resource_content_hash
             ) ORDER BY input_pin.input_name, input_pin.input_pin_id)
               FROM public.automation_input_pins input_pin
               JOIN public.workspace_resources resource
                 ON resource.workspace_id = input_pin.workspace_id
                AND resource.resource_id = input_pin.resource_id
                AND resource.resource_version = input_pin.resource_version
                AND resource.content_hash = input_pin.resource_content_hash
              WHERE input_pin.workspace_id = occurrence.workspace_id
                AND input_pin.automation_revision_id = occurrence.automation_revision_id
           ), '[]'::jsonb) AS resource_refs
      FROM public.automation_occurrences occurrence
      JOIN public.automations root
        ON root.workspace_id = occurrence.workspace_id
       AND root.automation_id = occurrence.automation_id
      JOIN public.automation_revisions revision
        ON revision.workspace_id = occurrence.workspace_id
       AND revision.automation_revision_id = occurrence.automation_revision_id
      JOIN public.policy_grants policy_grant
        ON policy_grant.workspace_id = revision.workspace_id
       AND policy_grant.policy_grant_id = revision.policy_grant_id
      JOIN public.product_scopes scope
        ON scope.workspace_id = revision.workspace_id
       AND scope.scope_id = revision.scope_id
      JOIN public.workspace_memberships owner_membership
        ON owner_membership.workspace_id = root.workspace_id
       AND owner_membership.user_id = root.owner_user_id
      JOIN public.workspace_principals owner_principal
        ON owner_principal.workspace_id = root.workspace_id
       AND owner_principal.principal_id = root.owner_user_id
       AND owner_principal.principal_kind = 'user'
      JOIN public.workspace_principals automation_principal
        ON automation_principal.workspace_id = revision.workspace_id
       AND automation_principal.principal_id = revision.automation_principal_id
       AND automation_principal.principal_kind = 'automation'
      JOIN public.scope_principal_grants owner_grant
        ON owner_grant.workspace_id = revision.workspace_id
       AND owner_grant.scope_id = revision.scope_id
       AND owner_grant.grant_id = revision.owner_scope_grant_id
       AND owner_grant.principal_id = revision.owner_user_id
       AND owner_grant.principal_kind = 'user'
       AND owner_grant.access_kind = 'operation'
      JOIN public.scope_principal_grants automation_grant
        ON automation_grant.workspace_id = revision.workspace_id
       AND automation_grant.scope_id = revision.scope_id
       AND automation_grant.grant_id = policy_grant.subject_scope_grant_id
       AND automation_grant.principal_id = revision.automation_principal_id
       AND automation_grant.principal_kind = 'automation'
       AND automation_grant.access_kind = 'operation'
      JOIN public.scope_policy_revisions policy
        ON policy.workspace_id = revision.workspace_id
       AND policy.scope_id = revision.scope_id
       AND policy.policy_revision_id = revision.scope_policy_revision_id
      LEFT JOIN LATERAL (
        SELECT principal.principal_id, scheduler_grant.grant_id AS scope_grant_id
          FROM public.workspace_principals principal
          JOIN public.scope_principal_grants scheduler_grant
            ON scheduler_grant.workspace_id = principal.workspace_id
           AND scheduler_grant.scope_id = revision.scope_id
           AND scheduler_grant.principal_id = principal.principal_id
           AND scheduler_grant.principal_kind = 'scheduler'
           AND scheduler_grant.access_kind = 'operation'
           AND scheduler_grant.status = 'active'
         WHERE principal.workspace_id = revision.workspace_id
           AND principal.principal_kind = 'scheduler'
           AND principal.status = 'active'
         ORDER BY principal.principal_id ASC, scheduler_grant.grant_id ASC
         LIMIT 1
      ) scheduler ON true
  `;
}

function occurrenceView(row) {
  return {
    occurrenceId: row.occurrence_id,
    automationId: row.automation_id,
    triggerRevision: Number(row.trigger_revision),
    localScheduleDate: String(row.local_schedule_date),
    scheduledFor: iso(row.scheduled_for),
    status: row.status,
    commandId: row.product_command_id ?? null,
    runId: row.run_id ?? null,
    reasonCode: row.reason_code ?? null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
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

function requiredId(value, code) {
  if (typeof value !== "string" || !value) throw coded(code);
}
function iso(value) { return value instanceof Date ? value.toISOString() : String(value); }
function coded(code) { const error = new Error(code); error.code = code; return error; }
