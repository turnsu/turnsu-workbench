import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { Check, SkillVersionSchema } from "@looloomi/workbench-contracts";
import { skillDefinitionExample } from "../../../workbench-contracts/examples/canonical-examples.mjs";
import { ProductStoreError } from "../store/errors.mjs";
import {
  formatSkillPackage,
  hashSkillPackageObject,
  objectIdForSkillPackage,
  SKILL_PACKAGE_MEDIA_TYPE,
} from "./skill-package-format.mjs";
import { inspectSkillPackage } from "../validation/skill-package-inspector.mjs";

const SYSTEM_CATALOG_WORKSPACE_ID = "system-catalog";
const SYSTEM_CATALOG_PRINCIPAL_ID = "system-catalog";
const SYSTEM_CATALOG_SCOPE_ID = "system-catalog";
const SYSTEM_CATALOG_POLICY_ID = "system-catalog-policy-1";
const SYSTEM_CATALOG_RELEASE_ID = "system-release-meeting-action-extractor-v1";
const SYSTEM_CATALOG_SOURCE_ID = "system-source-meeting-action-extractor-v1";
const SYSTEM_CATALOG_VERSION_ID = "system-skill-version-meeting-action-extractor-v1";
const SYSTEM_CATALOG_BUILD_AT = "2026-08-11T00:00:00.000Z";
const SYSTEM_CATALOG_POLICY_HASH = "sha256:9f4d153e9c5715e7d74b00dbbd999658d45cc64ee8b9a77ef37ba145c219533d";
const MEETING_ACTION_EXTRACTOR_SKILL_ID = "meeting-action-extractor";
const MEETING_ACTION_EXTRACTOR_EXECUTION_REF = Object.freeze({
  capabilityId: "meeting-action-extractor",
  taskIntent: "extract_actions",
  adapterVersion: "1",
  executionMode: "deterministic",
});
const MEETING_ACTION_EXTRACTOR_INPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: { transcript: { type: "string", minLength: 1, maxLength: 20000 } },
  required: ["transcript"],
  additionalProperties: false,
});
const MEETING_ACTION_EXTRACTOR_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    actionItems: {
      type: "array",
      items: {
        type: "object",
        properties: { text: { type: "string", minLength: 1, maxLength: 2000 } },
        required: ["text"],
        additionalProperties: false,
      },
      maxItems: 100,
    },
    summary: { type: "string", minLength: 1, maxLength: 4000 },
  },
  required: ["actionItems", "summary"],
  additionalProperties: false,
});

/**
 * Product-owned source for immutable built-ins.  It owns the single global
 * catalog aggregate only; it never writes a customer workspace.  Installation
 * is deliberately delegated to the Team Library lifecycle so pin/update
 * semantics stay in one owner.
 */
export class PostgresSystemCatalogService {
  constructor({ store, objectStore, teamLibraryLifecycle, probeSkill, clock = () => new Date().toISOString() } = {}) {
    if (!store?.bindAdapter || !store?.withTransaction || !objectStore?.put || !objectStore?.promote || typeof teamLibraryLifecycle?.installRelease !== "function") {
      throw new TypeError("postgres_system_catalog_dependencies_invalid");
    }
    this.store = store;
    this.objectStore = objectStore;
    this.teamLibraryLifecycle = teamLibraryLifecycle;
    this.probeSkill = probeSkill;
    this.clock = clock;
    this.sql = store.bindAdapter(({ execute }) => Object.freeze({
      query: (uow, text, values = []) => execute(uow, { text, values }),
    }));
  }

