import { Check, SubmitWorkItemResultDataSchema, ReviewWorkItemResultDataSchema } from "@looloomi/workbench-contracts";
import { readWorkItemResults } from "./work-result-review.mjs";
import { requireWorkItemReferenceAccess } from "./work-item-reference-access.mjs";
import { revokeMemberAgentRequests } from "../member-agents/revoke-member-agent-requests.mjs";
import { randomUUID } from "node:crypto";

import { canonicalRequestHash } from "../store/serialization.mjs";
import { attachWorkItemRun, listWorkItemRuns, requireWorkItemRunAccess } from "./postgres-work-item-runs.mjs";
import { requireProjectFileAccess, prepareProjectFile, publicProjectFile, commitProjectFileRows, projectFileError } from "./project-files.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const WORKSPACE_MANAGERS = new Set(["owner", "admin"]);
const ACCESS_LEVELS = new Set(["owner", "contribute", "read"]);
const MEMBER_ROLES = new Set([
  "accountable_owner",
  "requestor",
  "assignee",
  "reviewer",
  "participant",
  "watcher",
]);
const WORK_ITEM_STATUSES = new Set([
  "draft",
  "ready",
  "active",
  "waiting_review",
  "completed",
  "blocked",
  "cancelled",
]);
const STATUS_TRANSITIONS = new Map([
  ["draft", new Set(["ready", "cancelled"])],
  ["ready", new Set(["active", "blocked", "cancelled"])],
  ["active", new Set(["waiting_review", "blocked", "cancelled"])],
  ["waiting_review", new Set(["active", "completed", "cancelled"])],
  ["blocked", new Set(["active", "cancelled"])],
  ["completed", new Set(["active"])],
  ["cancelled", new Set()],
]);

/**
 * PostgreSQL owner for the Project-backed Team Work slice.
 *
 * This owner is intentionally narrow: it creates Project + Scope as one
 * aggregate, manages explicit Project membership, and owns direct Team Work
 * Item lifecycle commands. The existing promotion lifecycle stays the sole
 * owner of private-session provenance, handoff derivation, comments,
 * Decisions, continuations, and artifact sharing.
 */
export class PostgresTeamWorkLifecycle {
  #store;
  #sql;
  #promotionLifecycle;
  #clock;
  #idFactory;
  #objectStore;

