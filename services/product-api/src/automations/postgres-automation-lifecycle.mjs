import { randomUUID } from "node:crypto";

import { ProductStoreError } from "../store/errors.mjs";
import { canonicalRequestHash } from "../store/serialization.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EFFECTS = new Set(["read", "write_local", "execute", "external_write", "administrative"]);
const OBSERVATION_TIERS = new Set(["private", "workspace_readable", "observation_disabled"]);
const AUTOMATION_STATES = new Set(["active", "paused", "archived"]);
const MAX_PAGE_SIZE = 100;

/**
 * PostgreSQL owner for the public Scope Policy and daily Automation lifecycle.
 *
 * This is deliberately not a CRUD adapter. Every consequential operation
 * writes an immutable AuthorizationDecision pair and a completed
 * ProductCommand in the same transaction as its target aggregate.  The
 * Scheduler remains the only caller that may turn an active Automation into a
 * Workflow Run.
 */
export class PostgresAutomationLifecycle {
  #store;
  #sql;
  #clock;
  #idFactory;

  constructor({
    store,
    clock = () => new Date(),
    idFactory = (kind) => `${kind}-${randomUUID()}`,
  } = {}) {
    if (!store?.bindAdapter || !store?.withTransaction || !store?.connect) {
      throw new TypeError("postgres_automation_lifecycle_store_required");
    }
    if (typeof clock !== "function" || typeof idFactory !== "function") {
      throw new TypeError("postgres_automation_lifecycle_dependencies_invalid");
    }
    this.#store = store;
    this.#clock = clock;
    this.#idFactory = idFactory;
    this.#sql = store.bindAdapter(({ execute }) => Object.freeze({
      query: (uow, text, values = []) => execute(uow, { text, values }),
    }));
  }

  async listScopes({ context } = {}) {
    assertContext(context);
    return this.#transaction(async (query) => {
      const rows = (await query(`
        SELECT scope.*, policy.observation_tier, policy.permission_mode,
               policy.auto_approved_effect_classes, policy.auto_approved_action_ids
          FROM public.product_scopes scope
          JOIN public.scope_policy_revisions policy
            ON policy.workspace_id = scope.workspace_id
           AND policy.scope_id = scope.scope_id
           AND policy.policy_revision_id = scope.current_policy_revision_id
         WHERE scope.workspace_id = $1
           AND scope.status = 'active'
           AND (
             scope.owner_user_id = $2
             OR EXISTS (
               SELECT 1 FROM public.workspace_memberships membership
                WHERE membership.workspace_id = scope.workspace_id
                  AND membership.user_id = $2
                  AND membership.status = 'active'
                  AND membership.role IN ('owner', 'admin')
             )
           )
         ORDER BY scope.created_at ASC, scope.scope_id ASC
      `, [context.workspaceId, context.userId])).rows;
      return rows.map(scopeView);
    });
  }

  async getScope({ scopeId, context } = {}) {
    assertContext(context); assertId(scopeId, "scope_id_required");
    return this.#transaction(async (query) => {
      const row = await this.#loadScope(query, { workspaceId: context.workspaceId, scopeId, lock: false });
      if (!row || !canReadScope(row, context)) throw coded("scope_not_found");
      return { data: scopeView(row), etag: scopeEtag(row) };
    });
  }

  async reviseScopePolicy({ scopeId, idempotencyKey, ifMatch, request, context } = {}) {
    assertContext(context); assertId(scopeId, "scope_id_required");
    assertIdempotencyKey(idempotencyKey); assertEtag(ifMatch, "scope_policy_etag_required");
    const policy = normalizeScopePolicyRequest(request?.data);
    return this.#withReceipt({
      workspaceId: context.workspaceId,
      userId: context.userId,
      scope: `revise-scope-policy:${scopeId}`,
      key: idempotencyKey,
      request: { ifMatch, data: policy },
    }, async (query) => {
      const authority = await this.#loadOwnerScopeAuthority(query, {
        workspaceId: context.workspaceId, userId: context.userId, scopeId,
      });
      if (scopeEtag(authority) !== ifMatch) throw coded("scope_policy_conflict");
      if (sameScopePolicy(authority, policy)) throw coded("scope_policy_no_change");
      const now = await this.#databaseNow(query);
      const policyRevisionId = newId(this.#idFactory, "scope-policy");
      const policyRevision = Number(authority.policy_revision) + 1;
      const intent = {
        scopeId,
        priorPolicyRevisionId: authority.current_policy_revision_id,
        policyRevisionId,
        policy,
      };
      const commandAuthority = await this.#authorizeExplicit(query, {
        authority,
        userId: context.userId,
        actionId: "scope_policy_activate",
        effectClass: "administrative",
        intent,
        now,
      });
      const commandId = newId(this.#idFactory, "product-command");
      await this.#insertCommand(query, {
        commandId,
        authority,
        userId: context.userId,
        actionId: "scope_policy_activate",
        effectClass: "administrative",
        authorization: commandAuthority,
        targetKind: "scope_policy_revision",
        targetId: policyRevisionId,
        targetRevision: policyRevision,
        now,
      });
      const contentHash = canonicalRequestHash({
        schemaVersion: "workbench-v1",
        scopeId,
        policyRevisionId,
        revision: policyRevision,
        policy,
      });
      await query(`
        INSERT INTO public.scope_policy_revisions (
          workspace_id, scope_id, policy_revision_id, revision,
          observation_tier, permission_mode, auto_approved_effect_classes,
          auto_approved_action_ids, policy_content_hash,
          created_by_principal_id, created_by_principal_kind, created_at, payload
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8::text[], $9,
          $10, 'user', $11::timestamptz, '{}'::jsonb)
      `, [
        context.workspaceId, scopeId, policyRevisionId, policyRevision,
        policy.observationTier, policy.defaultPermission.mode,
        policy.defaultPermission.autoApprovedEffectClasses ?? [],
        policy.defaultPermission.autoApprovedActionIds ?? [],
        contentHash, context.userId, now,
      ]);
      const updated = (await query(`
        UPDATE public.product_scopes
           SET current_policy_revision_id = $3,
               revision = revision + 1,
               updated_at = $4::timestamptz
         WHERE workspace_id = $1 AND scope_id = $2
           AND current_policy_revision_id = $5
           AND revision = $6
         RETURNING revision
      `, [
        context.workspaceId, scopeId, policyRevisionId, now,
        authority.current_policy_revision_id, Number(authority.revision),
      ])).rows[0];
      if (!updated) throw coded("scope_policy_conflict");
      await query(`
        INSERT INTO public.scope_policy_activations (
          workspace_id, scope_id, policy_revision_id, policy_revision_number,
          prior_policy_revision_id, command_id, activated_by_user_id, activated_at, payload
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, '{}'::jsonb)
      `, [
        context.workspaceId, scopeId, policyRevisionId, policyRevision,
        authority.current_policy_revision_id, commandId, context.userId, now,
      ]);
      const next = await this.#loadScope(query, { workspaceId: context.workspaceId, scopeId, lock: false });
      return { data: scopeView(next), etag: scopeEtag(next) };
    });
  }

  async listAutomations({ query = {}, context } = {}) {
    assertContext(context);
    const limit = pageLimit(query.limit);
    return this.#transaction(async (sql) => {
      const rows = (await sql(`
        SELECT automation_id
          FROM public.automations root
         WHERE root.workspace_id = $1
           AND (
             root.owner_user_id = $2
             OR EXISTS (
               SELECT 1 FROM public.workspace_memberships membership
                WHERE membership.workspace_id = root.workspace_id
                  AND membership.user_id = $2
                  AND membership.status = 'active'
                  AND membership.role IN ('owner', 'admin')
             )
           )
           AND ($3::text IS NULL OR root.status = $3)
         ORDER BY root.updated_at DESC, root.automation_id DESC
         LIMIT $4
      `, [context.workspaceId, context.userId, query.status ?? null, limit])).rows;
      const values = [];
      for (const row of rows) {
        values.push(await this.#loadAutomation(sql, {
          workspaceId: context.workspaceId,
          automationId: row.automation_id,
          context,
        }));
      }
      return values;
    });
  }

  /**
   * Lists only finalized Loop versions that this owner can actually bind to a
   * daily Automation.  The candidate contains its immutable Resource pins and
   * Connection requirements so a browser never has to guess internal IDs.
   */
  async listCandidates({ query = {}, context } = {}) {
    assertContext(context);
    const limit = pageLimit(query.limit);
    const requestedScopeId = query.scopeId ?? null;
    if (requestedScopeId !== null) assertId(requestedScopeId, "scope_id_required");
    return this.#transaction(async (sql) => {
      const rows = (await sql(`
        SELECT loop.loop_version_id, loop.workflow_id, loop.version,
               workflow.scope_id, workflow.name, workflow.description
          FROM public.loop_versions loop
          JOIN public.workflows workflow
            ON workflow.workspace_id = loop.workspace_id
           AND workflow.workflow_id = loop.workflow_id
          JOIN public.execution_plans plan
            ON plan.workspace_id = loop.workspace_id
           AND plan.plan_id = loop.execution_plan_id
           AND plan.compile_result_id = loop.compile_result_id
           AND plan.workflow_id = loop.workflow_id
           AND plan.workflow_revision_id = loop.workflow_revision_id
           AND plan.pins_finalized
         WHERE loop.workspace_id = $1
           AND loop.pins_finalized
           AND workflow.owner_user_id = $2
           AND workflow.status = 'ready'
           AND workflow.lifecycle IN ('ready', 'shared')
           AND workflow.visibility IN ('private', 'workspace')
           AND ($3::public.product_identifier IS NULL OR workflow.scope_id = $3)
           AND NOT EXISTS (
             SELECT 1
               FROM public.loop_version_resource_pins resource_pin
               LEFT JOIN public.workspace_resources resource
                 ON resource.workspace_id = resource_pin.workspace_id
                AND resource.resource_id = resource_pin.resource_id
                AND resource.resource_version = resource_pin.resource_version
                AND resource.content_hash = resource_pin.content_hash
                AND resource.readiness_status = 'ready'
              WHERE resource_pin.workspace_id = loop.workspace_id
                AND resource_pin.loop_version_id = loop.loop_version_id
                AND resource.resource_id IS NULL
           )
         ORDER BY workflow.updated_at DESC, loop.released_at DESC, loop.loop_version_id DESC
         LIMIT $4
      `, [context.workspaceId, context.userId, requestedScopeId, limit])).rows;
      const values = [];
      for (const row of rows) {
        values.push(await this.#loadCandidate(sql, {
          workspaceId: context.workspaceId,
          loopVersionId: row.loop_version_id,
          row,
        }));
      }
      return values;
    });
  }

  async getAutomation({ automationId, context } = {}) {
    assertContext(context); assertId(automationId, "automation_id_required");
    return this.#transaction(async (query) => {
      const automation = await this.#loadAutomation(query, {
        workspaceId: context.workspaceId, automationId, context,
      });
      return { data: automation, etag: automationEtag(automation) };
    });
  }

  async createAutomation({ idempotencyKey, request, context } = {}) {
    assertContext(context); assertIdempotencyKey(idempotencyKey);
    const input = normalizeAutomationCreateRequest(request?.data);
    return this.#withReceipt({
      workspaceId: context.workspaceId,
      userId: context.userId,
      scope: "create-automation",
      key: idempotencyKey,
      request: { data: input },
    }, async (query) => {
      const authority = await this.#loadOwnerScopeAuthority(query, {
        workspaceId: context.workspaceId,
        userId: context.userId,
        scopeId: input.scopeId,
      });
      requireUnattendedPolicy(authority);
      const now = await this.#databaseNow(query);
      const automationId = newId(this.#idFactory, "automation");
      const automationRevisionId = newId(this.#idFactory, "automation-revision");
      const automationPrincipalId = newId(this.#idFactory, "automation-principal");
      const automationGrantId = newId(this.#idFactory, "automation-scope-grant");
      const policyGrantId = newId(this.#idFactory, "automation-policy-grant");
      const loop = await this.#loadLoop(query, {
        workspaceId: context.workspaceId,
        scopeId: input.scopeId,
        loopVersionId: input.loopVersionId,
        userId: context.userId,
      });
      const pins = await this.#resolveAutomationPins(query, {
        workspaceId: context.workspaceId,
        scopeId: input.scopeId,
        loop,
        inputBindings: input.inputBindings,
        connectionBindings: input.connectionBindings,
      });
      const modelPolicy = await this.#loadModelPolicy(query, {
        workspaceId: context.workspaceId,
        scopeId: input.scopeId,
        planId: loop.execution_plan_id,
      });
      const expiresAt = normalizedFutureTimestamp(input.grantExpiresAt, now, "automation_grant_expiry_invalid");
      const reviewAt = input.grantReviewAt === null
        ? null
        : normalizedReviewTimestamp(input.grantReviewAt, now, expiresAt);
      const nextScheduledAt = await this.#nextScheduledAt(query, input.trigger, now);

      await query(`
        INSERT INTO public.workspace_principals (
          workspace_id, principal_id, principal_kind, user_id, membership_id,
          status, revision, created_at, updated_at, revoked_at, payload
        ) VALUES ($1, $2, 'automation', NULL, NULL,
          'active', 1, $3::timestamptz, $3::timestamptz, NULL, '{}'::jsonb)
      `, [context.workspaceId, automationPrincipalId, now]);

      await this.#issueAutomationScopeGrant(query, {
        authority, userId: context.userId, principalId: automationPrincipalId,
        grantId: automationGrantId, now,
      });
      await this.#issueAutomationPolicyGrant(query, {
        authority, userId: context.userId, automationId, principalId: automationPrincipalId,
        subjectScopeGrantId: automationGrantId, policyGrantId,
        expiresAt, reviewAt, now,
      });

      const intent = {
        automationId,
        scopeId: input.scopeId,
        loopVersionId: input.loopVersionId,
        trigger: input.trigger,
        displayName: input.displayName,
      };
      const commandAuthority = await this.#authorizeExplicit(query, {
        authority, userId: context.userId, actionId: "automation_create",
        effectClass: "administrative", intent, now,
      });
      const commandId = newId(this.#idFactory, "product-command");
      await this.#insertCommand(query, {
        commandId, authority, userId: context.userId, actionId: "automation_create",
        effectClass: "administrative", authorization: commandAuthority,
        targetKind: "automation", targetId: automationId, targetRevision: 1, now,
      });
      await this.#insertAutomationAggregate(query, {
        workspaceId: context.workspaceId,
        automationId,
        automationRevisionId,
        automationPrincipalId,
        ownerScopeGrantId: authority.grant_id,
        policyGrantId,
        policyGrantRevision: 1,
        scopePolicyRevisionId: authority.current_policy_revision_id,
        scopePolicy: policyFromAuthority(authority),
        ownerUserId: context.userId,
        input,
        loop,
        pins,
        modelPolicy,
        status: "active",
        revisionNumber: 1,
        writeVersion: 1,
        nextScheduledAt,
        now,
      });
      await query(`
        INSERT INTO public.automation_lifecycle_events (
          workspace_id, command_id, automation_id, automation_revision_id,
          kind, target_revision, status_after, created_by_user_id, created_at, payload
        ) VALUES ($1, $2, $3, $4, 'automation_create', 1, 'active', $5, $6::timestamptz, '{}'::jsonb)
      `, [context.workspaceId, commandId, automationId, automationRevisionId, context.userId, now]);
      await query(`SELECT public.assert_automation_revision_consumable($1, $2, $3, 1)`, [
        context.workspaceId, automationId, automationRevisionId,
      ]);
      const automation = await this.#loadAutomation(query, {
        workspaceId: context.workspaceId, automationId, context,
      });
      return { data: automation, etag: automationEtag(automation) };
    });
  }

  async reviseAutomation({ automationId, idempotencyKey, ifMatch, request, context } = {}) {
    assertContext(context); assertId(automationId, "automation_id_required");
    assertIdempotencyKey(idempotencyKey); assertEtag(ifMatch, "automation_etag_required");
    const input = normalizeAutomationRevisionRequest(request?.data);
    return this.#withReceipt({
      workspaceId: context.workspaceId,
      userId: context.userId,
      scope: `revise-automation:${automationId}`,
      key: idempotencyKey,
      request: { ifMatch, data: input },
    }, async (query) => {
      const current = await this.#loadAutomationRowForUpdate(query, {
        workspaceId: context.workspaceId, automationId, context,
      });
      if (automationRowEtag(current) !== ifMatch) throw coded("automation_conflict");
      const authority = await this.#loadOwnerScopeAuthority(query, {
        workspaceId: context.workspaceId,
        userId: context.userId,
        scopeId: current.scope_id,
      });
      requireUnattendedPolicy(authority);
      const now = await this.#databaseNow(query);
      const loop = await this.#loadLoop(query, {
        workspaceId: context.workspaceId, scopeId: current.scope_id,
        loopVersionId: input.loopVersionId, userId: context.userId,
      });
      const pins = await this.#resolveAutomationPins(query, {
        workspaceId: context.workspaceId, scopeId: current.scope_id,
        loop, inputBindings: input.inputBindings, connectionBindings: input.connectionBindings,
      });
      const modelPolicy = await this.#loadModelPolicy(query, {
        workspaceId: context.workspaceId, scopeId: current.scope_id, planId: loop.execution_plan_id,
      });
      const nextScheduledAt = current.status === "active"
        ? await this.#nextScheduledAt(query, input.trigger, now)
        : null;
      const revisionNumber = Number(current.current_revision_number) + 1;
      const writeVersion = Number(current.write_version) + 1;
      const automationRevisionId = newId(this.#idFactory, "automation-revision");
      // A policy grant is unique for an Automation principal and policy
      // revision. Revoke the superseded grant inside this same serializable
      // transaction before minting its replacement; the root pointer does not
      // advance until the new revision and grant are both assembled.
      await this.#revokeAutomationPolicyGrant(query, {
        workspaceId: context.workspaceId,
        policyGrantId: current.policy_grant_id,
        now,
      });
      const policyGrant = await this.#issueAutomationPolicyGrant(query, {
        authority,
        userId: context.userId,
        automationId,
        principalId: current.automation_principal_id,
        subjectScopeGrantId: current.automation_scope_grant_id,
        policyGrantId: newId(this.#idFactory, "automation-policy-grant"),
        expiresAt: normalizedFutureTimestamp(input.grantExpiresAt, now, "automation_grant_expiry_invalid"),
        reviewAt: input.grantReviewAt === null
          ? null
          : normalizedReviewTimestamp(input.grantReviewAt, now, input.grantExpiresAt),
        now,
      });
      const intent = {
        automationId,
        baseRevisionId: current.current_revision_id,
        loopVersionId: input.loopVersionId,
        trigger: input.trigger,
        displayName: input.displayName,
      };
      const commandAuthority = await this.#authorizeExplicit(query, {
        authority, userId: context.userId, actionId: "automation_revise",
        effectClass: "administrative", intent, now,
      });
      const commandId = newId(this.#idFactory, "product-command");
      await this.#insertCommand(query, {
        commandId, authority, userId: context.userId, actionId: "automation_revise",
        effectClass: "administrative", authorization: commandAuthority,
        targetKind: "automation", targetId: automationId, targetRevision: writeVersion, now,
      });
      await this.#insertAutomationRevision(query, {
        workspaceId: context.workspaceId,
        automationId,
        automationRevisionId,
        automationPrincipalId: current.automation_principal_id,
        ownerScopeGrantId: authority.grant_id,
        policyGrantId: policyGrant.policyGrantId,
        policyGrantRevision: policyGrant.revision,
        scopePolicyRevisionId: authority.current_policy_revision_id,
        scopePolicy: policyFromAuthority(authority),
        ownerUserId: context.userId,
        input,
        loop,
        pins,
        modelPolicy,
        revisionNumber,
        baseRevisionId: current.current_revision_id,
        baseRevisionNumber: Number(current.current_revision_number),
        now,
      });
      await query(`UPDATE public.automation_revisions
        SET pins_finalized = true
        WHERE workspace_id = $1 AND automation_revision_id = $2 AND pins_finalized = false`, [
        context.workspaceId, automationRevisionId,
      ]);
      const updated = (await query(`
        UPDATE public.automations
           SET display_name = $3, current_revision_id = $4,
               current_revision_number = $5, write_version = $6,
               next_scheduled_at = $7::timestamptz,
               updated_at = $8::timestamptz
         WHERE workspace_id = $1 AND automation_id = $2
           AND current_revision_id = $9 AND write_version = $10
         RETURNING *
      `, [
        context.workspaceId, automationId, input.displayName, automationRevisionId,
        revisionNumber, writeVersion, nextScheduledAt, now,
        current.current_revision_id, Number(current.write_version),
      ])).rows[0];
      if (!updated) throw coded("automation_conflict");
      await query(`
        INSERT INTO public.automation_lifecycle_events (
          workspace_id, command_id, automation_id, automation_revision_id,
          kind, target_revision, status_after, created_by_user_id, created_at, payload
        ) VALUES ($1, $2, $3, $4, 'automation_revise', $5, $6, $7, $8::timestamptz, '{}'::jsonb)
      `, [
        context.workspaceId, commandId, automationId, automationRevisionId,
        writeVersion, updated.status, context.userId, now,
      ]);
      if (updated.status === "active") {
        await query(`SELECT public.assert_automation_revision_consumable($1, $2, $3, $4)`, [
          context.workspaceId, automationId, automationRevisionId, policyGrant.revision,
        ]);
      }
      const automation = await this.#loadAutomation(query, {
        workspaceId: context.workspaceId, automationId, context,
      });
      return { data: automation, etag: automationEtag(automation) };
    });
  }

  async activateAutomation({ automationId, idempotencyKey, ifMatch, context } = {}) {
    return this.#transitionAutomation({ automationId, idempotencyKey, ifMatch, context, target: "active" });
  }

  async pauseAutomation({ automationId, idempotencyKey, ifMatch, context } = {}) {
    return this.#transitionAutomation({ automationId, idempotencyKey, ifMatch, context, target: "paused" });
  }

  async archiveAutomation({ automationId, idempotencyKey, ifMatch, context } = {}) {
    return this.#transitionAutomation({ automationId, idempotencyKey, ifMatch, context, target: "archived" });
  }

  async listOccurrences({ automationId, query = {}, context } = {}) {
    assertContext(context); assertId(automationId, "automation_id_required");
    const limit = pageLimit(query.limit);
    return this.#transaction(async (sql) => {
      await this.#loadAutomationRowForUpdate(sql, { workspaceId: context.workspaceId, automationId, context, lock: false });
      const rows = (await sql(`
        SELECT occurrence.*, run.status AS run_status, run.workflow_id
          FROM public.automation_occurrences occurrence
          LEFT JOIN public.workflow_runs run
            ON run.workspace_id = occurrence.workspace_id AND run.run_id = occurrence.run_id
         WHERE occurrence.workspace_id = $1 AND occurrence.automation_id = $2
         ORDER BY occurrence.scheduled_for DESC, occurrence.occurrence_id DESC
         LIMIT $3
      `, [context.workspaceId, automationId, limit])).rows;
      return rows.map(occurrenceView);
    });
  }

  async #transitionAutomation({ automationId, idempotencyKey, ifMatch, context, target }) {
    assertContext(context); assertId(automationId, "automation_id_required");
    assertIdempotencyKey(idempotencyKey); assertEtag(ifMatch, "automation_etag_required");
    if (!AUTOMATION_STATES.has(target)) throw coded("automation_state_invalid");
    return this.#withReceipt({
      workspaceId: context.workspaceId,
      userId: context.userId,
      scope: `${target}-automation:${automationId}`,
      key: idempotencyKey,
      request: { ifMatch, target },
    }, async (query) => {
      const current = await this.#loadAutomationRowForUpdate(query, {
        workspaceId: context.workspaceId, automationId, context,
      });
      if (automationRowEtag(current) !== ifMatch) throw coded("automation_conflict");
      if (current.status === "archived") throw coded("automation_archived");
      if (current.status === target) {
        const automation = await this.#loadAutomation(query, {
          workspaceId: context.workspaceId, automationId, context,
        });
        return { data: automation, etag: automationEtag(automation) };
      }
      const authority = await this.#loadOwnerScopeAuthority(query, {
        workspaceId: context.workspaceId, userId: context.userId, scopeId: current.scope_id,
      });
      const now = await this.#databaseNow(query);
      const actionId = target === "active" ? "automation_activate"
        : target === "paused" ? "automation_pause" : "automation_archive";
      const commandAuthority = await this.#authorizeExplicit(query, {
        authority, userId: context.userId, actionId, effectClass: "administrative",
        intent: { automationId, from: current.status, to: target }, now,
      });
      const commandId = newId(this.#idFactory, "product-command");
      const writeVersion = Number(current.write_version) + 1;
      await this.#insertCommand(query, {
        commandId, authority, userId: context.userId, actionId,
        effectClass: "administrative", authorization: commandAuthority,
        targetKind: "automation", targetId: automationId, targetRevision: writeVersion, now,
      });
      const nextScheduledAt = target === "active"
        ? await this.#nextScheduledForCurrentAutomation(query, current.current_revision_id, now)
        : target === "archived" ? null : current.next_scheduled_at;
      const updated = (await query(`
        UPDATE public.automations
           SET status = $3, write_version = $4,
               next_scheduled_at = $5::timestamptz,
               archived_at = CASE WHEN $3 = 'archived' THEN $6::timestamptz ELSE NULL END,
               updated_at = $6::timestamptz
         WHERE workspace_id = $1 AND automation_id = $2
           AND write_version = $7
         RETURNING *
      `, [
        context.workspaceId, automationId, target, writeVersion, nextScheduledAt,
        now, Number(current.write_version),
      ])).rows[0];
      if (!updated) throw coded("automation_conflict");
      await query(`
        INSERT INTO public.automation_lifecycle_events (
          workspace_id, command_id, automation_id, automation_revision_id,
          kind, target_revision, status_after, created_by_user_id, created_at, payload
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, '{}'::jsonb)
      `, [
        context.workspaceId, commandId, automationId, current.current_revision_id,
        actionId, writeVersion, target, context.userId, now,
      ]);
      if (target === "active") {
        const policyGrant = (await query(`
          SELECT revision FROM public.policy_grants
           WHERE workspace_id = $1 AND policy_grant_id = $2 FOR SHARE
        `, [context.workspaceId, current.policy_grant_id])).rows[0];
        if (!policyGrant) throw coded("automation_grant_not_found");
        await query(`SELECT public.assert_automation_revision_consumable($1, $2, $3, $4)`, [
          context.workspaceId, automationId, current.current_revision_id, Number(policyGrant.revision),
        ]);
      }
      const automation = await this.#loadAutomation(query, {
        workspaceId: context.workspaceId, automationId, context,
      });
      return { data: automation, etag: automationEtag(automation) };
    });
  }

  async #insertAutomationAggregate(query, input) {
    await query("SET CONSTRAINTS ALL DEFERRED");
    await query(`
      INSERT INTO public.automations (
        workspace_id, automation_id, scope_id, owner_user_id, owner_principal_id,
        automation_principal_id, schema_version, display_name, status,
        current_revision_id, current_revision_number, write_version,
        next_scheduled_at, last_occurrence_at, failure_streak,
        created_by_principal_id, created_by_principal_kind, created_at, updated_at,
        archived_at, payload
      ) VALUES ($1, $2, $3, $4, $4,
        $5, 'workbench-automation-v1', $6, $7,
        $8, $9, $10, $11::timestamptz, NULL, 0,
        $4, 'user', $12::timestamptz, $12::timestamptz,
        NULL, '{}'::jsonb)
    `, [
      input.workspaceId, input.automationId, input.input.scopeId, input.ownerUserId,
      input.automationPrincipalId, input.input.displayName, input.status,
      input.automationRevisionId, input.revisionNumber, input.writeVersion,
      input.nextScheduledAt, input.now,
    ]);
    await this.#insertAutomationRevision(query, {
      ...input,
      revisionNumber: input.revisionNumber,
      baseRevisionId: null,
      baseRevisionNumber: null,
    });
    await query(`UPDATE public.automation_revisions
      SET pins_finalized = true
      WHERE workspace_id = $1 AND automation_revision_id = $2 AND pins_finalized = false`, [
      input.workspaceId, input.automationRevisionId,
    ]);
  }

  async #insertAutomationRevision(query, {
    workspaceId,
    automationId,
    automationRevisionId,
    automationPrincipalId,
    ownerScopeGrantId,
    policyGrantId,
    policyGrantRevision,
    scopePolicyRevisionId,
    scopePolicy,
    ownerUserId,
    input,
    loop,
    pins,
    modelPolicy,
    revisionNumber,
    baseRevisionId,
    baseRevisionNumber,
    now,
  }) {
    const triggerRevision = await this.#resolveTriggerRevision(query, {
      workspaceId,
      automationId,
      trigger: input.trigger,
    });
    const contentHash = canonicalRequestHash({
      schemaVersion: "workbench-automation-revision-v1",
      automationId,
      automationRevisionId,
      revisionNumber,
      baseRevisionId,
      loopVersionId: loop.loop_version_id,
      trigger: input.trigger,
      inputBindings: input.inputBindings,
      connectionBindings: input.connectionBindings,
      budgetPolicy: input.budgetPolicy,
      misfirePolicy: input.misfirePolicy,
      policyRevisionId: scopePolicyRevisionId,
      policyGrantId,
      modelPolicyRevisionId: modelPolicy.policy_revision_id,
    });
    await query(`
      INSERT INTO public.automation_revisions (
        workspace_id, automation_revision_id, automation_id, scope_id,
        automation_principal_id, owner_user_id, owner_scope_grant_id,
        revision_number, base_revision_id, base_revision_number, schema_version,
        workflow_id, workflow_revision_id, workflow_revision_content_hash,
        loop_version_id, loop_version_content_hash, compile_result_id,
        execution_plan_id, execution_plan_content_hash,
        scope_policy_revision_id, policy_grant_id, observed_policy_grant_revision,
        model_policy_revision_id, model_policy_revision_number, model_profile_revision_ids,
        trigger_kind, cron_expression, timezone_name, trigger_revision,
        execution_location_policy, budget_currency, max_cost_microunits,
        max_duration_seconds, approval_policy, allowed_effect_classes,
        misfire_policy, misfire_max_lateness_seconds, dedupe_policy, content_hash,
        pins_finalized, created_by_principal_id, created_by_principal_kind, created_at, payload
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7,
        $8, $9, $10, 'workbench-automation-revision-v1',
        $11, $12, $13,
        $14, $15, $16,
        $17, $18,
        $19, $20, $21,
        $22, $23, $24::public.product_identifier[],
        'daily_cron', $25, $26, $27,
        'cloud', 'USD', $28,
        $29, 'policy_grant_only', ARRAY['execute']::text[],
        $30, $31, 'local_schedule_date', $32,
        false, $6, 'user', $33::timestamptz, '{}'::jsonb
      )
    `, [
      workspaceId, automationRevisionId, automationId, input.scopeId,
      automationPrincipalId, ownerUserId, ownerScopeGrantId,
      revisionNumber, baseRevisionId, baseRevisionNumber,
      loop.workflow_id, loop.workflow_revision_id, loop.workflow_revision_content_hash,
      loop.loop_version_id, loop.loop_version_content_hash, loop.compile_result_id,
      loop.execution_plan_id, loop.execution_plan_content_hash,
      scopePolicyRevisionId, policyGrantId, policyGrantRevision,
      modelPolicy.policy_revision_id, Number(modelPolicy.revision), modelPolicy.planModelRevisionIds,
      input.trigger.expression, input.trigger.timezone, triggerRevision,
      input.budgetPolicy.maxCostUsdMicros, input.budgetPolicy.maxRuntimeSeconds,
      input.misfirePolicy.kind, input.misfirePolicy.maxLatenessSeconds, contentHash, now,
    ]);
    for (const pin of pins.resourcePins) {
      await query(`
        INSERT INTO public.automation_input_pins (
          workspace_id, automation_revision_id, automation_id, scope_id, workflow_id,
          loop_version_id, input_pin_id, input_name, input_kind,
          resource_id, resource_version, resource_content_hash, schema_version, created_at
        ) VALUES ($1, $2, $3, $4, $5,
          $6, $7, $8, 'resource',
          $9, $10, $11, 'workbench-automation-input-pin-v1', $12::timestamptz)
      `, [
        workspaceId, automationRevisionId, automationId, input.scopeId, loop.workflow_id,
        loop.loop_version_id, pin.bindingId, pin.inputKey,
        pin.resourceId, pin.version, pin.contentHash, now,
      ]);
    }
    for (const pin of pins.connectionPins) {
      await query(`
        INSERT INTO public.automation_connection_pins (
          workspace_id, automation_revision_id, automation_id, scope_id, workflow_id,
          loop_version_id, requirement_id, capability_key, required_effects,
          connection_id, connection_revision_id, connection_revision_number,
          secret_binding_id, secret_source, store_binding_ref, store_binding_revision,
          credential_fingerprint, schema_version, created_at
        ) VALUES ($1, $2, $3, $4, $5,
          $6, $7, $8, $9::jsonb,
          $10, $11, $12,
          $13, $14, $15, $16,
          $17, 'workbench-automation-connection-pin-v1', $18::timestamptz)
      `, [
        workspaceId, automationRevisionId, automationId, input.scopeId, loop.workflow_id,
        loop.loop_version_id, pin.requirementId, pin.capabilityKey, JSON.stringify(pin.requiredEffects),
        pin.connectionId, pin.connectionRevisionId, pin.connectionRevisionNumber,
        pin.secretBindingId, pin.secretSource, pin.storeBindingRef, pin.storeBindingRevision,
        pin.credentialFingerprint, now,
      ]);
    }
  }

  async #resolveTriggerRevision(query, { workspaceId, automationId, trigger }) {
    // The root row is locked by every revision-producing call.  Reading the
    // immutable history under that lock gives a stable generation: unchanged
    // cron content keeps its generation, while changed cron content gets the
    // next one.  The database trigger rechecks this independently.
    const rows = (await query(`
      SELECT trigger_revision, cron_expression, timezone_name
        FROM public.automation_revisions
       WHERE workspace_id = $1 AND automation_id = $2
       ORDER BY revision_number ASC
       FOR SHARE
    `, [workspaceId, automationId])).rows;
    const matching = rows.find((row) => (
      row.cron_expression === trigger.expression
      && row.timezone_name === trigger.timezone
    ));
    if (matching) return Number(matching.trigger_revision);
    return rows.reduce((maximum, row) => Math.max(maximum, Number(row.trigger_revision)), 0) + 1;
  }

  async #loadScope(query, { workspaceId, scopeId, lock = false } = {}) {
    return (await query(`
      SELECT scope.*, policy.observation_tier, policy.permission_mode,
             policy.auto_approved_effect_classes, policy.auto_approved_action_ids,
             policy.revision AS policy_revision
        FROM public.product_scopes scope
        JOIN public.scope_policy_revisions policy
          ON policy.workspace_id = scope.workspace_id
         AND policy.scope_id = scope.scope_id
         AND policy.policy_revision_id = scope.current_policy_revision_id
       WHERE scope.workspace_id = $1 AND scope.scope_id = $2
       ${lock ? "FOR UPDATE OF scope, policy" : ""}
    `, [workspaceId, scopeId])).rows[0] ?? null;
  }

  async #loadOwnerScopeAuthority(query, { workspaceId, userId, scopeId } = {}) {
    const row = (await query(`
      SELECT scope.*, policy.observation_tier, policy.permission_mode,
             policy.auto_approved_effect_classes, policy.auto_approved_action_ids,
             policy.revision AS policy_revision, scope_grant.grant_id,
             membership.role AS workspace_role
        FROM public.product_scopes scope
        JOIN public.scope_policy_revisions policy
          ON policy.workspace_id = scope.workspace_id
         AND policy.scope_id = scope.scope_id
         AND policy.policy_revision_id = scope.current_policy_revision_id
        JOIN public.scope_principal_grants scope_grant
          ON scope_grant.workspace_id = scope.workspace_id
         AND scope_grant.scope_id = scope.scope_id
         AND scope_grant.principal_id = $2
         AND scope_grant.principal_kind = 'user'
         AND scope_grant.access_kind = 'operation'
         AND scope_grant.status = 'active'
         AND scope_grant.can_approve = true
        JOIN public.workspace_memberships membership
          ON membership.workspace_id = scope.workspace_id
         AND membership.user_id = $2
         AND membership.status = 'active'
       WHERE scope.workspace_id = $1 AND scope.scope_id = $3
         AND scope.scope_kind = 'personal'
         AND scope.owner_user_id = $2
         AND scope.status = 'active'
         AND membership.role IN ('owner', 'admin')
       FOR UPDATE OF scope, policy, scope_grant, membership
    `, [workspaceId, userId, scopeId])).rows[0];
    if (!row) throw coded("automation_owner_scope_forbidden");
    return row;
  }

  async #loadLoop(query, { workspaceId, scopeId, loopVersionId, userId } = {}) {
    const row = (await query(`
      SELECT loop.loop_version_id, loop.workflow_id, loop.workflow_revision_id,
             loop.workflow_revision_content_hash, loop.compile_result_id,
             loop.execution_plan_id, loop.content_hash AS loop_version_content_hash,
             plan.content_hash AS execution_plan_content_hash,
             workflow.owner_user_id, workflow.scope_id, workflow.status,
             workflow.lifecycle, workflow.visibility, loop.pins_finalized
        FROM public.loop_versions loop
        JOIN public.workflows workflow
          ON workflow.workspace_id = loop.workspace_id
         AND workflow.workflow_id = loop.workflow_id
        JOIN public.execution_plans plan
          ON plan.workspace_id = loop.workspace_id
         AND plan.plan_id = loop.execution_plan_id
         AND plan.compile_result_id = loop.compile_result_id
         AND plan.workflow_id = loop.workflow_id
         AND plan.workflow_revision_id = loop.workflow_revision_id
         AND plan.pins_finalized
       WHERE loop.workspace_id = $1 AND loop.loop_version_id = $2
         AND loop.pins_finalized
       FOR SHARE OF loop, workflow, plan
    `, [workspaceId, loopVersionId])).rows[0];
    if (!row
      || row.scope_id !== scopeId
      || row.owner_user_id !== userId
      || row.status !== "ready"
      || !["ready", "shared"].includes(row.lifecycle)
      || !["private", "workspace"].includes(row.visibility)) {
      throw coded("automation_loop_not_available");
    }
    return row;
  }

  async #resolveAutomationPins(query, {
    workspaceId,
    scopeId,
    loop,
    inputBindings,
    connectionBindings,
  }) {
    const resourceRows = (await query(`
      SELECT pin.resource_id, pin.resource_version, pin.content_hash, resource.label
        FROM public.loop_version_resource_pins pin
        JOIN public.workspace_resources resource
          ON resource.workspace_id = pin.workspace_id
         AND resource.resource_id = pin.resource_id
         AND resource.resource_version = pin.resource_version
         AND resource.content_hash = pin.content_hash
         AND resource.readiness_status = 'ready'
       WHERE pin.workspace_id = $1 AND pin.loop_version_id = $2
       ORDER BY pin.resource_id, pin.resource_version, pin.content_hash
       FOR SHARE OF pin, resource
    `, [workspaceId, loop.loop_version_id])).rows;
    const resourcePins = normalizeResourcePins({ expected: resourceRows, inputBindings });

    const requirementRows = (await query(`
      SELECT requirement_id, capability_key, required_effects
        FROM public.loop_version_connection_requirements
       WHERE workspace_id = $1 AND loop_version_id = $2
       ORDER BY requirement_id
       FOR SHARE
    `, [workspaceId, loop.loop_version_id])).rows;
    const requestedConnections = normalizeConnectionSelections({ expected: requirementRows, connectionBindings });
    const connectionPins = [];
    for (const requested of requestedConnections) {
      const row = (await query(`
        SELECT requirement.requirement_id, requirement.capability_key, requirement.required_effects,
               connection.connection_id, connection.scope_id, connection.enabled,
               connection.current_revision_id, connection.current_revision_number,
               revision.connection_revision_id, revision.revision_number,
               revision.driver_backend, revision.credential_state,
               revision.readiness_status, revision.validation_status,
               revision.validation_checked_at, revision.validation_expires_at,
               revision.secret_binding_id, revision.credential_binding_fingerprint,
               binding.secret_source, binding.store_binding_ref, binding.store_binding_revision,
               binding.credential_fingerprint, binding.status AS binding_status,
               binding.probed_at, binding.expires_at AS binding_expires_at
          FROM public.loop_version_connection_requirements requirement
          JOIN public.workspace_connections connection
            ON connection.workspace_id = requirement.workspace_id
           AND connection.connection_id = $3
          JOIN public.workspace_connection_revisions revision
            ON revision.workspace_id = connection.workspace_id
           AND revision.connection_id = connection.connection_id
           AND revision.connection_revision_id = connection.current_revision_id
           AND revision.revision_number = connection.current_revision_number
          JOIN public.secret_bindings binding
            ON binding.workspace_id = revision.workspace_id
           AND binding.secret_binding_id = revision.secret_binding_id
         WHERE requirement.workspace_id = $1
           AND requirement.loop_version_id = $2
           AND requirement.requirement_id = $4
           AND connection.scope_id = $5
           AND connection.enabled
           AND revision.driver_backend = 'production'
           AND revision.credential_state = 'bound'
           AND revision.readiness_status = 'connected'
           AND revision.validation_status = 'valid'
           AND revision.validation_effects @> requirement.required_effects
           AND revision.validation_checked_at <= clock_timestamp()
           AND (revision.validation_expires_at IS NULL OR revision.validation_expires_at > clock_timestamp())
           AND binding.secret_source = 'cloud_secret_store'
           AND binding.status = 'active'
           AND binding.probed_at <= clock_timestamp()
           AND (binding.expires_at IS NULL OR binding.expires_at > clock_timestamp())
         FOR SHARE OF requirement, connection, revision, binding
      `, [workspaceId, loop.loop_version_id, requested.connectionId, requested.requirementId, scopeId])).rows[0];
      if (!row) throw coded("automation_connection_not_consumable");
      connectionPins.push({
        requirementId: row.requirement_id,
        capabilityKey: row.capability_key,
        requiredEffects: structuredClone(row.required_effects),
        connectionId: row.connection_id,
        connectionRevisionId: row.connection_revision_id,
        connectionRevisionNumber: Number(row.revision_number),
        secretBindingId: row.secret_binding_id,
        secretSource: row.secret_source,
        storeBindingRef: row.store_binding_ref,
        storeBindingRevision: Number(row.store_binding_revision),
        credentialFingerprint: row.credential_fingerprint,
      });
    }
    return { resourcePins, connectionPins };
  }

  async #loadModelPolicy(query, { workspaceId, scopeId, planId } = {}) {
    const policy = (await query(`
      SELECT * FROM public.workspace_model_policy_revisions
       WHERE workspace_id = $1 AND scope_id = $2
       ORDER BY revision DESC, created_at DESC, policy_revision_id DESC
       LIMIT 1 FOR SHARE
    `, [workspaceId, scopeId])).rows[0];
    if (!policy) throw coded("automation_model_policy_unavailable");
    const planPins = (await query(`
      SELECT model_profile_revision_id
        FROM public.execution_plan_model_pins
       WHERE workspace_id = $1 AND plan_id = $2
       ORDER BY model_profile_revision_id
       FOR SHARE
    `, [workspaceId, planId])).rows.map((row) => row.model_profile_revision_id);
    const selected = new Set(Object.values(policy.capability_model_revision_ids ?? {}));
    if (planPins.some((revisionId) => !selected.has(revisionId))) {
      throw coded("automation_model_policy_pin_mismatch");
    }
    return { ...policy, planModelRevisionIds: planPins };
  }

  async #issueAutomationScopeGrant(query, {
    authority,
    userId,
    principalId,
    grantId,
    now,
  }) {
    const targetContract = {
      scopeId: authority.scope_id,
      grantId,
      subjectPrincipalId: principalId,
      subjectPrincipalKind: "automation",
      accessKind: "operation",
      capabilities: ["object.execute"],
      canApprove: false,
      grantorPrincipalId: userId,
      grantorPrincipalKind: "user",
      issuanceKind: "command",
      status: "active",
    };
    const authorization = await this.#authorizeExplicit(query, {
      authority, userId, actionId: "scope_principal_grant_issue",
      effectClass: "administrative", intent: targetContract, targetContract, now,
    });
    const commandId = newId(this.#idFactory, "product-command");
    await this.#insertCommand(query, {
      commandId, authority, userId, actionId: "scope_principal_grant_issue",
      effectClass: "administrative", authorization, targetKind: "scope_principal_grant",
      targetId: grantId, targetRevision: 1, targetContract, now,
    });
    await query(`
      INSERT INTO public.scope_principal_grants (
        workspace_id, scope_id, grant_id, principal_id, principal_kind,
        access_kind, capabilities, can_approve,
        granted_by_principal_id, granted_by_principal_kind, issuance_kind,
        issuance_authority_scope_id, issuance_command_id,
        issuance_authorization_decision_id, issuance_argument_digest,
        status, revision, created_at, updated_at, payload
      ) VALUES ($1, $2, $3, $4, 'automation',
        'operation', ARRAY['object.execute']::text[], false,
        $5, 'user', 'command',
        $2, $6, $7, $8,
        'active', 1, $9::timestamptz, $9::timestamptz, '{}'::jsonb)
    `, [
      authority.workspace_id, authority.scope_id, grantId, principalId,
      userId, commandId, authorization.authorizationDecisionId,
      authorization.argumentDigest, now,
    ]);
  }

  async #issueAutomationPolicyGrant(query, {
    authority,
    userId,
    automationId,
    principalId,
    subjectScopeGrantId,
    policyGrantId,
    expiresAt,
    reviewAt,
    now,
  }) {
    const expiresAtContract = formatUtcMicroseconds(expiresAt);
    const reviewAtContract = reviewAt === null ? null : formatUtcMicroseconds(reviewAt);
    const targetContract = {
      scopeId: authority.scope_id,
      policyGrantId,
      subjectPrincipalId: principalId,
      subjectPrincipalKind: "automation",
      subjectScopeGrantId,
      policyRevisionId: authority.current_policy_revision_id,
      authorizerPrincipalId: userId,
      authorizerPrincipalKind: "user",
      authorizerScopeGrantId: authority.grant_id,
      expiresAt: expiresAtContract,
      reviewAt: reviewAtContract,
      status: "active",
    };
    const authorization = await this.#authorizeExplicit(query, {
      authority, userId, actionId: "policy_grant_issue",
      effectClass: "administrative", intent: {
        automationId, ...targetContract,
      }, targetContract, now,
    });
    const commandId = newId(this.#idFactory, "product-command");
    await this.#insertCommand(query, {
      commandId, authority, userId, actionId: "policy_grant_issue",
      effectClass: "administrative", authorization, targetKind: "policy_grant",
      targetId: policyGrantId, targetRevision: 1, targetContract, now,
    });
    await query(`
      INSERT INTO public.policy_grants (
        workspace_id, scope_id, policy_grant_id,
        subject_principal_id, subject_principal_kind, subject_scope_grant_id,
        policy_revision_id, authorized_by_principal_id, authorized_by_principal_kind,
        authorizer_scope_grant_id, issuance_command_id,
        issuance_authorization_decision_id, issuance_argument_digest,
        status, revision, expires_at, review_at, created_at, updated_at, revoked_at, payload
      ) VALUES ($1, $2, $3,
        $4, 'automation', $5,
        $6, $7, 'user',
        $8, $9, $10, $11,
        'active', 1, $12::timestamptz, $13::timestamptz,
        $14::timestamptz, $14::timestamptz, NULL, '{}'::jsonb)
    `, [
      authority.workspace_id, authority.scope_id, policyGrantId,
      principalId, subjectScopeGrantId, authority.current_policy_revision_id,
      userId, authority.grant_id, commandId, authorization.authorizationDecisionId,
      authorization.argumentDigest, expiresAt, reviewAt, now,
    ]);
    return { policyGrantId, revision: 1, expiresAt, reviewAt };
  }

  async #revokeAutomationPolicyGrant(query, { workspaceId, policyGrantId, now }) {
    const revoked = (await query(`
      UPDATE public.policy_grants
         SET status = 'revoked', revision = revision + 1,
             revoked_at = $3::timestamptz, updated_at = $3::timestamptz
       WHERE workspace_id = $1 AND policy_grant_id = $2
         AND status = 'active'
       RETURNING policy_grant_id
    `, [workspaceId, policyGrantId, now])).rows[0];
    if (!revoked) throw coded("automation_grant_not_found");
  }

  async #authorizeExplicit(query, {
    authority,
    userId,
    actionId,
    effectClass,
    intent,
    targetContract = null,
    now,
  }) {
    const argumentDigest = canonicalRequestHash(intent);
    const approvalId = newId(this.#idFactory, "authorization-approval");
    const authorizationDecisionId = newId(this.#idFactory, "authorization-decision");
    const expiresAt = new Date(Date.parse(now) + 5 * 60_000).toISOString();
    const target = targetContract === null ? null : JSON.stringify(targetContract);
    const shared = [
      authority.workspace_id, authority.scope_id, authority.current_policy_revision_id,
      userId, authority.grant_id, actionId, effectClass, argumentDigest, target,
      authority.permission_mode, authority.auto_approved_effect_classes,
      authority.auto_approved_action_ids, now, expiresAt,
    ];
    await query(`
      INSERT INTO public.authorization_decisions (
        workspace_id, authorization_decision_id, scope_id, policy_revision_id,
        actor_principal_id, actor_principal_kind, actor_scope_grant_id,
        effective_principal_id, effective_principal_kind, effective_scope_grant_id,
        authorization_source, authorizer_principal_id, authorizer_principal_kind,
        authorizer_scope_grant_id, action_id, effect_class, argument_digest, target_contract,
        permission_mode, auto_approved_effect_classes, auto_approved_action_ids,
        destructive_rule_version, disposition, approval_id, reason_code,
        decided_at, expires_at, payload
      ) VALUES (
        $1, $2, $3, $4,
        $5, 'user', $6, $5, 'user', $6,
        'principal', $5, 'user', $6, $7, $8, $9, $10::jsonb,
        $11, $12::text[], $13::text[],
        'authority-v1', 'approval_required', $2, 'explicit_owner_governance',
        $14::timestamptz, $15::timestamptz, '{"issuer":"automation_lifecycle"}'::jsonb
      )
    `, [authority.workspace_id, approvalId, ...shared.slice(1)]);
    await query(`
      INSERT INTO public.authorization_decisions (
        workspace_id, authorization_decision_id, scope_id, policy_revision_id,
        actor_principal_id, actor_principal_kind, actor_scope_grant_id,
        effective_principal_id, effective_principal_kind, effective_scope_grant_id,
        authorization_source, authorizer_principal_id, authorizer_principal_kind,
        authorizer_scope_grant_id, action_id, effect_class, argument_digest, target_contract,
        permission_mode, auto_approved_effect_classes, auto_approved_action_ids,
        destructive_rule_version, disposition, approval_id, reason_code,
        decided_at, expires_at, payload
      ) VALUES (
        $1, $2, $3, $4,
        $5, 'user', $6, $5, 'user', $6,
        'principal', $5, 'user', $6, $7, $8, $9, $10::jsonb,
        $11, $12::text[], $13::text[],
        'authority-v1', 'authorized', $14, 'explicit_owner_governance',
        $15::timestamptz, $16::timestamptz, '{"issuer":"automation_lifecycle"}'::jsonb
      )
    `, [
      authority.workspace_id, authorizationDecisionId,
      ...shared.slice(1, -2), approvalId, now, expiresAt,
    ]);
    return { authorizationDecisionId, argumentDigest, authorizedAt: now };
  }

  async #insertCommand(query, {
    commandId,
    authority,
    userId,
    actionId,
    effectClass,
    authorization,
    targetKind,
    targetId,
    targetRevision,
    targetContract = null,
    now,
  }) {
    await query(`
      INSERT INTO public.product_commands (
        command_id, workspace_id, scope_id,
        actor_principal_id, actor_principal_kind,
        effective_principal_id, effective_principal_kind,
        authorization_decision_id, policy_revision_id,
        effect_class, argument_digest, target_contract, quota_user_id,
        schema_version, kind, target_kind, target_id, target_revision,
        status, created_at, updated_at, finished_at, payload
      ) VALUES ($1, $2, $3,
        $4, 'user', $4, 'user',
        $5, $6,
        $7, $8, $9::jsonb, $4,
        'workbench-v1', $10, $11, $12, $13,
        'completed', $14::timestamptz, $14::timestamptz, $14::timestamptz, '{}'::jsonb)
    `, [
      commandId, authority.workspace_id, authority.scope_id, userId,
      authorization.authorizationDecisionId, authority.current_policy_revision_id,
      effectClass, authorization.argumentDigest,
      targetContract === null ? null : JSON.stringify(targetContract),
      actionId, targetKind, targetId, targetRevision, now,
    ]);
  }

  async #loadAutomationRowForUpdate(query, {
    workspaceId,
    automationId,
    context,
    lock = true,
  }) {
    const row = (await query(`
      SELECT root.*, revision.scope_policy_revision_id, revision.policy_grant_id,
             policy_grant.subject_scope_grant_id AS automation_scope_grant_id
        FROM public.automations root
        JOIN public.automation_revisions revision
          ON revision.workspace_id = root.workspace_id
         AND revision.automation_revision_id = root.current_revision_id
        JOIN public.policy_grants policy_grant
          ON policy_grant.workspace_id = revision.workspace_id
         AND policy_grant.policy_grant_id = revision.policy_grant_id
       WHERE root.workspace_id = $1 AND root.automation_id = $2
       ${lock ? "FOR UPDATE OF root, revision, policy_grant" : ""}
    `, [workspaceId, automationId])).rows[0];
    if (!row || !canManageAutomation(row, context)) throw coded("automation_not_found");
    return row;
  }

  async #loadAutomation(query, { workspaceId, automationId, context } = {}) {
    const root = await this.#loadAutomationRowForUpdate(query, {
      workspaceId, automationId, context, lock: false,
    });
    const revision = (await query(`
      SELECT revision.*, policy.permission_mode, policy.auto_approved_effect_classes,
             policy.auto_approved_action_ids, policy_grant.revision AS policy_grant_revision,
             policy_grant.expires_at, policy_grant.review_at,
             (SELECT run.status
                FROM public.automation_occurrences occurrence
                JOIN public.workflow_runs run
                  ON run.workspace_id = occurrence.workspace_id
                 AND run.run_id = occurrence.run_id
               WHERE occurrence.workspace_id = revision.workspace_id
                 AND occurrence.automation_id = revision.automation_id
                 AND occurrence.status = 'accepted'
               ORDER BY occurrence.accepted_at DESC, occurrence.occurrence_id DESC
               LIMIT 1) AS last_outcome
        FROM public.automation_revisions revision
        JOIN public.scope_policy_revisions policy
          ON policy.workspace_id = revision.workspace_id
         AND policy.scope_id = revision.scope_id
         AND policy.policy_revision_id = revision.scope_policy_revision_id
        JOIN public.policy_grants policy_grant
          ON policy_grant.workspace_id = revision.workspace_id
         AND policy_grant.policy_grant_id = revision.policy_grant_id
       WHERE revision.workspace_id = $1
         AND revision.automation_revision_id = $2
    `, [workspaceId, root.current_revision_id])).rows[0];
    if (!revision) throw coded("automation_projection_incomplete");
    const resourcePins = (await query(`
      SELECT input_pin_id, input_name, resource_id, resource_version, resource_content_hash
        FROM public.automation_input_pins
       WHERE workspace_id = $1 AND automation_revision_id = $2
       ORDER BY input_name ASC, input_pin_id ASC
    `, [workspaceId, revision.automation_revision_id])).rows;
    const connectionPins = (await query(`
      SELECT requirement_id, connection_id, connection_revision_number,
             secret_binding_id, store_binding_revision
        FROM public.automation_connection_pins
       WHERE workspace_id = $1 AND automation_revision_id = $2
       ORDER BY requirement_id ASC
    `, [workspaceId, revision.automation_revision_id])).rows;
    return automationView({ root, revision, resourcePins, connectionPins });
  }

  async #loadCandidate(query, { workspaceId, loopVersionId, row } = {}) {
    const [resourcePins, connectionRequirements] = await Promise.all([
      query(`
        SELECT pin.resource_id, pin.resource_version, pin.content_hash, resource.label
          FROM public.loop_version_resource_pins pin
          JOIN public.workspace_resources resource
            ON resource.workspace_id = pin.workspace_id
           AND resource.resource_id = pin.resource_id
           AND resource.resource_version = pin.resource_version
           AND resource.content_hash = pin.content_hash
           AND resource.readiness_status = 'ready'
         WHERE pin.workspace_id = $1 AND pin.loop_version_id = $2
         ORDER BY resource.label ASC, pin.resource_id ASC
      `, [workspaceId, loopVersionId]),
      query(`
        SELECT requirement_id, capability_key, description, required_effects
          FROM public.loop_version_connection_requirements
         WHERE workspace_id = $1 AND loop_version_id = $2
         ORDER BY requirement_id ASC
      `, [workspaceId, loopVersionId]),
    ]);
    const eligibleConnectionRows = await query(`
      SELECT requirement.requirement_id, connection.connection_id
        FROM public.loop_version_connection_requirements requirement
        JOIN public.workspace_connections connection
          ON connection.workspace_id = requirement.workspace_id
         AND connection.scope_id = $3
         AND connection.enabled
        JOIN public.workspace_connection_revisions revision
          ON revision.workspace_id = connection.workspace_id
         AND revision.connection_id = connection.connection_id
         AND revision.connection_revision_id = connection.current_revision_id
         AND revision.revision_number = connection.current_revision_number
        JOIN public.secret_bindings binding
          ON binding.workspace_id = revision.workspace_id
         AND binding.secret_binding_id = revision.secret_binding_id
       WHERE requirement.workspace_id = $1
         AND requirement.loop_version_id = $2
         AND revision.driver_backend = 'production'
         AND revision.credential_state = 'bound'
         AND revision.readiness_status = 'connected'
         AND revision.validation_status = 'valid'
         AND revision.validation_effects @> requirement.required_effects
         AND revision.validation_checked_at <= clock_timestamp()
         AND (revision.validation_expires_at IS NULL OR revision.validation_expires_at > clock_timestamp())
         AND binding.secret_source = 'cloud_secret_store'
         AND binding.status = 'active'
         AND binding.probed_at <= clock_timestamp()
         AND (binding.expires_at IS NULL OR binding.expires_at > clock_timestamp())
       ORDER BY requirement.requirement_id ASC, connection.connection_id ASC
    `, [workspaceId, loopVersionId, row.scope_id]);
    const eligibleConnectionIds = new Map();
    for (const candidate of eligibleConnectionRows.rows) {
      const values = eligibleConnectionIds.get(candidate.requirement_id) ?? [];
      values.push(candidate.connection_id);
      eligibleConnectionIds.set(candidate.requirement_id, values);
    }
    return {
      loopVersionId,
      workflowId: row.workflow_id,
      scopeId: row.scope_id,
      name: row.name,
      description: row.description ?? "",
      version: row.version,
      inputBindings: resourcePins.rows.map((pin) => ({
        bindingId: `resource-${pin.resource_id}-${pin.resource_version}`,
        inputKey: pin.resource_id,
        label: pin.label,
        source: {
          kind: "resource",
          resourceId: pin.resource_id,
          version: pin.resource_version,
          contentHash: pin.content_hash,
        },
      })),
      connectionRequirements: connectionRequirements.rows.map((requirement) => ({
        requirementId: requirement.requirement_id,
        capabilityKey: requirement.capability_key,
        description: requirement.description,
        requiredEffects: structuredClone(requirement.required_effects ?? []),
        eligibleConnectionIds: eligibleConnectionIds.get(requirement.requirement_id) ?? [],
      })),
    };
  }

  async #nextScheduledForCurrentAutomation(query, automationRevisionId, now) {
    const row = (await query(`
      SELECT cron_expression, timezone_name
        FROM public.automation_revisions
       WHERE automation_revision_id = $1
       FOR SHARE
    `, [automationRevisionId])).rows[0];
    if (!row) throw coded("automation_revision_not_found");
    return this.#nextScheduledAt(query, {
      kind: "daily_cron", expression: row.cron_expression, timezone: row.timezone_name,
    }, now);
  }

  async #nextScheduledAt(query, trigger, now) {
    const [minute, hour] = String(trigger.expression).split(" ").map(Number);
    const row = (await query(`
      SELECT CASE
        WHEN ($1::timestamptz AT TIME ZONE $2)::time >= make_time($3, $4, 0)
          THEN (((($1::timestamptz AT TIME ZONE $2)::date + 1)::timestamp)
            + make_interval(hours => $3, mins => $4)) AT TIME ZONE $2
        ELSE ((($1::timestamptz AT TIME ZONE $2)::date)::timestamp
            + make_interval(hours => $3, mins => $4)) AT TIME ZONE $2
      END AS next_scheduled_at
    `, [now, trigger.timezone, hour, minute])).rows[0];
    const value = timestamp(row?.next_scheduled_at);
    if (!value) throw coded("automation_schedule_invalid");
    return value;
  }

  async #databaseNow(query) {
    return timestamp((await query("SELECT clock_timestamp() AS now")).rows[0]?.now ?? this.#clock());
  }

  async #withReceipt({ workspaceId, userId, scope, key, request }, mutation) {
    return this.#transaction(async (query) => {
      const requestHash = canonicalRequestHash(request);
      const existing = (await query(`
        SELECT request_hash, response
          FROM public.product_idempotency_receipts
         WHERE workspace_id = $1 AND effective_principal_id = $2
           AND operation_scope = $3 AND idempotency_key = $4
         FOR UPDATE
      `, [workspaceId, userId, scope, key])).rows[0];
      if (existing) {
        if (existing.request_hash !== requestHash) throw coded("idempotency_key_reused");
        if (existing.response === null) throw coded("idempotency_record_incomplete");
        return structuredClone(existing.response);
      }
      const now = await this.#databaseNow(query);
      await query(`
        INSERT INTO public.product_idempotency_receipts (
          workspace_id, effective_principal_id, operation_scope, idempotency_key,
          request_hash, response, created_at, completed_at
        ) VALUES ($1, $2, $3, $4, $5, NULL, $6::timestamptz, NULL)
      `, [workspaceId, userId, scope, key, requestHash, now]);
      const response = await mutation(query);
      await query(`
        UPDATE public.product_idempotency_receipts
           SET response = $5::jsonb, completed_at = $6::timestamptz
         WHERE workspace_id = $1 AND effective_principal_id = $2
           AND operation_scope = $3 AND idempotency_key = $4
      `, [workspaceId, userId, scope, key, JSON.stringify(response), now]);
      return structuredClone(response);
    });
  }

  #transaction(work) {
    return this.#store.withTransaction((uow) => work(
      (text, values = []) => this.#sql.query(uow, text, values),
    ));
  }
}

function normalizeScopePolicyRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !OBSERVATION_TIERS.has(value.observationTier)) {
    throw coded("scope_policy_request_invalid");
  }
  return {
    observationTier: value.observationTier,
    defaultPermission: normalizePermission(value.defaultPermission),
  };
}

function normalizeAutomationCreateRequest(value) {
  const input = normalizeAutomationInput(value, { requireScope: true });
  return input;
}

function normalizeAutomationRevisionRequest(value) {
  return normalizeAutomationInput(value, { requireScope: false });
}

function normalizeAutomationInput(value, { requireScope }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw coded("automation_request_invalid");
  const expected = new Set([
    "displayName", "scopeId", "loopVersionId", "trigger", "inputBindings", "connectionBindings",
    "budgetPolicy", "misfirePolicy", "grantExpiresAt", "grantReviewAt",
  ]);
  if (Object.keys(value).some((key) => !expected.has(key))) throw coded("automation_request_invalid");
  if (requireScope) assertId(value.scopeId, "automation_scope_required");
  if (!requireScope && value.scopeId !== undefined) throw coded("automation_scope_immutable");
  const displayName = String(value.displayName ?? "").trim();
  if (displayName.length < 1 || displayName.length > 200) throw coded("automation_display_name_invalid");
  assertId(value.loopVersionId, "automation_loop_version_required");
  const trigger = normalizeTrigger(value.trigger);
  const inputBindings = normalizeInputBindings(value.inputBindings);
  const connectionBindings = normalizeConnectionBindings(value.connectionBindings);
  const budgetPolicy = normalizeBudget(value.budgetPolicy);
  const misfirePolicy = normalizeMisfire(value.misfirePolicy);
  const grantExpiresAt = timestamp(value.grantExpiresAt);
  if (!grantExpiresAt) throw coded("automation_grant_expiry_invalid");
  const grantReviewAt = value.grantReviewAt === undefined || value.grantReviewAt === null
    ? null : timestamp(value.grantReviewAt);
  if (value.grantReviewAt !== undefined && value.grantReviewAt !== null && !grantReviewAt) {
    throw coded("automation_grant_review_invalid");
  }
  return {
    ...(requireScope ? { scopeId: value.scopeId } : {}),
    displayName, loopVersionId: value.loopVersionId, trigger,
    inputBindings, connectionBindings, budgetPolicy, misfirePolicy,
    grantExpiresAt, grantReviewAt,
  };
}

