import { ProductStoreError } from "../errors.mjs";

/**
 * PostgreSQL owner for the pre-M5 `/skills` and `/templates` read contracts.
 * The compatibility API remains separate from M5 Skill Assets; it never asks
 * a Mongo repository to satisfy a production request.
 */
export class PostgresCompatibilityCatalogReadModel {
  #store;
  #sql;

  constructor({ store } = {}) {
    if (!store?.bindAdapter || !store?.withTransaction || !store?.connect) {
      throw new TypeError("postgres_compatibility_catalog_store_required");
    }
    this.#store = store;
    this.#sql = store.bindAdapter(({ execute }) => Object.freeze({
      query: (uow, text, values = []) => execute(uow, { text, values }),
    }));
  }

  async listSkills({ workspaceId, query = {} } = {}) {
    required(workspaceId, "workspace_id_required");
    const limit = boundedLimit(query.limit);
    return this.#transact(async (sql) => {
      const rows = (await sql(`SELECT * FROM public.legacy_skill_definitions
        WHERE status = 'ready' AND (scope_kind = 'global' OR workspace_id = $1)
          AND ($2::text IS NULL OR category = $2)
        ORDER BY (scope_kind = 'workspace') DESC, name ASC, skill_id ASC, version DESC
        LIMIT $3`, [workspaceId, query.category ?? null, limit])).rows;
      const selected = new Map();
      for (const row of rows) {
        const identity = `${row.skill_id}:${row.version}`;
        if (!selected.has(identity)) selected.set(identity, skillView(row));
      }
      return [...selected.values()];
    });
  }

  async getSkill({ workspaceId, skillId } = {}) {
    required(workspaceId, "workspace_id_required");
    required(skillId, "skill_id_required");
    return this.#transact(async (sql) => {
      const row = (await sql(`SELECT * FROM public.legacy_skill_definitions
        WHERE status = 'ready' AND skill_id = $2
          AND (scope_kind = 'global' OR workspace_id = $1)
        ORDER BY (scope_kind = 'workspace') DESC, version DESC
        LIMIT 1`, [workspaceId, skillId])).rows[0];
      if (!row) throw new ProductStoreError("skill_not_found", "Skill not found.", { skillId });
      return skillView(row);
    });
  }

  async listTemplates({ query = {} } = {}) {
    const limit = boundedLimit(query.limit);
    return this.#transact(async (sql) => (await sql(`SELECT * FROM public.templates
      WHERE ($1::text IS NULL OR category = $1)
      ORDER BY name ASC, template_id ASC, template_version DESC LIMIT $2`, [
      query.category ?? null, limit,
    ])).rows.map(templateView));
  }

  async getTemplate({ templateId } = {}) {
    required(templateId, "template_id_required");
    return this.#transact(async (sql) => {
      const row = (await sql(`SELECT * FROM public.templates
        WHERE template_id = $1 ORDER BY template_version DESC LIMIT 1`, [templateId])).rows[0];
      if (!row) throw new ProductStoreError("template_not_found", "Template not found.", { templateId });
      return templateView(row);
    });
  }

  #transact(work) {
    return this.#store.withTransaction((uow) => work((text, values = []) => this.#sql.query(uow, text, values)));
  }
}

function skillView(row) {
  const payload = structuredClone(row.payload ?? {});
  delete payload.status;
  return Object.freeze({
    ...payload,
    schemaVersion: row.schema_version,
    skillId: row.skill_id,
    version: row.version,
    name: row.name,
    description: row.description,
    category: row.category,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

function templateView(row) {
  return Object.freeze({
    schemaVersion: row.schema_version,
    templateId: row.template_id,
    templateVersion: row.template_version,
    name: row.name,
    description: row.description,
    category: row.category,
    display: structuredClone(row.display),
    inputForm: structuredClone(row.input_form),
    graph: structuredClone(row.graph),
    includedSkills: structuredClone(row.included_skills),
    expectedOutputs: structuredClone(row.expected_outputs),
    reviewPolicy: structuredClone(row.review_policy),
    availability: {
      status: row.availability_status,
      diagnostics: structuredClone(row.availability_diagnostics ?? []),
    },
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

function required(value, code) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(code);
}
function boundedLimit(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 500) : 100;
}
function iso(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : String(value);
}