  constructor({
    store,
    promotionLifecycle,
    clock = () => new Date(),
    idFactory = (kind) => `${kind}-${randomUUID()}`,
    objectStore = null,
  } = {}) {
    if (!store?.bindAdapter || !store?.withTransaction || !store?.connect) {
      throw new TypeError("postgres_team_work_store_required");
    }
    if (!promotionLifecycle
      || typeof promotionLifecycle.promote !== "function"
      || typeof promotionLifecycle.getWorkItem !== "function"
      || typeof promotionLifecycle.listThreadEntries !== "function") {
      throw new TypeError("postgres_team_work_promotion_lifecycle_required");
    }
    if (typeof clock !== "function" || typeof idFactory !== "function") {
      throw new TypeError("postgres_team_work_dependencies_invalid");
    }
    this.#store = store;
    this.#objectStore = objectStore;
    this.#promotionLifecycle = promotionLifecycle;
    this.#clock = clock;
    this.#idFactory = idFactory;
    this.#sql = store.bindAdapter(({ execute }) => Object.freeze({
      query: (uow, text, values = []) => execute(uow, { text, values }),
    }));
  }

  // The proven private-task promotion and continuation paths stay owned by
  // their existing aggregate. This facade is only the application composition
  // boundary, not a duplicate persistence implementation.
  promote(input) { return this.#promotionLifecycle.promote(input); }
  listPromotionParticipants(input) { return this.#promotionLifecycle.listPromotionParticipants(input); }
  async getWorkItem({ workItemId, context, targetWorkItemId, transactionSession = null } = {}) {
    assertContext(context); assertId(workItemId, "work_item_id_required");
    return this.#transaction(async (query,uow)=>{
      if (targetWorkItemId !== undefined) await requireWorkItemReferenceAccess(query, {context,workItemId,targetWorkItemId});
      const row=(await query('SELECT * FROM public.work_items WHERE workspace_id=$1 AND work_item_id=$2 FOR SHARE',[context.workspaceId,workItemId])).rows[0];
      if(!row)return null;
      const detail=await this.#promotionLifecycle.getWorkItem({workItemId,context,transactionSession:uow});
      if(!detail)return null;
      return {data:{...detail,resultReview:await readWorkItemResults(query,context.workspaceId,workItemId)},etag:workItemEtag(row)};
    },transactionSession);
  }

  getThreadEntry(input) { return this.#promotionLifecycle.getThreadEntry(input); }
  listThreadEntries(input) { return this.#promotionLifecycle.listThreadEntries(input); }
  createThreadComment(input) { return this.#promotionLifecycle.createThreadComment(input); }
  requireThreadCommentAccess(input) { return this.#promotionLifecycle.requireThreadCommentAccess(input); }
  recordDecision(input) { return this.#promotionLifecycle.recordDecision(input); }
  createContinuation(input) { return this.#promotionLifecycle.createContinuation(input); }
  createContinuationAgentEntry(input) { return this.#promotionLifecycle.createContinuationAgentEntry(input); }
  revokeAccessGrant(input) { return this.#promotionLifecycle.revokeAccessGrant(input); }
  authorizedArtifactScopes(input) { return this.#promotionLifecycle.authorizedArtifactScopes(input); }

  requireWorkflowRunAccess(input) {
    return this.#transaction((query) => requireWorkItemRunAccess(query, { ...input, write: true }));
  }
  attachWorkflowRun({ transactionSession, ...input }) {
    return this.#transaction((query) => attachWorkItemRun(query, input), transactionSession);
  }
  listWorkflowRuns(input) {
    return this.#transaction((query) => listWorkItemRuns(query, input));
  }

  async listProjects({ context, query = {} } = {}) {
    assertContext(context);
    const limit = pageLimit(query.limit);
    return this.#transaction(async (querySql) => {
      const rows = (await querySql(`
        SELECT project.*
          FROM public.projects project
         WHERE project.workspace_id = $1
           AND ($2::text IS NULL OR project.status = $2)
           AND (
             $3::boolean
             OR EXISTS (
               SELECT 1
                 FROM public.project_memberships membership
                WHERE membership.workspace_id = project.workspace_id
                  AND membership.project_id = project.project_id
                  AND membership.user_id = $4
                  AND membership.status = 'active'
             )
           )
         ORDER BY project.updated_at DESC, project.project_id DESC
         LIMIT $5
      `, [
        context.workspaceId,
        query.status ?? null,
        WORKSPACE_MANAGERS.has(context.role),
        context.userId,
        limit,
      ])).rows;
      const values = [];
      for (const row of rows) {
        values.push(await this.#projectFromRow(querySql, row));
      }
      return values;
    });
  }

  async getProject({ projectId, context } = {}) {
    assertContext(context); assertId(projectId, "project_id_required");
    return this.#transaction(async (query) => {
      const row = await this.#loadProject(query, {
        workspaceId: context.workspaceId,
        projectId,
        context,
        lock: false,
      });
      if (!row) throw coded("project_not_found");
      const data = await this.#projectFromRow(query, row);
      return { data, etag: projectEtag(row) };
    });
  }

  requireProjectCreateAccess({ context, transactionSession = null } = {}) {
    assertContext(context);
    return this.#transaction(query => this.#loadPersonalAuthority(query, {
      workspaceId: context.workspaceId,
      userId: context.userId,
      requireWorkspaceManager: true,
    }), transactionSession);
  }

  async createProject({ request, context, transactionSession = null } = {}) {
    assertContext(context);
    const input = normalizeProjectCreate(request);
    if (!WORKSPACE_MANAGERS.has(context.role)) throw coded("project_create_forbidden");
    return this.#transaction(async (query) => {
      const authority = await this.#loadPersonalAuthority(query, {
        workspaceId: context.workspaceId,
        userId: context.userId,
        requireWorkspaceManager: true,
      });
      const members = await this.#resolveWorkspaceMembers(query, {
        workspaceId: context.workspaceId,
        userIds: input.members.map((member) => member.userId),
      });
      const now = await this.#databaseNow(query);
      const ids = {
        projectId: newId(this.#idFactory, "project"),
        scopeId: newId(this.#idFactory, "scope-project"),
        scopePolicyRevisionId: newId(this.#idFactory, "scope-policy"),
        scopeGrantId: newId(this.#idFactory, "scope-grant"),
        scopeCommandId: newId(this.#idFactory, "product-command"),
        projectCommandId: newId(this.#idFactory, "product-command"),
        projectEventId: newId(this.#idFactory, "project-event"),
      };
      await query("SET CONSTRAINTS ALL DEFERRED");
      await this.#createProjectScope(query, {
        authority,
        userId: context.userId,
        projectId: ids.projectId,
        scopeId: ids.scopeId,
        policyRevisionId: ids.scopePolicyRevisionId,
        grantId: ids.scopeGrantId,
        commandId: ids.scopeCommandId,
        now,
      });
      const projectIntent = {
        projectId: ids.projectId,
        scopeId: ids.scopeId,
        title: input.title,
        objective: input.objective,
        memberUserIds: members.map((member) => member.userId),
      };
      const projectAuthorization = await this.#authorizeExplicit(query, {
        authority,
        userId: context.userId,
        actionId: "project_create",
        effectClass: "administrative",
        intent: projectIntent,
        now,
      });
      await this.#insertCompletedCommand(query, {
        commandId: ids.projectCommandId,
        authority,
        userId: context.userId,
        actionId: "project_create",
        effectClass: "administrative",
        authorization: projectAuthorization,
        targetKind: "project",
        targetId: ids.projectId,
        targetRevision: 1,
        now,
      });
      const root = (await query(`
        INSERT INTO public.projects (
          project_id, workspace_id, scope_id, schema_version, title, objective,
          status, accountable_owner_user_id, creation_command_id, write_version,
          created_at, updated_at, archived_at, payload
        ) VALUES ($1, $2, $3, 'workbench-v1', $4, $5,
          'active', $6, $7, 1, $8::timestamptz, $8::timestamptz, NULL, '{}'::jsonb)
        RETURNING *
      `, [
        ids.projectId,
        context.workspaceId,
        ids.scopeId,
        input.title,
        input.objective,
        context.userId,
        ids.projectCommandId,
        now,
      ])).rows[0];
      await this.#upsertProjectMemberships(query, {
        workspaceId: context.workspaceId,
        projectId: ids.projectId,
        ownerUserId: context.userId,
        members,
        actorUserId: context.userId,
        now,
      });
      await query(`
        INSERT INTO public.project_lifecycle_events (
          workspace_id, event_id, product_command_id, project_id, kind,
          target_revision, status_after, actor_user_id, created_at, payload
        ) VALUES ($1, $2, $3, $4, 'project_create', 1, 'active', $5,
          $6::timestamptz, $7::jsonb)
      `, [
        context.workspaceId,
        ids.projectEventId,
        ids.projectCommandId,
        ids.projectId,
        context.userId,
        now,
        JSON.stringify({ memberCount: members.length + 1 }),
      ]);
      const data = await this.#projectFromRow(query, root);
      return { data, etag: projectEtag(root) };
    }, transactionSession);
  }

  async #fileProject(query, projectId, context, write = false) {
    assertContext(context); assertId(projectId, "project_id_required");
    return requireProjectFileAccess(query, projectId, context, write);
  }

  requireProjectFileWriteAccess({projectId,context,transactionSession=null}) {
    return this.#transaction(query=>this.#fileProject(query,projectId,context,true),transactionSession);
  }

  async listProjectFiles({ projectId, context, query: input = {} }) {
    return this.#transaction(async query => {
      await this.#fileProject(query, projectId, context);
      const limit = Math.min(Math.max(Number(input.limit) || 100, 1), 200);
      const rows = (await query(`SELECT revision.*, head.revision_id AS head_revision_id FROM public.project_file_revisions revision
        JOIN public.project_file_heads head ON head.workspace_id=revision.workspace_id AND head.project_id=revision.project_id AND head.path_key=revision.path_key
        WHERE revision.workspace_id=$1 AND revision.project_id=$2 AND (revision.revision_id=head.revision_id OR (revision.outcome='conflict' AND NOT EXISTS (SELECT 1 FROM public.project_file_conflict_resolutions resolved WHERE resolved.workspace_id=revision.workspace_id AND resolved.conflict_revision_id=revision.revision_id)))
          AND ($3::text IS NULL OR revision.revision_id > $3) ORDER BY revision.revision_id LIMIT $4`, [context.workspaceId, projectId, input.cursor || null, limit + 1])).rows;
      return { data: rows.slice(0, limit).map(row => ({ ...publicProjectFile(row), headRevisionId: row.head_revision_id })),
        page: { hasMore: rows.length > limit, nextCursor: rows.length > limit ? rows[limit - 1].revision_id : null } };
    });
  }

  async readProjectFile({ projectId, revisionId, context }) {
    if (!this.#objectStore) throw projectFileError('project_files_unavailable');
    assertId(revisionId, 'project_file_revision_invalid');
    return this.#transaction(async query => {
      await this.#fileProject(query, projectId, context);
      const row = (await query(`SELECT * FROM public.project_file_revisions WHERE workspace_id=$1 AND project_id=$2 AND revision_id=$3`, [context.workspaceId, projectId, revisionId])).rows[0];
      if (!row) throw projectFileError('project_file_not_found');
      const stored = await this.#objectStore.read({ workspaceId: context.workspaceId, objectId: row.object_id });
      if (stored.object.state !== 'promoted' || stored.object.contentHash !== row.content_hash || stored.bytes.length !== Number(row.byte_length)) throw projectFileError('project_file_integrity_failed');
      return { data: { ...publicProjectFile(row), contentBase64: stored.bytes.toString('base64') } };
    });
  }

  async commitProjectFile({ projectId, request, context, transactionSession = null }) {
    if (!this.#objectStore) throw projectFileError('project_files_unavailable');
    const prepared = prepareProjectFile(request.data);
    return this.#transaction(async query => {
      await this.#fileProject(query, projectId, context, true);
      const authority = await this.#loadPersonalAuthority(query, { workspaceId: context.workspaceId, userId: context.userId, requireWorkspaceManager: false });
      const now = await this.#databaseNow(query);
      const revisionId = newId(this.#idFactory, 'project-file-revision'), commandId = newId(this.#idFactory, 'product-command');
      const authorization = await this.#authorizeExplicit(query, { authority, userId: context.userId, actionId: 'project_file_commit', effectClass: 'write_local',
        intent: { projectId, path: prepared.path, deleted: prepared.deleted, baseRevisionId: prepared.baseRevisionId, contentHash: prepared.contentHash, mediaType: prepared.mediaType, resolvesRevisionIds: prepared.resolvesRevisionIds }, now });
      await this.#insertCompletedCommand(query, { commandId, authority, userId: context.userId, actionId: 'project_file_commit', effectClass: 'write_local', authorization,
        targetKind: 'project_file_revision', targetId: revisionId, targetRevision: 1, now });
      const data = await commitProjectFileRows({ query, objectStore: this.#objectStore, workspaceId: context.workspaceId, projectId, userId: context.userId, prepared, revisionId, commandId, now });
      return { data };
    }, transactionSession);
  }

  requireProjectManageAccess({ projectId, context, transactionSession = null } = {}) {
    assertContext(context); assertId(projectId, "project_id_required");
    return this.#transaction(async query => {
      const authority = await this.#loadPersonalAuthority(query, {
        workspaceId: context.workspaceId, userId: context.userId, requireWorkspaceManager: false,
      });
      const current = { ...context, role: authority.workspace_role };
      const root = await this.#loadProject(query, { workspaceId: context.workspaceId, projectId, context: current, lock: true });
      if (!root) throw coded("project_not_found");
      if (!canManageProject(root, current)) throw coded("project_manage_forbidden");
      return root;
    }, transactionSession);
  }

  async reviseProjectMembers({ projectId, request, ifMatch, context, transactionSession = null } = {}) {
    assertContext(context); assertId(projectId, "project_id_required"); assertEtag(ifMatch, "project_etag_required");
    const input = normalizeProjectMembersRequest(request);
    return this.#transaction(async (query) => {
      const root = await this.#loadProject(query, {
        workspaceId: context.workspaceId,
        projectId,
        context,
        lock: true,
      });
      if (!root) throw coded("project_not_found");
      if (!canManageProject(root, context)) throw coded("project_manage_forbidden");
      if (projectEtag(root) !== ifMatch) throw coded("project_conflict");
      const members = await this.#resolveWorkspaceMembers(query, {
        workspaceId: context.workspaceId,
        userIds: input.members.map((member) => member.userId),
      });
      const authority = await this.#loadPersonalAuthority(query, {
        workspaceId: context.workspaceId,
        userId: context.userId,
        requireWorkspaceManager: false,
      });
      const now = await this.#databaseNow(query);
      const targetRevision = Number(root.write_version) + 1;
      const intent = {
        projectId,
        expectedWriteVersion: Number(root.write_version),
        memberUserIds: members.map((member) => member.userId),
      };
      const authorization = await this.#authorizeExplicit(query, {
        authority,
        userId: context.userId,
        actionId: "project_members_revise",
        effectClass: "administrative",
        intent,
        now,
      });
      const commandId = newId(this.#idFactory, "product-command");
      const eventId = newId(this.#idFactory, "project-event");
      await this.#insertCompletedCommand(query, {
        commandId,
        authority,
        userId: context.userId,
        actionId: "project_members_revise",
        effectClass: "administrative",
        authorization,
        targetKind: "project",
        targetId: projectId,
        targetRevision,
        now,
      });
      await this.#upsertProjectMemberships(query, {
        workspaceId: context.workspaceId,
        projectId,
        ownerUserId: root.accountable_owner_user_id,
        members,
        actorUserId: context.userId,
        now,
      });
      const updated = (await query(`
        UPDATE public.projects
           SET write_version = $3, updated_at = $4::timestamptz
         WHERE workspace_id = $1 AND project_id = $2 AND write_version = $5
         RETURNING *
      `, [
        context.workspaceId,
        projectId,
        targetRevision,
        now,
        Number(root.write_version),
      ])).rows[0];
      if (!updated) throw coded("project_conflict");
      await query(`
        INSERT INTO public.project_lifecycle_events (
          workspace_id, event_id, product_command_id, project_id, kind,
          target_revision, status_after, actor_user_id, created_at, payload
        ) VALUES ($1, $2, $3, $4, 'project_members_revise', $5, 'active',
          $6, $7::timestamptz, $8::jsonb)
      `, [
        context.workspaceId,
        eventId,
        commandId,
        projectId,
        targetRevision,
        context.userId,
        now,
        JSON.stringify({ memberCount: members.length + 1 }),
      ]);
      return { data: await this.#projectFromRow(query, updated), etag: projectEtag(updated) };
    }, transactionSession);
  }

  async listWorkItems({ context, query = {} } = {}) {
    assertContext(context);
    const limit = pageLimit(query.limit);
    if (query.projectId !== undefined) assertId(query.projectId, "project_id_required");
    const ids = await this.#transaction(async (querySql) => {
      const rows = (await querySql(`
        SELECT item.work_item_id
          FROM public.work_items item
          JOIN public.work_item_access_grants grant_row
            ON grant_row.workspace_id = item.workspace_id
           AND grant_row.work_item_id = item.work_item_id
           AND grant_row.user_id = $2
           AND grant_row.status = 'active'
         WHERE item.workspace_id = $1
           AND ($3::public.product_identifier IS NULL OR item.project_id = $3)
           AND ($4::text IS NULL OR item.status = $4)
         ORDER BY item.updated_at DESC, item.work_item_id DESC
         LIMIT $5
      `, [
        context.workspaceId,
        context.userId,
        query.projectId ?? null,
        query.status ?? null,
        limit,
      ])).rows;
      return rows.map((row) => row.work_item_id);
    });
    const values = [];
    for (const workItemId of ids) {
      const detail = await this.#promotionLifecycle.getWorkItem({ workItemId, context });
      if (detail?.workItem) values.push(detail.workItem);
    }
    return values;
  }

  async createTeamWorkItem({ request, context, transactionSession = null } = {}) {
    assertContext(context);
    const input = normalizeTeamWorkItemCreate(request);
    return this.#transaction(async (query, uow) => {
      const setup = await this.#prepareTeamWorkItemCreate(query, { input, context });
      const ids = {
        workItemId: newId(this.#idFactory, "work-item"),
        workThreadId: newId(this.#idFactory, "work-thread"),
        handoffId: newId(this.#idFactory, "handoff-capsule"),
        entryId: newId(this.#idFactory, "work-thread-entry"),
        commandId: newId(this.#idFactory, "product-command"),
        eventId: newId(this.#idFactory, "work-item-event"),
      };
      const { access, authority, now } = setup;
      const intent = {
        workItemId: ids.workItemId,
        projectId: input.projectId,
        title: input.title,
        objective: input.objective,
        summary: input.summary,
        priority: input.priority,
        dueAt: input.dueAt,
        members: access.map(memberIntent),
      };
      const authorization = await this.#authorizeExplicit(query, {
        authority,
        userId: context.userId,
        actionId: "work_item_create",
        effectClass: "write_local",
        intent,
        now,
      });
      await this.#insertCompletedCommand(query, {
        commandId: ids.commandId,
        authority,
        userId: context.userId,
        actionId: "work_item_create",
        effectClass: "write_local",
        authorization,
        targetKind: "work_item",
        targetId: ids.workItemId,
        targetRevision: 1,
        now,
      });
      const root = await this.#insertTeamWorkItemRoot(query, {
        ids,
        input,
        context,
        access,
        now,
      });
      await this.#appendTeamWorkItemCreateAudit(query, {
        ids,
        input,
        context,
        commandId: ids.commandId,
        now,
      });
      const detail = await this.#promotionLifecycle.getWorkItem({
        workItemId: ids.workItemId,
        context,
        transactionSession: uow,
      });
      if (!detail) throw coded("work_item_projection_incomplete");
      return { data: detail.workItem, etag: workItemEtag(root) };
    }, transactionSession);
  }

  /**
   * PRD §8.1's New team Work Item entry.  It deliberately does not compose a
   * public create-Work request with a later continuation/Turn request: the
   * Work root, personal continuation and first Agent Turn are all created in
   * one Product Command transaction and only scheduled after its commit.
   */
  async createTeamWorkItemAgentEntry({ request, context, transactionSession = null } = {}) {
    assertContext(context);
    const entry = normalizeTeamWorkItemAgentEntry(request);
    return this.#transaction(async (query, uow) => {
      const setup = await this.#prepareTeamWorkItemCreate(query, {
        input: entry.workItem,
        context,
      });
      const ids = {
        workItemId: newId(this.#idFactory, "work-item"),
        workThreadId: newId(this.#idFactory, "work-thread"),
        handoffId: newId(this.#idFactory, "handoff-capsule"),
        entryId: newId(this.#idFactory, "work-thread-entry"),
        eventId: newId(this.#idFactory, "work-item-event"),
        continuationId: newId(this.#idFactory, "work-item-continuation"),
        agentSessionId: newId(this.#idFactory, "agent-session"),
        turnId: newId(this.#idFactory, "agent-turn"),
        commandId: newId(this.#idFactory, "product-command"),
      };
      // The only authorizing Product Command is accepted by Agent Command
      // Intake below. Keep the new Work root in this same UoW but postpone
      // its command-bound audit rows until that command exists.
      const root = await this.#insertTeamWorkItemRoot(query, {
        ids,
        input: entry.workItem,
        context,
        access: setup.access,
        now: setup.now,
      });
      const continuation = await this.#promotionLifecycle.createContinuation({
        workItemId: ids.workItemId,
        context,
        continuationId: ids.continuationId,
        agentSessionId: ids.agentSessionId,
        initialTurn: {
          turnId: ids.turnId,
          productCommandId: ids.commandId,
          modelProfileId: entry.modelProfileId,
          workItemTarget: teamWorkItemTarget({
            workItemId: ids.workItemId,
            input: entry.workItem,
            access: setup.access,
          }),
          input: entry.initialTask,
        },
        transactionSession: uow,
      });
      if (!continuation?.initialTurn
        || continuation.initialTurn.productCommandId !== ids.commandId
        || continuation.initialTurn.turnId !== ids.turnId) {
        throw coded("team_work_agent_entry_incomplete");
      }
      await this.#appendTeamWorkItemCreateAudit(query, {
        ids,
        input: entry.workItem,
        context,
        commandId: ids.commandId,
        now: setup.now,
      });
      const detail = await this.#promotionLifecycle.getWorkItem({
        workItemId: ids.workItemId,
        context,
        transactionSession: uow,
      });
      if (!detail) throw coded("work_item_projection_incomplete");
      return {
        data: {
          workItem: detail.workItem,
          continuation: continuationPublic(continuation),
          turn: continuation.initialTurn,
        },
        etag: workItemEtag(root),
      };
    }, transactionSession);
  }

  async #prepareTeamWorkItemCreate(query, { input, context }) {
    let projectMembers = [];
    if (input.projectId !== null) {
      const project = await this.#loadProject(query, {
        workspaceId: context.workspaceId,
        projectId: input.projectId,
        context,
        lock: false,
      });
      if (!project) throw coded("project_not_found");
      const membership = await this.#projectMembership(query, {
        workspaceId: context.workspaceId,
        projectId: input.projectId,
        userId: context.userId,
      });
      if (!membership && !WORKSPACE_MANAGERS.has(context.role)) {
        throw coded("project_access_forbidden");
      }
      projectMembers = await this.#activeProjectMembers(query, {
        workspaceId: context.workspaceId,
        projectId: input.projectId,
      });
    }
    await this.#resolveWorkspaceMembers(query, {
      workspaceId: context.workspaceId,
      userIds: input.members.map((member) => member.userId),
    });
    const authority = await this.#loadPersonalAuthority(query, {
      workspaceId: context.workspaceId,
      userId: context.userId,
      requireWorkspaceManager: false,
    });
    return {
      authority,
      now: await this.#databaseNow(query),
      access: mergeInitialWorkItemMembers({
        ownerUserId: context.userId,
        projectMembers,
        requested: input.members,
      }),
    };
  }

  async #insertTeamWorkItemRoot(query, { ids, input, context, access, now }) {
    const root = (await query(`
        INSERT INTO public.work_items (
          work_item_id, workspace_id, project_id, schema_version, title, objective,
          status, priority, accountable_owner_user_id, requestor_user_id, work_thread_id,
          source_kind, due_at, blocked_reason, next_action, created_by_user_id,
          created_at, updated_at, completed_at, payload, write_version
        ) VALUES ($1, $2, $3, 'workbench-v1', $4, $5,
          'ready', $6, $7, $7, $8,
          'team_work_item', $9::timestamptz, NULL, NULL, $7,
          $10::timestamptz, $10::timestamptz, NULL, '{}'::jsonb, 1)
        RETURNING *
      `, [
        ids.workItemId,
        context.workspaceId,
        input.projectId,
        input.title,
        input.objective,
        input.priority,
        context.userId,
        ids.workThreadId,
        input.dueAt,
        now,
      ])).rows[0];
      await this.#replaceWorkItemMembers(query, {
        workspaceId: context.workspaceId,
        workItemId: ids.workItemId,
        currentOwnerUserId: null,
        nextOwnerUserId: context.userId,
        requestorUserId: context.userId,
        desiredMembers: access,
        actorUserId: context.userId,
        now,
      });
      const capsuleHash = canonicalRequestHash({ handoffId: ids.handoffId, summary: input.summary });
      await query(`
        INSERT INTO public.work_item_handoff_capsules (
          handoff_id, workspace_id, work_item_id, promotion_id, origin_kind,
          summary, content_hash, created_by_user_id, created_at, payload
        ) VALUES ($1, $2, $3, NULL, 'team_work_item', $4, $5,
          $6, $7::timestamptz, '{}'::jsonb)
      `, [
        ids.handoffId,
        context.workspaceId,
        ids.workItemId,
        input.summary,
        capsuleHash,
        context.userId,
        now,
      ]);
    return root;
  }

  async #appendTeamWorkItemCreateAudit(query, { ids, input, context, commandId, now }) {
      const entryHash = canonicalRequestHash({ handoffId: ids.handoffId, summary: input.summary });
      await query(`
        INSERT INTO public.work_thread_entries (
          entry_id, workspace_id, work_item_id, work_thread_id, sequence, entry_kind,
          summary, handoff_id, decision_id, artifact_id, content_hash,
          created_by_user_id, occurred_at, product_command_id, payload
        ) VALUES ($1, $2, $3, $4, 1, 'handoff',
          $5, $6, NULL, NULL, $7, $8, $9::timestamptz, $10, '{}'::jsonb)
      `, [
        ids.entryId,
        context.workspaceId,
        ids.workItemId,
        ids.workThreadId,
        input.summary,
        ids.handoffId,
        entryHash,
        context.userId,
        now,
        commandId,
      ]);
      await query(`
        INSERT INTO public.work_item_lifecycle_events (
          workspace_id, event_id, product_command_id, work_item_id, kind,
          target_revision, status_after, accountable_owner_user_id, actor_user_id,
          created_at, payload
        ) VALUES ($1, $2, $3, $4, 'work_item_create', 1, 'ready', $5, $6,
          $7::timestamptz, $8::jsonb)
      `, [
        context.workspaceId,
        ids.eventId,
        commandId,
        ids.workItemId,
        context.userId,
        context.userId,
        now,
        JSON.stringify({ projectId: input.projectId }),
      ]);
  }

  async updateTeamWorkItem({ workItemId, request, ifMatch, context, transactionSession = null } = {}) {
    assertContext(context); assertId(workItemId, "work_item_id_required"); assertEtag(ifMatch, "work_item_etag_required");
    const input = normalizeTeamWorkItemUpdate(request);
    return this.#transaction(async (query, uow) => {
      const root = (await query(`
        SELECT item.*, grant_row.access_level AS actor_access
          FROM public.work_items item
          LEFT JOIN public.work_item_access_grants grant_row
            ON grant_row.workspace_id = item.workspace_id
           AND grant_row.work_item_id = item.work_item_id
           AND grant_row.user_id = $3
           AND grant_row.status = 'active'
         WHERE item.workspace_id = $1 AND item.work_item_id = $2
         FOR UPDATE OF item
      `, [context.workspaceId, workItemId, context.userId])).rows[0];
      if (!root || (!root.actor_access && !WORKSPACE_MANAGERS.has(context.role))) {
        throw coded("work_item_not_found");
      }
      if (root.source_kind !== "team_work_item") throw coded("work_item_not_found");
      if (workItemEtag(root) !== ifMatch) throw coded("work_item_conflict");
      const isAccountableOwner = root.accountable_owner_user_id === context.userId && root.actor_access === "owner";
      const managesChange = input.members !== undefined
        || input.assigneeUserId !== undefined
        || input.accountableOwnerUserId !== undefined
        || input.priority !== undefined
        || input.dueAt !== undefined;
      const completes = input.status === "completed";
      if ((managesChange || completes) && !isAccountableOwner && !WORKSPACE_MANAGERS.has(context.role)) {
        throw coded("work_item_manage_forbidden");
      }
      if (!isAccountableOwner && !WORKSPACE_MANAGERS.has(context.role)
        && root.actor_access !== "contribute") {
        throw coded("work_item_update_forbidden");
      }
      const resultReview=await readWorkItemResults(query,context.workspaceId,workItemId);
      if((resultReview.currentSubmission&&input.status==='completed')||(resultReview.currentSubmission?.status==='pending'&&input.status!==undefined&&input.status!==root.status)) throw coded('work_item_result_review_required');
      const next = normalizeWorkItemPatchAgainst(root, input);
      await this.#resolveWorkspaceMembers(query, {
        workspaceId: context.workspaceId,
        userIds: [next.accountableOwnerUserId],
      });
      const desiredMembers = input.assigneeUserId !== undefined ? null : input.members === undefined
        ? await this.#currentDesiredWorkItemMembers(query, {
          workspaceId: context.workspaceId,
          workItemId,
          ownerUserId: root.accountable_owner_user_id,
        })
        : await this.#resolveDesiredWorkItemMembers(query, {
          workspaceId: context.workspaceId,
          members: input.members,
          ownerUserId: next.accountableOwnerUserId,
        });
      const authority = await this.#loadPersonalAuthority(query, {
        workspaceId: context.workspaceId,
        userId: context.userId,
        requireWorkspaceManager: false,
      });
      const now = await this.#databaseNow(query);
      next.completedAt = next.status === "completed" ? now : null;
      const targetRevision = Number(root.write_version) + 1;
      const intent = {
        workItemId,
        expectedWriteVersion: Number(root.write_version),
        patch: workItemPatchIntent(input),
      };
      const authorization = await this.#authorizeExplicit(query, {
        authority,
        userId: context.userId,
        actionId: "work_item_update",
        effectClass: "write_local",
        intent,
        now,
      });
      const commandId = newId(this.#idFactory, "product-command");
      const eventId = newId(this.#idFactory, "work-item-event");
      await query("SET CONSTRAINTS ALL DEFERRED");
      if (input.assigneeUserId !== undefined) {
        if (['completed', 'cancelled'].includes(root.status)) throw coded('work_item_update_invalid');
        await this.#resolveWorkspaceMembers(query, { workspaceId: context.workspaceId, userIds: [input.assigneeUserId] });
        const recipient = (await query(`
          SELECT grant_id FROM public.work_item_access_grants
           WHERE workspace_id=$1 AND work_item_id=$2 AND user_id=$3
             AND status='active' AND access_level='contribute'
           FOR UPDATE
        `, [context.workspaceId, workItemId, input.assigneeUserId])).rows[0];
        if (!recipient) throw coded('work_item_update_forbidden');
        await query(`
          INSERT INTO public.work_item_member_roles
            (workspace_id,work_item_id,user_id,role,created_by_user_id,created_at,status,revision,updated_at,removed_at)
          VALUES ($1,$2,$3,'assignee',$4,$5::timestamptz,'active',1,$5::timestamptz,NULL)
          ON CONFLICT (workspace_id,work_item_id,user_id,role) DO UPDATE
             SET status='active',removed_at=NULL,revision=work_item_member_roles.revision+1,updated_at=EXCLUDED.updated_at
           WHERE work_item_member_roles.status='removed'
        `, [context.workspaceId, workItemId, input.assigneeUserId, context.userId, now]);
      } else await this.#replaceWorkItemMembers(query, {
        workspaceId: context.workspaceId,
        workItemId,
        currentOwnerUserId: root.accountable_owner_user_id,
        nextOwnerUserId: next.accountableOwnerUserId,
        requestorUserId: root.requestor_user_id,
        desiredMembers,
        actorUserId: context.userId,
        now,
      });
      const updated = (await query(`
        UPDATE public.work_items
           SET status = $3, priority = $4, accountable_owner_user_id = $5,
               due_at = $6::timestamptz, blocked_reason = $7, next_action = $8,
               completed_at = $9::timestamptz, write_version = $10,
               updated_at = $11::timestamptz
         WHERE workspace_id = $1 AND work_item_id = $2 AND write_version = $12
         RETURNING *
      `, [
        context.workspaceId,
        workItemId,
        next.status,
        next.priority,
        next.accountableOwnerUserId,
        next.dueAt,
        next.blockedReason,
        next.nextAction,
        next.completedAt,
        targetRevision,
        now,
        Number(root.write_version),
      ])).rows[0];
      if (!updated) throw coded("work_item_conflict");
      await this.#insertCompletedCommand(query, {
        commandId,
        authority,
        userId: context.userId,
        actionId: "work_item_update",
        effectClass: "write_local",
        authorization,
        targetKind: "work_item",
        targetId: workItemId,
        targetRevision,
        now,
      });
      await query(`
        INSERT INTO public.work_item_lifecycle_events (
          workspace_id, event_id, product_command_id, work_item_id, kind,
          target_revision, status_after, accountable_owner_user_id, actor_user_id,
          created_at, payload
        ) VALUES ($1, $2, $3, $4, 'work_item_update', $5, $6, $7, $8,
          $9::timestamptz, $10::jsonb)
      `, [
        context.workspaceId,
        eventId,
        commandId,
        workItemId,
        targetRevision,
        next.status,
        next.accountableOwnerUserId,
        context.userId,
        now,
        JSON.stringify({ changedFields: changedWorkItemFields(root, next, input) }),
      ]);
      const detail = await this.#promotionLifecycle.getWorkItem({
        workItemId,
        context,
        transactionSession: uow,
      });
      if (!detail) throw coded("work_item_projection_incomplete");
      return { data: detail.workItem, etag: workItemEtag(updated) };
    }, transactionSession);
  }

  async requireResultAccess({context,workItemId,review=false,transactionSession=null}) {
    return this.#transaction(async query=>{
      const root=(await query('SELECT * FROM public.work_items WHERE workspace_id=$1 AND work_item_id=$2 FOR UPDATE',[context.workspaceId,workItemId])).rows[0];
      if(!root)throw coded('work_item_not_found');
      const grant=await requireWorkItemRunAccess(query,{context,workItemId});
      if(!['owner','contribute'].includes(grant.access_level)||(review&&(root.accountable_owner_user_id!==context.userId||grant.access_level!=='owner')))throw coded('work_item_result_forbidden');
      return root;
    },transactionSession);
  }
  submitWorkItemResult(input){return this.#changeResult(input,false);}
  reviewWorkItemResult(input){return this.#changeResult(input,true);}
  async #changeResult({context,workItemId,submissionId,request,ifMatch,transactionSession=null},review) {
    const data=request?.data;
    if(!Check(review?ReviewWorkItemResultDataSchema:SubmitWorkItemResultDataSchema,data)||(review&&data.decision==='request_changes'&&!data.feedback.trim()))throw coded('work_item_result_invalid');
    assertEtag(ifMatch,'work_item_etag_required');
    return this.#transaction(async(query,uow)=>{
      const root=await this.requireResultAccess({context,workItemId,review,transactionSession:uow});
      if(workItemEtag(root)!==ifMatch)throw coded('work_item_conflict');
      await requireWorkItemRunAccess(query,{context,workItemId,write:true});
      const entry=(await query(`SELECT * FROM public.work_thread_entries WHERE workspace_id=$1 AND work_item_id=$2 AND entry_id=$3`,[context.workspaceId,workItemId,data.entryId])).rows[0];
      if(!entry||entry.entry_kind!=='comment'||entry.content_hash!==data.contentHash||(!review&&entry.created_by_user_id!==context.userId))throw coded('work_item_result_entry_invalid');
      const current=(await readWorkItemResults(query,context.workspaceId,workItemId)).currentSubmission;
      if(review) {
        if(root.status!=='waiting_review'||current?.status!=='pending'||current.submissionId!==submissionId||current.entry.entryId!==data.entryId||current.entry.contentHash!==data.contentHash)throw coded('work_item_result_stale');
        await requireWorkItemRunAccess(query,{context:{...context,userId:current.submittedByUserId},workItemId,write:true});
      } else if(!['ready','active','blocked'].includes(root.status)||current?.status==='pending')throw coded('work_item_result_stale');
      const status=review?(data.decision==='accept'?'completed':'active'):'waiting_review';
      const resultEvent=review?{action:'review',submissionId,...data}:{action:'submit',...data};
      const authority=await this.#loadPersonalAuthority(query,{workspaceId:context.workspaceId,userId:context.userId,requireWorkspaceManager:false});
      const now=await this.#databaseNow(query),revision=Number(root.write_version)+1;
      const authorization=await this.#authorizeExplicit(query,{authority,userId:context.userId,actionId:'work_item_update',effectClass:'write_local',intent:{workItemId,expectedWriteVersion:Number(root.write_version),resultReview:resultEvent},now});
      const commandId=newId(this.#idFactory,'product-command'),eventId=newId(this.#idFactory,'work-item-event');
      await query('SET CONSTRAINTS ALL DEFERRED');
      await query(`UPDATE public.work_items SET status=$3,write_version=$4,updated_at=$5,completed_at=$6,blocked_reason=NULL,next_action=CASE WHEN $7::text IS NULL THEN next_action ELSE $7 END WHERE workspace_id=$1 AND work_item_id=$2`,[context.workspaceId,workItemId,status,revision,now,status==='completed'?now:null,review&&data.decision==='request_changes'?data.feedback:null]);
      await this.#insertCompletedCommand(query,{commandId,authority,userId:context.userId,actionId:'work_item_update',effectClass:'write_local',authorization,targetKind:'work_item',targetId:workItemId,targetRevision:revision,now});
      await query(`INSERT INTO public.work_item_lifecycle_events(workspace_id,event_id,product_command_id,work_item_id,kind,target_revision,status_after,accountable_owner_user_id,actor_user_id,created_at,payload)
        VALUES($1,$2,$3,$4,'work_item_update',$5,$6,$7,$8,$9,$10)`,[context.workspaceId,eventId,commandId,workItemId,revision,status,root.accountable_owner_user_id,context.userId,now,JSON.stringify({changedFields:['status'],resultReview:resultEvent})]);
      return this.getWorkItem({workItemId,context,transactionSession:uow});
    },transactionSession);
  }

  async #createProjectScope(query, {
    authority,
    userId,
    projectId,
    scopeId,
    policyRevisionId,
    grantId,
    commandId,
    now,
  }) {
    const policy = {
      observationTier: "workspace_readable",
      permissionMode: "interactive",
      autoApprovedEffectClasses: [],
      autoApprovedActionIds: [],
    };
    const initialCapabilities = [];
    const contentHash = canonicalRequestHash({
      schemaVersion: "workbench-v1",
      scopeId,
      policyRevisionId,
      revision: 1,
      ...policy,
    });
    const targetContract = {
      scopeKind: "project",
      ownerUserId: null,
      ownerPrincipalId: null,
      projectId,
      creatorPrincipalId: userId,
      creatorPrincipalKind: "user",
      policy: {
        policyRevisionId,
        revision: 1,
        observationTier: policy.observationTier,
        permissionMode: policy.permissionMode,
        autoApprovedEffectClasses: [],
        autoApprovedActionIds: [],
        contentHash,
      },
      initialGrant: {
        grantId,
        subjectPrincipalId: userId,
        subjectPrincipalKind: "user",
        accessKind: "operation",
        capabilities: initialCapabilities,
        canApprove: true,
      },
    };
    const authorization = await this.#authorizeExplicit(query, {
      authority,
      userId,
      actionId: "scope_create",
      effectClass: "administrative",
      intent: { scopeId, ...targetContract },
      targetContract,
      now,
    });
    await this.#insertCompletedCommand(query, {
      commandId,
      authority,
      userId,
      actionId: "scope_create",
      effectClass: "administrative",
      authorization,
      targetKind: "product_scope",
      targetId: scopeId,
      targetRevision: 1,
      targetContract,
      now,
    });
    await query(`
      INSERT INTO public.product_scopes (
        workspace_id, scope_id, schema_version, scope_kind, project_id,
        current_policy_revision_id, created_by_principal_id, created_by_principal_kind,
        creation_mode, creation_command_id, creation_authority_scope_id,
        created_at, updated_at, payload
      ) VALUES ($1, $2, 'workbench-v1', 'project', $3,
        $4, $5, 'user', 'command', $6, $7,
        $8::timestamptz, $8::timestamptz, $9::jsonb)
    `, [
      authority.workspace_id,
      scopeId,
      projectId,
      policyRevisionId,
      userId,
      commandId,
      authority.scope_id,
      now,
      JSON.stringify({ projectId }),
    ]);
    await query(`
      INSERT INTO public.scope_policy_revisions (
        workspace_id, scope_id, policy_revision_id, revision, observation_tier,
        permission_mode, auto_approved_effect_classes, auto_approved_action_ids,
        policy_content_hash, created_by_principal_id, created_by_principal_kind,
        created_at, payload
      ) VALUES ($1, $2, $3, 1, $4, $5, ARRAY[]::text[], ARRAY[]::text[],
        $6, $7, 'user', $8::timestamptz, $9::jsonb)
    `, [
      authority.workspace_id,
      scopeId,
      policyRevisionId,
      policy.observationTier,
      policy.permissionMode,
      contentHash,
      userId,
      now,
      JSON.stringify({ projectId }),
    ]);
    await query(`
      INSERT INTO public.scope_principal_grants (
        workspace_id, scope_id, grant_id, principal_id, principal_kind, access_kind,
        capabilities, can_approve, granted_by_principal_id, granted_by_principal_kind,
        issuance_kind, issuance_authority_scope_id, issuance_command_id,
        issuance_authorization_decision_id, issuance_argument_digest,
        status, revision, created_at, updated_at, payload
      ) VALUES ($1, $2, $3, $4, 'user', 'operation',
        $5::text[], true,
        $4, 'user', 'scope_creation', $6, $7, $8, $9,
        'active', 1, $10::timestamptz, $10::timestamptz, $11::jsonb)
    `, [
      authority.workspace_id,
      scopeId,
      grantId,
      userId,
      initialCapabilities,
      authority.scope_id,
      commandId,
      authorization.authorizationDecisionId,
      authorization.argumentDigest,
      now,
      JSON.stringify({ projectId }),
    ]);
  }

  async #loadPersonalAuthority(query, { workspaceId, userId, requireWorkspaceManager }) {
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
       WHERE scope.workspace_id = $1
         AND scope.scope_kind = 'personal'
         AND scope.owner_user_id = $2
         AND scope.status = 'active'
       FOR UPDATE OF scope, policy, scope_grant, membership
    `, [workspaceId, userId])).rows[0];
    if (!row || row.permission_mode !== "interactive") throw coded("team_work_personal_authority_unavailable");
    if (requireWorkspaceManager && !WORKSPACE_MANAGERS.has(row.workspace_role)) {
      throw coded("project_create_forbidden");
    }
    return row;
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
      authority.workspace_id,
      authority.scope_id,
      authority.current_policy_revision_id,
      userId,
      authority.grant_id,
      actionId,
      effectClass,
      argumentDigest,
      target,
      authority.permission_mode,
      authority.auto_approved_effect_classes,
      authority.auto_approved_action_ids,
      now,
      expiresAt,
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
      ) VALUES ($1, $2, $3, $4,
        $5, 'user', $6, $5, 'user', $6,
        'principal', $5, 'user', $6, $7, $8, $9, $10::jsonb,
        $11, $12::text[], $13::text[],
        'authority-v1', 'approval_required', $2, 'explicit_team_work_action',
        $14::timestamptz, $15::timestamptz, '{"issuer":"team_work_lifecycle"}'::jsonb)
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
      ) VALUES ($1, $2, $3, $4,
        $5, 'user', $6, $5, 'user', $6,
        'principal', $5, 'user', $6, $7, $8, $9, $10::jsonb,
        $11, $12::text[], $13::text[],
        'authority-v1', 'authorized', $14, 'explicit_team_work_action',
        $15::timestamptz, $16::timestamptz, '{"issuer":"team_work_lifecycle"}'::jsonb)
    `, [
      authority.workspace_id,
      authorizationDecisionId,
      ...shared.slice(1, -2),
      approvalId,
      now,
      expiresAt,
    ]);
    return { authorizationDecisionId, argumentDigest, authorizedAt: now };
  }

  async #insertCompletedCommand(query, {
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
      commandId,
      authority.workspace_id,
      authority.scope_id,
      userId,
      authorization.authorizationDecisionId,
      authority.current_policy_revision_id,
      effectClass,
      authorization.argumentDigest,
      targetContract === null ? null : JSON.stringify(targetContract),
      actionId,
      targetKind,
      targetId,
      targetRevision,
      now,
    ]);
  }

  async #loadProject(query, { workspaceId, projectId, context, lock }) {
    const row = (await query(`
      SELECT project.*
        FROM public.projects project
       WHERE project.workspace_id = $1 AND project.project_id = $2
         AND (
           $3::boolean
           OR EXISTS (
             SELECT 1 FROM public.project_memberships membership
              WHERE membership.workspace_id = project.workspace_id
                AND membership.project_id = project.project_id
                AND membership.user_id = $4
                AND membership.status = 'active'
           )
         )
       ${lock ? "FOR UPDATE OF project" : ""}
    `, [workspaceId, projectId, WORKSPACE_MANAGERS.has(context.role), context.userId])).rows[0];
    return row ?? null;
  }

  async #projectFromRow(query, row) {
    const members = await this.#activeProjectMembers(query, {
      workspaceId: row.workspace_id,
      projectId: row.project_id,
    });
    return {
      schemaVersion: row.schema_version,
      projectId: row.project_id,
      workspaceId: row.workspace_id,
      scopeId: row.scope_id,
      title: row.title,
      objective: row.objective,
      status: row.status,
      accountableOwnerUserId: row.accountable_owner_user_id,
      members: members.map((member) => ({ userId: member.userId, role: member.role })),
      createdAt: timestamp(row.created_at),
      updatedAt: timestamp(row.updated_at),
      archivedAt: row.archived_at == null ? null : timestamp(row.archived_at),
    };
  }

  async #activeProjectMembers(query, { workspaceId, projectId }) {
    const rows = (await query(`
      SELECT user_id, role
        FROM public.project_memberships
       WHERE workspace_id = $1 AND project_id = $2 AND status = 'active'
       ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, user_id ASC
    `, [workspaceId, projectId])).rows;
    return rows.map((row) => ({ userId: row.user_id, role: row.role }));
  }

  async #projectMembership(query, { workspaceId, projectId, userId }) {
    return (await query(`
      SELECT role
        FROM public.project_memberships
       WHERE workspace_id = $1 AND project_id = $2 AND user_id = $3
         AND status = 'active'
       FOR SHARE
    `, [workspaceId, projectId, userId])).rows[0] ?? null;
  }

  async #upsertProjectMemberships(query, {
    workspaceId,
    projectId,
    ownerUserId,
    members,
    actorUserId,
    now,
  }) {
    const desired = new Set([ownerUserId, ...members.map((member) => member.userId)]);
    const existing = (await query(`
      SELECT user_id, role, status
        FROM public.project_memberships
       WHERE workspace_id = $1 AND project_id = $2
       FOR UPDATE
    `, [workspaceId, projectId])).rows;
    const removedUserIds = existing.filter(row => row.status === "active" && !desired.has(row.user_id)).map(row => row.user_id);
    if (removedUserIds.length) {
      // Rejoining restores data access, never an earlier one-time Agent consent.
      const requests = (await query(`SELECT request.request_id
        FROM public.member_agent_requests request
        JOIN public.work_items item USING (workspace_id,work_item_id)
        LEFT JOIN public.execution_invocations invocation USING (workspace_id,invocation_id)
        WHERE request.workspace_id=$1 AND item.project_id=$2
          AND (request.requester_user_id=ANY($3::text[]) OR request.provider_user_id=ANY($3::text[]))
          AND request.consent IN ('pending','accepted')
          AND (request.invocation_id IS NULL OR invocation.status IN ('queued','running','cancellation_requested'))
        FOR UPDATE OF request`, [workspaceId, projectId, removedUserIds])).rows;
      await revokeMemberAgentRequests(query, {workspaceId, requestIds: requests.map(row => row.request_id)});
    }
    for (const row of existing) {
      if (row.user_id === ownerUserId) continue;
      if (!desired.has(row.user_id) && row.status === "active") {
        await query(`
          UPDATE public.project_memberships
             SET status = 'removed', removed_at = $4::timestamptz,
                 revision = revision + 1, updated_at = $4::timestamptz
           WHERE workspace_id = $1 AND project_id = $2 AND user_id = $3
             AND status = 'active'
        `, [workspaceId, projectId, row.user_id, now]);
      }
    }
    for (const userId of desired) {
      const role = userId === ownerUserId ? "owner" : "member";
      await query(`
        INSERT INTO public.project_memberships (
          workspace_id, project_id, user_id, role, status, revision,
          created_by_user_id, created_at, updated_at, removed_at, payload
        ) VALUES ($1, $2, $3, $4, 'active', 1,
          $5, $6::timestamptz, $6::timestamptz, NULL, '{}'::jsonb)
        ON CONFLICT (workspace_id, project_id, user_id)
        DO UPDATE SET
          status = 'active', removed_at = NULL,
          revision = CASE WHEN public.project_memberships.status = 'active'
            THEN public.project_memberships.revision
            ELSE public.project_memberships.revision + 1 END,
          updated_at = CASE WHEN public.project_memberships.status = 'active'
            THEN public.project_memberships.updated_at
            ELSE EXCLUDED.updated_at END
      `, [workspaceId, projectId, userId, role, actorUserId, now]);
    }
  }

  async #resolveWorkspaceMembers(query, { workspaceId, userIds }) {
    if (new Set(userIds).size !== userIds.length) throw coded("team_work_member_invalid");
    if (userIds.length === 0) return [];
    const rows = (await query(`
      SELECT membership.user_id
        FROM public.workspace_memberships membership
        JOIN public.product_users user_account ON user_account.user_id = membership.user_id
       WHERE membership.workspace_id = $1
         AND membership.user_id = ANY($2::text[])
         AND membership.status = 'active' AND user_account.disabled = false
       FOR SHARE OF membership, user_account
    `, [workspaceId, userIds])).rows;
    if (rows.length !== userIds.length) throw coded("team_work_member_not_found");
    return userIds.map((userId) => ({ userId }));
  }

  async #currentDesiredWorkItemMembers(query, { workspaceId, workItemId, ownerUserId }) {
    const grants = (await query(`
      SELECT user_id, access_level
        FROM public.work_item_access_grants
       WHERE workspace_id = $1 AND work_item_id = $2 AND status = 'active'
       FOR SHARE
    `, [workspaceId, workItemId])).rows;
    const roles = (await query(`
      SELECT user_id, role
        FROM public.work_item_member_roles
       WHERE workspace_id = $1 AND work_item_id = $2 AND status = 'active'
       FOR SHARE
    `, [workspaceId, workItemId])).rows;
    const byUser = new Map();
    for (const grant of grants) {
      if (grant.user_id === ownerUserId) continue;
      byUser.set(grant.user_id, { userId: grant.user_id, access: grant.access_level, roles: [] });
    }
    for (const role of roles) {
      const target = byUser.get(role.user_id);
      if (target && role.role !== "accountable_owner" && role.role !== "requestor") {
        target.roles.push(role.role);
      }
    }
    return [...byUser.values()].map((member) => ({
      ...member,
      roles: sortedUnique(member.roles),
    }));
  }

  async #resolveDesiredWorkItemMembers(query, { workspaceId, members, ownerUserId }) {
    const userIds = members.map((member) => member.userId);
    await this.#resolveWorkspaceMembers(query, { workspaceId, userIds });
    const desired = members.map((member) => ({ ...member, roles: [...member.roles] }));
    const ownerInput = desired.find((member) => member.userId === ownerUserId);
    if (ownerInput) {
      ownerInput.access = "owner";
      ownerInput.roles = sortedUnique([...ownerInput.roles, "accountable_owner"]);
    }
    return desired;
  }

  async #replaceWorkItemMembers(query, {
    workspaceId,
    workItemId,
    currentOwnerUserId,
    nextOwnerUserId,
    requestorUserId,
    desiredMembers,
    actorUserId,
    now,
  }) {
    const ownerRoles = ["accountable_owner"];
    if (requestorUserId === nextOwnerUserId) ownerRoles.push("requestor");
    const owner = { userId: nextOwnerUserId, access: "owner", roles: ownerRoles };
    const requested = desiredMembers
      .filter((member) => member.userId !== nextOwnerUserId)
      .map((member) => ({
        userId: member.userId,
        access: member.access,
        roles: sortedUnique(member.roles.filter((role) => role !== "accountable_owner")),
      }));
    if (currentOwnerUserId && currentOwnerUserId !== nextOwnerUserId
      && !requested.some((member) => member.userId === currentOwnerUserId)) {
      requested.push({ userId: currentOwnerUserId, access: "contribute", roles: [] });
    }
    if (requestorUserId !== nextOwnerUserId
      && !requested.some((member) => member.userId === requestorUserId)) {
      requested.push({ userId: requestorUserId, access: "contribute", roles: ["requestor"] });
    }
    const desired = new Map([[owner.userId, owner], ...requested.map((member) => [member.userId, member])]);
    if (desired.size > 64) throw coded("team_work_member_invalid");
    const existing = (await query(`
      SELECT grant_id, user_id, access_level, status
        FROM public.work_item_access_grants
       WHERE workspace_id = $1 AND work_item_id = $2
       FOR UPDATE
    `, [workspaceId, workItemId])).rows;
    // Demote the prior owner before promoting a new one; the database enforces
    // exactly one active owner even while this command is in flight.
    for (const grant of existing) {
      if (grant.status === "active" && grant.access_level === "owner"
        && grant.user_id !== nextOwnerUserId) {
        await query(`
          UPDATE public.work_item_access_grants
             SET access_level = 'contribute'
           WHERE workspace_id = $1 AND work_item_id = $2 AND grant_id = $3
             AND status = 'active' AND access_level = 'owner'
        `, [workspaceId, workItemId, grant.grant_id]);
      }
    }
    for (const grant of existing) {
      const target = desired.get(grant.user_id);
      if (!target && grant.status === "active") {
        await query(`
          UPDATE public.work_item_access_grants
             SET status = 'revoked', revoked_by_user_id = $4, revoked_at = $5::timestamptz
           WHERE workspace_id = $1 AND work_item_id = $2 AND grant_id = $3
             AND status = 'active'
        `, [workspaceId, workItemId, grant.grant_id, actorUserId, now]);
      } else if (target && grant.status === "active" && grant.access_level !== target.access) {
        await query(`
          UPDATE public.work_item_access_grants
             SET access_level = $4
           WHERE workspace_id = $1 AND work_item_id = $2 AND grant_id = $3
        `, [workspaceId, workItemId, grant.grant_id, target.access]);
      }
    }
    const activeByUser = new Map(existing.filter((grant) => grant.status === "active").map((grant) => [grant.user_id, grant]));
    for (const member of desired.values()) {
      if (activeByUser.has(member.userId)) continue;
      await query(`
        INSERT INTO public.work_item_access_grants (
          grant_id, workspace_id, work_item_id, user_id, access_level, status,
          promotion_id, created_by_user_id, created_at, revoked_by_user_id, revoked_at
        ) VALUES ($1, $2, $3, $4, $5, 'active', NULL, $6, $7::timestamptz, NULL, NULL)
      `, [
        newId(this.#idFactory, "work-item-access-grant"),
        workspaceId,
        workItemId,
        member.userId,
        member.access,
        actorUserId,
        now,
      ]);
    }
    const requestedRoles = new Map();
    requestedRoles.set(nextOwnerUserId, new Set(ownerRoles));
    if (requestorUserId !== nextOwnerUserId) {
      requestedRoles.set(requestorUserId, new Set(["requestor"]));
    }
    for (const member of desired.values()) {
      const roles = requestedRoles.get(member.userId) ?? new Set();
      for (const role of member.roles) roles.add(role);
      requestedRoles.set(member.userId, roles);
    }
    const existingRoles = (await query(`
      SELECT user_id, role, status
        FROM public.work_item_member_roles
       WHERE workspace_id = $1 AND work_item_id = $2
       FOR UPDATE
    `, [workspaceId, workItemId])).rows;
    const currentRoleKeys = new Set(existingRoles.map((role) => `${role.user_id}:${role.role}`));
    for (const role of existingRoles) {
      const wanted = requestedRoles.get(role.user_id)?.has(role.role) === true;
      if (!wanted && role.status === "active") {
        await query(`
          UPDATE public.work_item_member_roles
             SET status = 'removed', removed_at = $5::timestamptz,
                 revision = revision + 1, updated_at = $5::timestamptz
           WHERE workspace_id = $1 AND work_item_id = $2 AND user_id = $3 AND role = $4
             AND status = 'active'
        `, [workspaceId, workItemId, role.user_id, role.role, now]);
      } else if (wanted && role.status === "removed") {
        await query(`
          UPDATE public.work_item_member_roles
             SET status = 'active', removed_at = NULL,
                 revision = revision + 1, updated_at = $5::timestamptz
           WHERE workspace_id = $1 AND work_item_id = $2 AND user_id = $3 AND role = $4
             AND status = 'removed'
        `, [workspaceId, workItemId, role.user_id, role.role, now]);
      }
    }
    for (const [userId, roles] of requestedRoles) {
      for (const role of roles) {
        if (currentRoleKeys.has(`${userId}:${role}`)) continue;
        await query(`
          INSERT INTO public.work_item_member_roles (
            workspace_id, work_item_id, user_id, role, created_by_user_id, created_at,
            status, revision, updated_at, removed_at
          ) VALUES ($1, $2, $3, $4, $5, $6::timestamptz,
            'active', 1, $6::timestamptz, NULL)
        `, [workspaceId, workItemId, userId, role, actorUserId, now]);
      }
    }
  }

  async #databaseNow(query) {
    const row = (await query("SELECT clock_timestamp() AS now")).rows[0];
    return timestamp(row?.now ?? this.#clock());
  }

  #transaction(work, uow = null) {
    return this.#store.withTransaction(
      (unit) => work((text, values = []) => this.#query(unit, text, values), unit),
      uow ? { uow } : {},
    );
  }

  #query(uow, text, values = []) { return this.#sql.query(uow, text, values); }
}