function normalizePermission(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw coded("scope_permission_invalid");
  const mode = value.mode;
  if (["discuss", "plan", "interactive"].includes(mode)
    && Object.keys(value).length === 1) return { mode };
  if (mode === "auto" && Array.isArray(value.autoApprovedEffectClasses)
    && Object.keys(value).length === 2) {
    const effects = sortedUnique(value.autoApprovedEffectClasses);
    if (effects.length < 1 || effects.length > EFFECTS.size || effects.some((item) => !EFFECTS.has(item))) {
      throw coded("scope_permission_invalid");
    }
    return { mode, autoApprovedEffectClasses: effects };
  }
  if (mode === "custom" && Array.isArray(value.autoApprovedActionIds)
    && Object.keys(value).length === 2) {
    const actions = sortedUnique(value.autoApprovedActionIds);
    if (actions.length < 1 || actions.length > 128 || actions.some((item) => !ID.test(item))) {
      throw coded("scope_permission_invalid");
    }
    return { mode, autoApprovedActionIds: actions };
  }
  throw coded("scope_permission_invalid");
}

function normalizeTrigger(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "expression,kind,timezone"
    || value.kind !== "daily_cron"
    || typeof value.expression !== "string"
    || !/^(?:[0-9]|[0-5][0-9]) (?:[0-9]|[01][0-9]|2[0-3]) \* \* \*$/.test(value.expression)
    || typeof value.timezone !== "string"
    || !/^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+)$/.test(value.timezone)) {
    throw coded("automation_trigger_invalid");
  }
  return { kind: "daily_cron", expression: value.expression, timezone: value.timezone };
}

