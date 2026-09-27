/** Product-owned PostgreSQL Inbox read model; it never rebuilds state from Mongo repositories. */
export class PostgresInboxReadModel {
  constructor({ store } = {}) {
    if (!store?.bindAdapter || !store?.withTransaction) throw new TypeError("postgres_inbox_store_required");
    this.store = store;
    this.sql = store.bindAdapter(({ execute }) => Object.freeze({ query: (uow, text, values = []) => execute(uow, { text, values }) }));
  }
  async list({ workspaceId, userId, query = {} } = {}) {
    required(workspaceId); required(userId);
    const cursor = decode(query.cursor); const limit = Math.max(1, Math.min(Number(query.limit) || 50, 100));
    return this.store.withTransaction(async (uow) => {
      const sql = (text, values) => this.sql.query(uow, text, values);
      const membership = (await sql(`SELECT 1 FROM public.workspace_memberships WHERE workspace_id = $1 AND user_id = $2 AND status = 'active'`, [workspaceId, userId])).rows[0];
      if (!membership) throw coded("inbox_forbidden");
      const count = Number((await sql(`SELECT count(*)::int AS count FROM public.inbox_items WHERE workspace_id = $1 AND recipient_user_id = $2 AND status <> 'dismissed'`, [workspaceId, userId])).rows[0]?.count ?? 0);
      const rows = (await sql(`
        SELECT item.*, run.workflow_id, occurrence.automation_id
          FROM public.inbox_items item
          LEFT JOIN public.workflow_runs run
            ON run.workspace_id = item.workspace_id
           AND item.target_kind IN ('workflow_run', 'workflow_run_review')
           AND run.run_id = item.target_id
          LEFT JOIN public.automation_occurrences occurrence
            ON occurrence.workspace_id = item.workspace_id
           AND item.target_kind = 'automation_occurrence'
           AND occurrence.occurrence_id = item.target_id
         WHERE item.workspace_id = $1
           AND item.recipient_user_id = $2
           AND item.status <> 'dismissed'
           AND (
             $3::timestamptz IS NULL
             OR (item.created_at, item.inbox_item_id) < ($3::timestamptz, $4::text)
           )
         ORDER BY item.created_at DESC, item.inbox_item_id DESC
         LIMIT $5
      `, [workspaceId, userId, cursor?.createdAt ?? null, cursor?.itemId ?? null, limit + 1])).rows;
      const items = rows.slice(0, limit).map(view);
      return { data: { items, count, page: { nextCursor: rows.length > limit ? encode(items.at(-1)) : null, hasMore: rows.length > limit } }, responseHeaders: { "Cache-Control": "private, no-store" } };
    });
  }
}

const PUBLIC_OBJECT_KINDS = Object.freeze({
  authorization_decision: "review",
  agent_proposal: "proposal",
  builder_proposal: "proposal",
  merge_conflict: "merge_conflict",
  workflow_run: "run",
  workflow_run_review: "review",
  automation_occurrence: "automation",
  installation_update_draft: "installation_update",
  connection: "connection",
  runtime: "runtime",
  model: "model",
});

const PUBLIC_REASONS = new Set([
  "proposal_conflict",
  "merge_conflict",
  "review_required",
  "library_update_review",
  "connection_missing",
  "connection_invalid",
  "run_blocked",
  "run_failed",
  "runtime_unavailable",
  "model_unavailable",
]);

function view(row) {
  const objectKind = PUBLIC_OBJECT_KINDS[row.target_kind];
  if (!objectKind) throw coded("inbox_target_kind_unsupported");
  return {
    schemaVersion: "workbench-v1", itemId: row.inbox_item_id, workspaceId: row.workspace_id,
    objectKind, objectId: row.target_id, reason: publicReason(row), severity: publicSeverity(row),
    title: row.title, actionRoute: route(row), createdAt: iso(row.created_at),
  };
}

function publicReason(row) {
  if (row.target_kind === "workflow_run_review") return "review_required";
  if (row.target_kind === "automation_occurrence") return "run_blocked";
  if (row.target_kind === "workflow_run" && !PUBLIC_REASONS.has(row.reason_code)) return "run_blocked";
  if (!PUBLIC_REASONS.has(row.reason_code)) throw coded("inbox_reason_unsupported");
  return row.reason_code;
}

function publicSeverity(row) {
  if (row.severity === "error") return "critical";
  if (["info", "warning", "critical"].includes(row.severity)) return row.severity;
  throw coded("inbox_severity_unsupported");
}

function route(row) {
  const id = encodeURIComponent(row.target_id);
  if (row.target_kind === "workflow_run" || row.target_kind === "workflow_run_review") {
    if (!row.workflow_id) throw coded("inbox_workflow_route_unresolved");
    return `/loops/${encodeURIComponent(row.workflow_id)}/runs/${id}`;
  }
  if (row.target_kind === "installation_update_draft") return `/library?updateDraftId=${id}`;
  if (row.target_kind === "automation_occurrence") {
    if (!row.automation_id) throw coded("inbox_automation_route_unresolved");
    return `/automations?automationId=${encodeURIComponent(row.automation_id)}&occurrenceId=${id}`;
  }
  return `/inbox?decisionId=${id}`;
}
function encode(item) { return Buffer.from(JSON.stringify({ createdAt: item.createdAt, itemId: item.itemId }), "utf8").toString("base64url"); }
function decode(cursor) { if (!cursor) return null; try { const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); if (typeof value?.createdAt !== "string" || typeof value?.itemId !== "string") throw new Error(); return value; } catch { throw coded("cursor_invalid"); } }
function iso(value) { return new Date(value).toISOString(); }
function required(value) { if (typeof value !== "string" || !value) throw coded("inbox_identity_required"); }
function coded(code) { const error = new Error(code); error.code = code; return error; }