  async ensureGlobalSource() {
    const entry = bundledEntry();
    await this.objectStore.initialize?.();
    const probe = typeof this.probeSkill === "function"
      ? await this.probeSkill(entry.executionRef)
      : { ready: true, code: "runtime_probe_not_configured" };
    if (probe?.ready !== true && probe?.status !== "ready") {
      throw coded("system_catalog_runtime_unavailable");
    }
    const stored = await this.objectStore.put({
      workspaceId: SYSTEM_CATALOG_WORKSPACE_ID,
      objectId: entry.objectId,
      bytes: entry.packageBytes,
      contentHash: entry.objectHash,
      mediaType: SKILL_PACKAGE_MEDIA_TYPE,
      metadata: { source: "system-catalog", locator: entry.sourceLocator },
      state: "quarantined",
    });
    const promoted = await this.objectStore.promote({
      workspaceId: SYSTEM_CATALOG_WORKSPACE_ID,
      objectId: entry.objectId,
    });
    if (promoted.contentHash !== entry.objectHash) throw coded("system_catalog_object_integrity_failed");
    const now = iso(this.clock());
    return this.store.withTransaction(async (uow) => {
      const query = (text, values) => this.sql.query(uow, text, values);
      await ensureSystemIdentity(query, now);
      await query(`INSERT INTO public.product_objects (
          workspace_id, object_id, schema_version, object_kind, content_hash, size_bytes,
          media_type, storage_backend, storage_key, storage_version, state, created_at, payload
        ) VALUES ($1, $2, 'workbench-v1', 'skill_package', $3, $4, $5,
          'filesystem', $6, 'workbench-object-store-v1', 'promoted', $7::timestamptz, $8::jsonb)
        ON CONFLICT (workspace_id, object_id) DO NOTHING`, [
        SYSTEM_CATALOG_WORKSPACE_ID, entry.objectId, entry.objectHash, stored.sizeBytes,
        stored.mediaType, `skill-package:${entry.objectId}`, now,
        JSON.stringify({ source: "system-catalog", locator: entry.sourceLocator }),
      ]);
      await query(`INSERT INTO public.skill_assets (
          workspace_id, skill_id, scope_id, owner_system_principal_id, schema_version,
          name_normalized, visibility, lifecycle, current_draft_id, latest_published_version_id,
          created_at, updated_at, payload
        ) VALUES ($1, $2, $3, $4, 'workbench-v1', $5, 'workspace', 'published', NULL, NULL,
          $6::timestamptz, $6::timestamptz, $7::jsonb)
        ON CONFLICT (workspace_id, skill_id) DO NOTHING`, [
        SYSTEM_CATALOG_WORKSPACE_ID, entry.skillId, SYSTEM_CATALOG_SCOPE_ID,
        SYSTEM_CATALOG_PRINCIPAL_ID, entry.name.toLowerCase(), now,
        JSON.stringify({ name: entry.name, description: entry.description }),
      ]);
      await query(`INSERT INTO public.skill_system_catalog_sources (
          workspace_id, catalog_source_id, skill_id, system_principal_id, schema_version,
          source_locator, source_revision, source_manifest_hash, package_object_id,
          package_object_hash, package_hash, published_version_content_hash,
          runtime_probe_id, runtime_probe_status, runtime_probe_code, runtime_probe_digest,
          execution_ref, execution_ref_hash, probed_at, created_at, definition, payload
        ) VALUES ($1, $2, $3, $4, 'workbench-internal-v1', $5, '1.0.0', $6, $7,
          $8, $9, $10, $11, 'ready', $12, $13, $14::jsonb, $15,
          $16::timestamptz, $17::timestamptz, $18::jsonb, $19::jsonb)
        ON CONFLICT (workspace_id, catalog_source_id) DO NOTHING`, [
        SYSTEM_CATALOG_WORKSPACE_ID, SYSTEM_CATALOG_SOURCE_ID, entry.skillId,
        SYSTEM_CATALOG_PRINCIPAL_ID, entry.sourceLocator, entry.manifestHash, entry.objectId,
        entry.objectHash, entry.packageHash, entry.versionContentHash,
        `runtime-probe-${entry.skillId}`, probe.code ?? "runtime_ready",
        hash({ code: probe.code ?? "runtime_ready", executionRef: entry.executionRef }),
        JSON.stringify(entry.executionRef), entry.executionRefHash,
        SYSTEM_CATALOG_BUILD_AT, now, JSON.stringify(entry.definition),
        JSON.stringify({ defaultPack: true, runtimeProbe: "ready" }),
      ]);
      await query(`INSERT INTO public.skill_versions (
          workspace_id, skill_version_id, skill_id, version, schema_version, source_kind,
          system_catalog_source_id, package_object_id, package_object_hash, package_hash,
          content_hash, published_by_system_principal_id, published_at, definition, payload
        ) VALUES ($1, $2, $3, '1.0.0', 'workbench-v1', 'system_catalog', $4, $5, $6, $7,
          $8, $9, $10::timestamptz, $11::jsonb, $12::jsonb)
        ON CONFLICT (workspace_id, skill_version_id) DO NOTHING`, [
        SYSTEM_CATALOG_WORKSPACE_ID, SYSTEM_CATALOG_VERSION_ID, entry.skillId,
        SYSTEM_CATALOG_SOURCE_ID, entry.objectId, entry.objectHash, entry.packageHash,
        entry.versionContentHash, SYSTEM_CATALOG_PRINCIPAL_ID, SYSTEM_CATALOG_BUILD_AT,
        JSON.stringify(entry.definition), JSON.stringify({ source: "system-catalog" }),
      ]);
      await query(`UPDATE public.skill_assets
        SET latest_published_version_id = $3, updated_at = $4::timestamptz
        WHERE workspace_id = $1 AND skill_id = $2
          AND latest_published_version_id IS NULL`, [
        SYSTEM_CATALOG_WORKSPACE_ID, entry.skillId, SYSTEM_CATALOG_VERSION_ID, now,
      ]);
      await query(`INSERT INTO public.workspace_asset_releases (
          source_workspace_id, release_id, schema_version, asset_kind, skill_id,
          skill_version_id, version, content_hash, visibility, domain, starting_point,
          release_notes, dependencies, published_by_system_principal_id, published_at, payload
        ) VALUES ($1, $2, 'workbench-v1', 'skill', $3, $4, '1.0.0', $5, 'workspace',
          'product', true, $6, '[]'::jsonb, $7, $8::timestamptz, $9::jsonb)
        ON CONFLICT (source_workspace_id, release_id) DO NOTHING`, [
        SYSTEM_CATALOG_WORKSPACE_ID, SYSTEM_CATALOG_RELEASE_ID, entry.skillId,
        SYSTEM_CATALOG_VERSION_ID, entry.versionContentHash,
        "Built-in deterministic Skill. Install explicitly into a workspace.",
        SYSTEM_CATALOG_PRINCIPAL_ID, SYSTEM_CATALOG_BUILD_AT,
        JSON.stringify({ defaultPack: true, catalogSourceId: SYSTEM_CATALOG_SOURCE_ID }),
      ]);
      await assertCatalogIntegrity(query, entry);
      return Object.freeze({
        sourceWorkspaceId: SYSTEM_CATALOG_WORKSPACE_ID,
        releaseId: SYSTEM_CATALOG_RELEASE_ID,
        skillId: entry.skillId,
        skillVersionId: SYSTEM_CATALOG_VERSION_ID,
      });
    });
  }