function normalizeInputBindings(value) {
  if (!Array.isArray(value) || value.length > 128) throw coded("automation_input_bindings_invalid");
  const seenIds = new Set(); const seenKeys = new Set();
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)
      || Object.keys(item).sort().join(",") !== "bindingId,inputKey,source"
      || !ID.test(item.bindingId) || !ID.test(item.inputKey)
      || seenIds.has(item.bindingId) || seenKeys.has(item.inputKey)) {
      throw coded("automation_input_bindings_invalid");
    }
    seenIds.add(item.bindingId); seenKeys.add(item.inputKey);
    const source = item.source;
    if (!source || typeof source !== "object" || Array.isArray(source)
      || Object.keys(source).sort().join(",") !== "contentHash,kind,resourceId,version"
      || source.kind !== "resource" || !ID.test(source.resourceId)
      || typeof source.version !== "string" || source.version.length < 1 || source.version.length > 64
      || !isHash(source.contentHash)) {
      throw coded("automation_input_bindings_invalid");
    }
    return {
      bindingId: item.bindingId,
      inputKey: item.inputKey,
      source: { kind: "resource", resourceId: source.resourceId, version: source.version, contentHash: source.contentHash },
    };
  });
}

function normalizeConnectionBindings(value) {
  if (!Array.isArray(value) || value.length > 128) throw coded("automation_connection_bindings_invalid");
  const seen = new Set();
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)
      || Object.keys(item).sort().join(",") !== "connectionId,requirementId"
      || !ID.test(item.requirementId) || !ID.test(item.connectionId)
      || seen.has(item.requirementId)) {
      throw coded("automation_connection_bindings_invalid");
    }
    seen.add(item.requirementId);
    return { requirementId: item.requirementId, connectionId: item.connectionId };
  });
}