function normalizeProjectCreate(request) {
  const value = request?.data;
  if (!isPlainObject(value)) throw coded("project_request_invalid");
  if (Object.keys(value).some((key) => !["title", "objective", "members"].includes(key))) {
    throw coded("project_request_invalid");
  }
  return {
    title: safeText(value.title, 200, "project_request_invalid"),
    objective: safeText(value.objective, 2_000, "project_request_invalid"),
    members: normalizeProjectMemberList(value.members ?? []),
  };
}

function normalizeProjectMembersRequest(request) {
  const data = request?.data;
  if (!isPlainObject(data) || Object.keys(data).join(",") !== "members") {
    throw coded("team_work_member_invalid");
  }
  const value = data.members;
  return { members: normalizeProjectMemberList(value) };
}

function normalizeProjectMemberList(value) {
  if (!Array.isArray(value) || value.length > 63) throw coded("team_work_member_invalid");
  const seen = new Set();
  return value.map((member) => {
    if (!isPlainObject(member) || Object.keys(member).join(",") !== "userId") {
      throw coded("team_work_member_invalid");
    }
    assertId(member.userId, "team_work_member_invalid");
    if (seen.has(member.userId)) throw coded("team_work_member_invalid");
    seen.add(member.userId);
    return { userId: member.userId };
  });
}