  async installDefaultPack({ workspaceId, installedBy, idempotencyKey, request } = {}) {
    required(workspaceId, "workspace_id_required");
    required(installedBy, "user_id_required");
    required(idempotencyKey, "idempotency_key_required");
    const installation = await this.teamLibraryLifecycle.installRelease({
      releaseId: SYSTEM_CATALOG_RELEASE_ID,
      sourceWorkspaceId: SYSTEM_CATALOG_WORKSPACE_ID,
      minimumRole: "admin",
      idempotencyKey,
      request: request ?? { data: {} },
      workspaceId,
      installedBy,
    });
    return Object.freeze({
      schemaVersion: "workbench-v1",
      sourceWorkspaceId: SYSTEM_CATALOG_WORKSPACE_ID,
      installations: [installation],
    });
  }
}

async function ensureSystemIdentity(query, now) {
  await query(`INSERT INTO public.product_users (
      user_id, schema_version, display_name, created_at, updated_at
    ) VALUES ($1, 'workbench-v1', 'System Catalog', $2::timestamptz, $2::timestamptz)
    ON CONFLICT (user_id) DO NOTHING`, [SYSTEM_CATALOG_PRINCIPAL_ID, now]);
  await query(`INSERT INTO public.product_workspaces (
      workspace_id, schema_version, name, created_by, created_at, updated_at
    ) VALUES ($1, 'workbench-v1', 'System Catalog', $1, $2::timestamptz, $2::timestamptz)
    ON CONFLICT (workspace_id) DO NOTHING`, [SYSTEM_CATALOG_WORKSPACE_ID, now]);
  await query(`INSERT INTO public.workspace_principals (
      workspace_id, principal_id, principal_kind, created_at, updated_at
    ) VALUES ($1, $1, 'system', $2::timestamptz, $2::timestamptz)
    ON CONFLICT (workspace_id, principal_id) DO NOTHING`, [SYSTEM_CATALOG_WORKSPACE_ID, now]);
  await query(`INSERT INTO public.skill_system_catalog_principals (
      principal_id, product_user_id, schema_version, status, created_at, updated_at
    ) VALUES ($1, $1, 'workbench-v1', 'enabled', $2::timestamptz, $2::timestamptz)
    ON CONFLICT (principal_id) DO NOTHING`, [SYSTEM_CATALOG_PRINCIPAL_ID, now]);
  await query(`INSERT INTO public.product_scopes (
      workspace_id, scope_id, schema_version, scope_kind, project_id,
      current_policy_revision_id, created_by_principal_id, created_by_principal_kind,
      creation_mode, created_at, updated_at
    ) VALUES ($1, $1, 'workbench-v1', 'project', $1, $2, $1, 'system',
      'system_initial_seed', $3::timestamptz, $3::timestamptz)
    ON CONFLICT (workspace_id, scope_id) DO NOTHING`, [
    SYSTEM_CATALOG_WORKSPACE_ID, SYSTEM_CATALOG_POLICY_ID, now,
  ]);
  await query(`INSERT INTO public.scope_policy_revisions (
      workspace_id, scope_id, policy_revision_id, revision, observation_tier,
      permission_mode, policy_content_hash, created_by_principal_id,
      created_by_principal_kind, created_at
    ) VALUES ($1, $1, $2, 1, 'observation_disabled', 'interactive', $3, $1, 'system',
      $4::timestamptz)
    ON CONFLICT (workspace_id, scope_id, policy_revision_id) DO NOTHING`, [
    SYSTEM_CATALOG_WORKSPACE_ID, SYSTEM_CATALOG_POLICY_ID, SYSTEM_CATALOG_POLICY_HASH, now,
  ]);
  await query(`INSERT INTO public.scope_principal_grants (
      workspace_id, scope_id, grant_id, principal_id, principal_kind, access_kind,
      can_approve, granted_by_principal_id, granted_by_principal_kind, issuance_kind,
      created_at, updated_at
    ) VALUES ($1, $1, 'system-catalog-initial-grant', $1, 'system', 'operation', true,
      $1, 'system', 'scope_creation', $2::timestamptz, $2::timestamptz)
    ON CONFLICT (workspace_id, grant_id) DO NOTHING`, [SYSTEM_CATALOG_WORKSPACE_ID, now]);
}