function normalizeBudget(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "maxCostUsdMicros,maxRuntimeSeconds"
    || !Number.isSafeInteger(value.maxCostUsdMicros)
    || value.maxCostUsdMicros < 0 || value.maxCostUsdMicros > 1_000_000_000_000
    || !Number.isSafeInteger(value.maxRuntimeSeconds)
    || value.maxRuntimeSeconds < 1 || value.maxRuntimeSeconds > 86_400) {
    throw coded("automation_budget_invalid");
  }
  return { maxCostUsdMicros: value.maxCostUsdMicros, maxRuntimeSeconds: value.maxRuntimeSeconds };
}

function normalizeMisfire(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw coded("automation_misfire_invalid");
  if (value.kind === "skip" && value.maxLatenessSeconds === 0 && Object.keys(value).length === 2) {
    return { kind: "skip", maxLatenessSeconds: 0 };
  }
  if (value.kind === "run_once" && Number.isSafeInteger(value.maxLatenessSeconds)
    && value.maxLatenessSeconds >= 1 && value.maxLatenessSeconds <= 86_400
    && Object.keys(value).length === 2) {
    return { kind: "run_once", maxLatenessSeconds: value.maxLatenessSeconds };
  }
  throw coded("automation_misfire_invalid");
}

function normalizeResourcePins({ expected, inputBindings }) {
  const expectedByKey = new Map(expected.map((row) => [resourceKey(row.resource_id, row.resource_version, row.content_hash), row]));
  const requested = new Map();
  for (const binding of inputBindings) {
    const key = resourceKey(binding.source.resourceId, binding.source.version, binding.source.contentHash);
    const expectedPin = expectedByKey.get(key);
    // Loop resource pins do not permit an Automation creator to reinterpret
    // the resource under a different input name. The deterministic candidate
    // mapping is part of the pinned contract and is re-derived here instead
    // of trusting browser-supplied binding labels.
    if (requested.has(key) || !expectedPin
      || binding.bindingId !== resourceBindingId(expectedPin)
      || binding.inputKey !== expectedPin.resource_id) {
      throw coded("automation_resource_pin_mismatch");
    }
    requested.set(key, binding);
  }
  if (expectedByKey.size !== requested.size) throw coded("automation_resource_pin_mismatch");
  return [...requested.values()]
    .sort((left, right) => left.inputKey.localeCompare(right.inputKey) || left.bindingId.localeCompare(right.bindingId))
    .map((binding) => ({
      bindingId: binding.bindingId,
      inputKey: binding.inputKey,
      resourceId: binding.source.resourceId,
      version: binding.source.version,
      contentHash: binding.source.contentHash,
    }));
}