function normalizeTeamWorkItemCreate(request) {
  const value = request?.data;
  if (!isPlainObject(value)) throw coded("work_item_request_invalid");
  const keys = Object.keys(value).sort();
  const allowed = new Set(["dueAt", "members", "objective", "priority", "projectId", "summary", "title"]);
  if (keys.some((key) => !allowed.has(key))) throw coded("work_item_request_invalid");
  const projectId = value.projectId === undefined || value.projectId === null ? null : assertId(value.projectId, "project_id_required");
  return {
    projectId,
    title: safeText(value.title, 200, "work_item_request_invalid"),
    objective: safeText(value.objective, 2_000, "work_item_request_invalid"),
    summary: safeText(value.summary, 8_000, "work_item_request_invalid"),
    priority: normalizePriority(value.priority ?? "medium"),
    dueAt: normalizeNullableTimestamp(value.dueAt ?? null, "work_item_request_invalid"),
    members: normalizeWorkItemMembers(value.members ?? []),
  };
}

function normalizeTeamWorkItemAgentEntry(request) {
  const value = request?.data;
  if (!isPlainObject(value)) throw coded("team_work_agent_entry_invalid");
  const allowed = new Set([
    "projectId",
    "title",
    "objective",
    "summary",
    "priority",
    "dueAt",
    "members",
    "modelProfileId",
    "initialTask",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw coded("team_work_agent_entry_invalid");
  }
  const { modelProfileId, initialTask, ...workItem } = value;
  assertId(modelProfileId, "team_work_agent_entry_invalid");
  if (!isPlainObject(initialTask)
    || Object.keys(initialTask).some((key) => key !== "message" && key !== "attachments")
    || typeof initialTask.message !== "string"
    || (!initialTask.message.trim()
      && (!Array.isArray(initialTask.attachments) || initialTask.attachments.length === 0))) {
    throw coded("team_work_agent_entry_invalid");
  }
  if (initialTask.attachments !== undefined && !Array.isArray(initialTask.attachments)) {
    throw coded("team_work_agent_entry_invalid");
  }
  return {
    workItem: normalizeTeamWorkItemCreate({ data: workItem }),
    modelProfileId,
    initialTask: {
      message: initialTask.message.trim(),
      ...(initialTask.attachments?.length > 0
        ? { attachments: structuredClone(initialTask.attachments) }
        : {}),
    },
  };
}

function normalizeTeamWorkItemUpdate(request) {
  const value = request?.data;
  if (!isPlainObject(value) || Object.keys(value).length === 0) throw coded("work_item_update_invalid");
  const allowed = new Set([
    "status",
    "priority",
    "accountableOwnerUserId",
    "dueAt",
    "blockedReason",
    "nextAction",
    "members",
    "assigneeUserId",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw coded("work_item_update_invalid");
  const result = {};
  if (Object.hasOwn(value, 'assigneeUserId')) {
    if (Object.keys(value).some(key => !['assigneeUserId', 'nextAction'].includes(key))) throw coded('work_item_update_invalid');
    result.assigneeUserId = assertId(value.assigneeUserId, 'work_item_update_invalid');
  }
  if (Object.hasOwn(value, "status")) result.status = normalizeStatus(value.status);
  if (Object.hasOwn(value, "priority")) result.priority = normalizePriority(value.priority);
  if (Object.hasOwn(value, "accountableOwnerUserId")) {
    result.accountableOwnerUserId = assertId(value.accountableOwnerUserId, "work_item_update_invalid");
  }
  if (Object.hasOwn(value, "dueAt")) result.dueAt = normalizeNullableTimestamp(value.dueAt, "work_item_update_invalid");
  if (Object.hasOwn(value, "blockedReason")) result.blockedReason = normalizeNullableText(value.blockedReason, 2_000, "work_item_update_invalid");
  if (Object.hasOwn(value, "nextAction")) result.nextAction = normalizeNullableText(value.nextAction, 2_000, "work_item_update_invalid");
  if (Object.hasOwn(value, "members")) result.members = normalizeWorkItemMembers(value.members);
  return result;
}

function normalizeWorkItemMembers(value) {
  if (!Array.isArray(value) || value.length > 63) throw coded("team_work_member_invalid");
  const seen = new Set();
  return value.map((member) => {
    if (!isPlainObject(member)
      || Object.keys(member).sort().join(",") !== "access,roles,userId") {
      throw coded("team_work_member_invalid");
    }
    assertId(member.userId, "team_work_member_invalid");
    if (!ACCESS_LEVELS.has(member.access) || member.access === "owner"
      || !Array.isArray(member.roles) || member.roles.length < 1 || member.roles.length > 4
      || member.roles.some((role) => !MEMBER_ROLES.has(role)
        || role === "accountable_owner" || role === "requestor")
      || new Set(member.roles).size !== member.roles.length
      || seen.has(member.userId)) {
      throw coded("team_work_member_invalid");
    }
    seen.add(member.userId);
    return { userId: member.userId, access: member.access, roles: sortedUnique(member.roles) };
  });
}

function normalizeWorkItemPatchAgainst(root, input) {
  const status = input.status ?? root.status;
  if (status !== root.status && !STATUS_TRANSITIONS.get(root.status)?.has(status)) {
    throw coded("work_item_status_transition_invalid");
  }
  const blockedReason = input.blockedReason === undefined
    ? (status === root.status ? root.blocked_reason : status === "blocked" ? root.blocked_reason : null)
    : input.blockedReason;
  if (status === "blocked" && !blockedReason) throw coded("work_item_blocked_reason_required");
  return {
    status,
    priority: input.priority ?? root.priority,
    accountableOwnerUserId: input.accountableOwnerUserId ?? root.accountable_owner_user_id,
    dueAt: input.dueAt === undefined ? nullableTimestamp(root.due_at) : input.dueAt,
    blockedReason: status === "blocked" ? blockedReason : null,
    nextAction: input.nextAction === undefined ? root.next_action ?? null : input.nextAction,
    completedAt: null,
  };
}

function mergeInitialWorkItemMembers({ ownerUserId, projectMembers, requested }) {
  const values = new Map();
  for (const member of projectMembers) {
    if (member.userId !== ownerUserId) values.set(member.userId, {
      userId: member.userId,
      access: "read",
      roles: ["watcher"],
    });
  }
  for (const member of requested) {
    if (member.userId === ownerUserId) throw coded("team_work_member_invalid");
    values.set(member.userId, { ...member, roles: [...member.roles] });
  }
  return [{
    userId: ownerUserId,
    access: "owner",
    roles: ["accountable_owner", "requestor"],
  }, ...[...values.values()].sort((left, right) => left.userId.localeCompare(right.userId))];
}

function memberIntent(member) {
  return { userId: member.userId, access: member.access, roles: [...member.roles] };
}

function teamWorkItemTarget({ workItemId, input, access }) {
  return {
    kind: "new_team_work_item",
    workItemId,
    projectId: input.projectId,
    title: input.title,
    objective: input.objective,
    summary: input.summary,
    priority: input.priority,
    dueAt: input.dueAt,
    members: access.map(memberIntent),
  };
}

function continuationPublic(value) {
  return {
    continuationId: value.continuationId,
    workItemId: value.workItemId,
    agentSessionId: value.agentSessionId,
    handoffId: value.handoffId,
    createdAt: value.createdAt,
  };
}

function workItemPatchIntent(input) {
  const result = {};
  for (const [key, value] of Object.entries(input)) {
    result[key] = key === "members"
      ? value.map(memberIntent)
      : value;
  }
  return result;
}

function changedWorkItemFields(root, next, input) {
  const fields = [];
  if (root.status !== next.status) fields.push("status");
  if (root.priority !== next.priority) fields.push("priority");
  if (root.accountable_owner_user_id !== next.accountableOwnerUserId) fields.push("accountableOwnerUserId");
  if (nullableTimestamp(root.due_at) !== next.dueAt) fields.push("dueAt");
  if ((root.blocked_reason ?? null) !== next.blockedReason) fields.push("blockedReason");
  if ((root.next_action ?? null) !== next.nextAction) fields.push("nextAction");
  if (input.members !== undefined) fields.push("members");
  if (input.assigneeUserId !== undefined) fields.push("assigneeUserId");
  return fields;
}

function canManageProject(project, context) {
  return project.accountable_owner_user_id === context.userId || WORKSPACE_MANAGERS.has(context.role);
}

function projectEtag(row) {
  return `"projectv1:${row.project_id}:${Number(row.write_version)}"`;
}

function workItemEtag(row) {
  return `"workv1:${row.work_item_id}:${Number(row.write_version)}"`;
}

function normalizePriority(value) {
  if (!["low", "medium", "high", "urgent"].includes(value)) throw coded("work_item_priority_invalid");
  return value;
}

function normalizeStatus(value) {
  if (!WORK_ITEM_STATUSES.has(value)) throw coded("work_item_update_invalid");
  return value;
}

function normalizeNullableTimestamp(value, code) {
  if (value === null) return null;
  if (typeof value !== "string" || !/Z$/.test(value)) throw coded(code);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw coded(code);
  return date.toISOString();
}

function normalizeNullableText(value, maximum, code) {
  if (value === null) return null;
  return safeText(value, maximum, code);
}

function safeText(value, maximum, code) {
  if (typeof value !== "string") throw coded(code);
  const text = value.trim();
  if (!text || text.length > maximum) throw coded(code);
  return text;
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function pageLimit(value) {
  const parsed = Number(value ?? 100);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) throw coded("cursor_invalid");
  return parsed;
}

function assertContext(context) {
  assertId(context?.workspaceId, "team_work_context_invalid");
  assertId(context?.userId, "team_work_context_invalid");
}

function assertId(value, code) {
  if (typeof value !== "string" || !ID.test(value)) throw coded(code);
  return value;
}

function assertEtag(value, code) {
  if (typeof value !== "string" || !/^"[^\"]+"$/.test(value)) throw coded(code);
}

function newId(factory, kind) {
  return assertId(factory(kind), "team_work_identifier_factory_invalid");
}

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("postgres_team_work_clock_invalid");
  return date.toISOString();
}

function nullableTimestamp(value) {
  return value == null ? null : timestamp(value);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function coded(code) {
  const error = new Error(code);
  error.name = "PostgresTeamWorkLifecycleError";
  error.code = code;
  return error;
}