async function assertCatalogIntegrity(query, entry) {
  const principal = (await query(`SELECT status FROM public.skill_system_catalog_principals
    WHERE principal_id = $1 FOR SHARE`, [SYSTEM_CATALOG_PRINCIPAL_ID])).rows[0];
  const object = (await query(`SELECT content_hash, state FROM public.product_objects
    WHERE workspace_id = $1 AND object_id = $2 FOR SHARE`, [SYSTEM_CATALOG_WORKSPACE_ID, entry.objectId])).rows[0];
  const asset = (await query(`SELECT scope_id, owner_system_principal_id, lifecycle, latest_published_version_id
    FROM public.skill_assets WHERE workspace_id = $1 AND skill_id = $2 FOR SHARE`, [SYSTEM_CATALOG_WORKSPACE_ID, entry.skillId])).rows[0];
  const source = (await query(`SELECT source_manifest_hash, package_object_id, package_object_hash, package_hash,
      published_version_content_hash, runtime_probe_status, execution_ref, execution_ref_hash, definition
    FROM public.skill_system_catalog_sources
    WHERE workspace_id = $1 AND catalog_source_id = $2 FOR SHARE`, [SYSTEM_CATALOG_WORKSPACE_ID, SYSTEM_CATALOG_SOURCE_ID])).rows[0];
  const version = (await query(`SELECT skill_id, package_object_id, package_object_hash, package_hash, content_hash,
      published_by_system_principal_id, definition
    FROM public.skill_versions WHERE workspace_id = $1 AND skill_version_id = $2 FOR SHARE`, [SYSTEM_CATALOG_WORKSPACE_ID, SYSTEM_CATALOG_VERSION_ID])).rows[0];
  const release = (await query(`SELECT asset_kind, skill_id, skill_version_id, content_hash,
      published_by_system_principal_id, payload
    FROM public.workspace_asset_releases WHERE source_workspace_id = $1 AND release_id = $2 FOR SHARE`, [SYSTEM_CATALOG_WORKSPACE_ID, SYSTEM_CATALOG_RELEASE_ID])).rows[0];
  const valid = principal?.status === "enabled"
    && object?.content_hash === entry.objectHash && object.state === "promoted"
    && asset?.scope_id === SYSTEM_CATALOG_SCOPE_ID
    && asset.owner_system_principal_id === SYSTEM_CATALOG_PRINCIPAL_ID
    && asset.lifecycle === "published" && asset.latest_published_version_id === SYSTEM_CATALOG_VERSION_ID
    && source?.source_manifest_hash === entry.manifestHash
    && source.package_object_id === entry.objectId && source.package_object_hash === entry.objectHash
    && source.package_hash === entry.packageHash && source.published_version_content_hash === entry.versionContentHash
    && source.runtime_probe_status === "ready" && source.execution_ref_hash === entry.executionRefHash
    && sameJson(source.execution_ref, entry.executionRef) && sameJson(source.definition, entry.definition)
    && version?.skill_id === entry.skillId && version.package_object_id === entry.objectId
    && version.package_object_hash === entry.objectHash && version.package_hash === entry.packageHash
    && version.content_hash === entry.versionContentHash
    && version.published_by_system_principal_id === SYSTEM_CATALOG_PRINCIPAL_ID
    && sameJson(version.definition, entry.definition)
    && release?.asset_kind === "skill" && release.skill_id === entry.skillId
    && release.skill_version_id === SYSTEM_CATALOG_VERSION_ID && release.content_hash === entry.versionContentHash
    && release.published_by_system_principal_id === SYSTEM_CATALOG_PRINCIPAL_ID
    && release.payload?.defaultPack === true;
  if (!valid) throw coded("system_catalog_integrity_conflict");
}