function normalizeConnectionSelections({ expected, connectionBindings }) {
  const expectedIds = new Set(expected.map((row) => row.requirement_id));
  if (expectedIds.size !== connectionBindings.length) throw coded("automation_connection_pin_mismatch");
  const selected = new Map(connectionBindings.map((item) => [item.requirementId, item]));
  if (selected.size !== expectedIds.size || [...expectedIds].some((id) => !selected.has(id))) {
    throw coded("automation_connection_pin_mismatch");
  }
  return [...selected.values()].sort((left, right) => left.requirementId.localeCompare(right.requirementId));
}

function policyFromAuthority(authority) {
  return {
    policyRevisionId: authority.current_policy_revision_id,
    observationTier: authority.observation_tier,
    defaultPermission: permissionView(authority),
  };
}

function scopeView(row) {
  const base = {
    schemaVersion: "workbench-v1",
    scopeId: row.scope_id,
    workspaceId: row.workspace_id,
    policy: policyFromAuthority(row),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
  return row.scope_kind === "personal"
    ? { ...base, kind: "personal", ownerUserId: row.owner_user_id }
    : { ...base, kind: "project", projectId: row.project_id };
}

function automationView({ root, revision, resourcePins, connectionPins }) {
  const value = {
    schemaVersion: "workbench-v1",
    variant: "daily_cron_v1",
    automationId: root.automation_id,
    workspaceId: root.workspace_id,
    scopeId: root.scope_id,
    ownerId: root.owner_user_id,
    displayName: root.display_name,
    loopVersionId: revision.loop_version_id,
    loopContentHash: revision.loop_version_content_hash,
    triggerRevision: Number(revision.trigger_revision),
    trigger: { kind: "daily_cron", expression: revision.cron_expression, timezone: revision.timezone_name },
    inputBindings: resourcePins.map((pin) => ({
      bindingId: pin.input_pin_id,
      inputKey: pin.input_name,
      source: {
        kind: "resource", resourceId: pin.resource_id,
        version: pin.resource_version, contentHash: pin.resource_content_hash,
      },
    })),
    connectionBindings: connectionPins.map((pin) => ({
      requirementId: pin.requirement_id,
      connectionId: pin.connection_id,
      revision: Number(pin.connection_revision_number),
      secretBindingId: pin.secret_binding_id,
      storeBindingRevision: Number(pin.store_binding_revision),
    })),
    executionLocationPolicy: "cloud",
    modelPolicy: {
      policyRevisionId: revision.model_policy_revision_id,
      modelProfileRevisionIds: [...(revision.model_profile_revision_ids ?? [])],
    },
    budgetPolicy: {
      maxCostUsdMicros: Number(revision.max_cost_microunits),
      maxRuntimeSeconds: Number(revision.max_duration_seconds),
    },
    approvalPolicy: {
      policyRevisionId: revision.scope_policy_revision_id,
      permissionMode: permissionView(revision),
    },
    misfirePolicy: revision.misfire_policy === "skip"
      ? { kind: "skip", maxLatenessSeconds: 0 }
      : { kind: "run_once", maxLatenessSeconds: Number(revision.misfire_max_lateness_seconds) },
    dedupePolicy: { kind: "scheduled_occurrence" },
    grantId: revision.policy_grant_id,
    grantRevision: Number(revision.policy_grant_revision),
    grantExpiresAt: timestamp(revision.expires_at),
    grantReviewAt: nullableTimestamp(revision.review_at),
    status: root.status,
    blockedReasonCode: root.status === "blocked" ? "automation_blocked" : null,
    nextRunAt: nullableTimestamp(root.next_scheduled_at),
    lastRunAt: nullableTimestamp(root.last_occurrence_at),
    lastOutcome: publicRunOutcome(revision.last_outcome),
    failureStreak: Number(root.failure_streak),
    revision: Number(root.current_revision_number),
    createdAt: timestamp(root.created_at),
    updatedAt: timestamp(root.updated_at),
  };
  // ETags are HTTP metadata, not a public Automation field.  Keeping the
  // write version non-enumerable lets the application derive an ETag without
  // leaking an undocumented field through the TypeBox contract.
  Object.defineProperty(value, "_etagRevision", {
    value: Number(root.write_version),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return value;
}

function occurrenceView(row) {
  return {
    occurrenceId: row.occurrence_id,
    automationId: row.automation_id,
    workflowId: row.status === "accepted" ? row.workflow_id ?? null : null,
    triggerRevision: Number(row.trigger_revision),
    scheduledFor: timestamp(row.scheduled_for),
    localScheduleDate: String(row.local_schedule_date),
    dedupeKey: `${row.automation_id}:${Number(row.trigger_revision)}:${String(row.local_schedule_date)}`,
    status: row.status,
    commandId: row.product_command_id ?? null,
    runId: row.run_id ?? null,
    runStatus: row.status === "accepted" ? row.run_status ?? null : null,
    reasonCode: row.reason_code ?? null,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}

function automationEtag(value) {
  const revision = value?._etagRevision;
  if (!Number.isInteger(revision) || revision < 1) throw coded("automation_etag_invalid");
  return `"autv1:${value.automationId}:${revision}:${value.revision}"`;
}

function automationRowEtag(row) {
  return `"autv1:${row.automation_id}:${Number(row.write_version)}:${Number(row.current_revision_number)}"`;
}

function scopeEtag(row) {
  return `"scopev1:${row.scope_id}:${Number(row.revision)}:${row.current_policy_revision_id}"`;
}

function permissionView(row) {
  if (row.permission_mode === "auto") {
    return { mode: "auto", autoApprovedEffectClasses: [...(row.auto_approved_effect_classes ?? [])] };
  }
  if (row.permission_mode === "custom") {
    return { mode: "custom", autoApprovedActionIds: [...(row.auto_approved_action_ids ?? [])] };
  }
  return { mode: row.permission_mode };
}

function sameScopePolicy(authority, policy) {
  const current = policyFromAuthority(authority);
  return canonicalRequestHash(current) === canonicalRequestHash({
    policyRevisionId: current.policyRevisionId,
    observationTier: policy.observationTier,
    defaultPermission: policy.defaultPermission,
  });
}

function requireUnattendedPolicy(authority) {
  const allowed = authority.permission_mode === "auto"
    ? (authority.auto_approved_effect_classes ?? []).includes("execute")
    : authority.permission_mode === "custom"
      ? (authority.auto_approved_action_ids ?? []).includes("workflow_run")
      : false;
  if (!allowed) throw coded("automation_scope_policy_unattended_required");
}

function canReadScope(row, context) {
  return row.owner_user_id === context.userId || ["owner", "admin"].includes(context.role);
}

function canManageAutomation(row, context) {
  return row.owner_user_id === context.userId || ["owner", "admin"].includes(context.role);
}

function normalizedFutureTimestamp(value, now, code) {
  const normalized = timestamp(value);
  if (!normalized || Date.parse(normalized) <= Date.parse(now)
    || Date.parse(normalized) > Date.parse(now) + 90 * 24 * 60 * 60_000) {
    throw coded(code);
  }
  return normalized;
}

function normalizedReviewTimestamp(value, now, expiresAt) {
  const normalized = timestamp(value);
  if (!normalized || Date.parse(normalized) < Date.parse(now)
    || Date.parse(normalized) > Date.parse(expiresAt)) {
    throw coded("automation_grant_review_invalid");
  }
  return normalized;
}

function publicRunOutcome(value) {
  return ["completed", "failed", "cancelled", "blocked", "partial", "effect_outcome_unknown"].includes(value)
    ? value : null;
}

function resourceKey(resourceId, version, contentHash) {
  return `${resourceId}\u0000${version}\u0000${contentHash}`;
}
function resourceBindingId(row) { return `resource-${row.resource_id}-${row.resource_version}`; }

function sortedUnique(value) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return [];
  return [...new Set(value)].sort();
}

function isHash(value) { return typeof value === "string" && /^sha256:[a-f0-9]{16,64}$/.test(value); }
function nullableTimestamp(value) { return value == null ? null : timestamp(value); }
function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function formatUtcMicroseconds(value) {
  const iso = timestamp(value);
  if (!iso) throw coded("timestamp_invalid");
  return iso.replace(/\.(\d{3})Z$/, ".$1000Z");
}
function pageLimit(value) {
  const candidate = value === undefined ? 50 : Number(value);
  return Number.isInteger(candidate) && candidate >= 1 && candidate <= MAX_PAGE_SIZE
    ? candidate : 50;
}
function assertContext(value) {
  if (!value || typeof value.workspaceId !== "string" || !value.workspaceId
    || typeof value.userId !== "string" || !value.userId) {
    throw new TypeError("automation_lifecycle_context_required");
  }
}
function assertId(value, code) { if (typeof value !== "string" || !ID.test(value)) throw coded(code); }
function assertIdempotencyKey(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 255) throw coded("idempotency_key_required");
}
function assertEtag(value, code) { if (typeof value !== "string" || !/^"[^\"]+"$/.test(value)) throw coded(code); }
function newId(factory, kind) { const value = factory(kind); assertId(value, `${kind}_id_invalid`); return value; }
function coded(code) { return new ProductStoreError(code, code); }