function bundledEntry() {
  const source = readFileSync(new URL(
    "../../../../../agent/code/agent-runtime/skills/meeting-action-extractor.md",
    import.meta.url,
  ), "utf8");
  const inspection = inspectSkillPackage({ files: [{ path: "SKILL.md", content: source }] });
  if (inspection.status !== "passed") throw coded("system_catalog_package_invalid");
  const packageBytes = formatSkillPackage([{ path: "SKILL.md", content: source }]);
  const objectHash = hashSkillPackageObject(packageBytes);
  const packageHash = inspection.contentHash;
  const executionRef = structuredClone(MEETING_ACTION_EXTRACTOR_EXECUTION_REF);
  const base = structuredClone(skillDefinitionExample);
  const definition = {
    schemaVersion: "workbench-v1",
    skillVersionId: SYSTEM_CATALOG_VERSION_ID,
    skillId: MEETING_ACTION_EXTRACTOR_SKILL_ID,
    workspaceId: SYSTEM_CATALOG_WORKSPACE_ID,
    version: "1.0.0",
    packageObjectId: objectIdForSkillPackage(objectHash),
    packageHash,
    contentHash: "", // Filled from the immutable semantic payload below.
    manifest: structuredClone(inspection.manifest ?? {}),
    name: "Meeting action extractor",
    description: "Extract explicit follow-up actions from meeting notes without external access.",
    category: base.category,
    inputSchema: structuredClone(MEETING_ACTION_EXTRACTOR_INPUT_SCHEMA),
    outputSchema: structuredClone(MEETING_ACTION_EXTRACTOR_OUTPUT_SCHEMA),
    risk: structuredClone(base.risk),
    dependencies: structuredClone(base.dependencies),
    connectionRequirements: [],
    validation: { validationId: "system-meeting-action-extractor-v1", status: "passed", diagnostics: [], testedAt: SYSTEM_CATALOG_BUILD_AT },
    executionRef,
    publishedBy: SYSTEM_CATALOG_PRINCIPAL_ID,
    publishedAt: SYSTEM_CATALOG_BUILD_AT,
  };
  const versionContentHash = hash({
    packageHash, name: definition.name, description: definition.description,
    executionRef, inputSchema: definition.inputSchema, outputSchema: definition.outputSchema,
  });
  definition.contentHash = versionContentHash;
  if (!Check(SkillVersionSchema, definition)) throw coded("system_catalog_definition_invalid");
  return Object.freeze({
    skillId: MEETING_ACTION_EXTRACTOR_SKILL_ID,
    name: definition.name,
    description: definition.description,
    executionRef,
    executionRefHash: hash(executionRef),
    sourceLocator: "bundled://meeting-action-extractor",
    manifestHash: hash(inspection.manifest ?? {}),
    packageBytes,
    objectId: objectIdForSkillPackage(objectHash),
    objectHash,
    packageHash,
    versionContentHash,
    definition: Object.freeze(definition),
  });
}

function hash(value) { return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`; }
function sameJson(left, right) { return canonicalJson(left) === canonicalJson(right); }
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function iso(value) { const date = new Date(value); if (!Number.isFinite(date.getTime())) throw new TypeError("postgres_system_catalog_clock_invalid"); return date.toISOString(); }
function required(value, code) { if (typeof value !== "string" || !value) throw coded(code); }
function coded(code) { return new ProductStoreError(code, code); }

export const SYSTEM_CATALOG = Object.freeze({
  workspaceId: SYSTEM_CATALOG_WORKSPACE_ID,
  releaseId: SYSTEM_CATALOG_RELEASE_ID,
  sourceId: SYSTEM_CATALOG_SOURCE_ID,
});
