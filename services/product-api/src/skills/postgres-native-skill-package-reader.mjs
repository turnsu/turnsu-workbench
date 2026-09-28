import { ProductStoreError } from "../store/errors.mjs";
import { hashSkillPackageObject, parseSkillPackage } from "./skill-package-format.mjs";
import { inspectSkillPackage } from "../validation/skill-package-inspector.mjs";

/** Export the immutable publication, never the author's current private draft. */
export class PostgresNativeSkillPackageReader {
  constructor({ store, objectStore }) {
    this.store = store;
    this.objectStore = objectStore;
    this.sql = store.bindAdapter(({ execute }) => ({ query: (uow, text, values) => execute(uow, { text, values }) }));
  }

  async read({ workspaceId, userId, releaseId }) {
    return this.store.withTransaction(async (uow) => {
      const row = (await this.sql.query(uow, `SELECT release.release_id, release.version_id,
          release.version, release.content_hash, release.dependencies AS release_dependencies,
          version.workspace_id, version.package_object_id, version.package_object_hash,
          version.package_hash, version.definition
        FROM public.workspace_asset_releases release
        JOIN public.skill_versions version ON version.workspace_id = release.source_workspace_id
          AND version.skill_id = release.skill_id AND version.skill_version_id = release.skill_version_id
          AND version.content_hash = release.content_hash
        JOIN public.skill_assets asset ON asset.workspace_id = version.workspace_id AND asset.skill_id = version.skill_id
        JOIN public.product_objects object ON object.workspace_id = version.workspace_id
          AND object.object_id = version.package_object_id AND object.content_hash = version.package_object_hash
        JOIN public.workspace_memberships member ON member.workspace_id = $1 AND member.user_id = $2 AND member.status = 'active'
        WHERE release.release_id = $3 AND release.source_workspace_id IN ($1, 'system-catalog')
          AND release.asset_kind = 'skill' AND release.visibility = 'workspace'
          AND asset.lifecycle <> 'deprecated' AND object.state = 'promoted' AND object.object_kind = 'skill_package'
        FOR SHARE OF release, version, asset, object, member`, [workspaceId, userId, releaseId])).rows[0];
      if (!row) throw coded("release_not_found", "This published Skill is unavailable.");
      const stored = await this.objectStore.read({ workspaceId: row.workspace_id, objectId: row.package_object_id });
      if (stored.object?.state !== "promoted" || stored.object?.contentHash !== row.package_object_hash
        || hashSkillPackageObject(stored.bytes) !== row.package_object_hash) throw coded("skill_package_substituted", "The published package could not be verified.");
      const files = parseSkillPackage(stored.bytes);
      const inspection = inspectSkillPackage({ files });
      if (inspection.status === "failed" || inspection.contentHash !== row.package_hash) throw coded("skill_package_substituted", "The published package could not be verified.");
      const manifest = inspection.manifest;
      if (manifest.runtime || manifest.tools?.length || manifest.dependencies?.length
        || row.definition?.dependencies?.length || row.definition?.connectionRequirements?.length
        || row.release_dependencies?.length || inspection.inventory.some((file) => file.kind === "executable")) {
        throw coded("native_skill_dependencies_unavailable", "This Skill needs a dedicated runtime, tool or connection. Use it in Turnsu until native bindings are available.");
      }
      // Native clients can auto-load plugin metadata. An instruction package must not install it.
      if (files.some((file) => file.path.split("/").some((part) => part.startsWith(".")))) {
        throw coded("native_skill_package_unsupported", "This package contains native configuration requiring separate review.");
      }
      return { releaseId: row.release_id, versionId: row.version_id, version: row.version,
        contentHash: row.content_hash, packageHash: row.package_hash, packageObjectHash: row.package_object_hash,
        skillName: manifest.name, compatibility: manifest.compatibility || null,
        packageContentBase64: stored.bytes.toString("base64") };
    });
  }
}

function coded(code, message) { return new ProductStoreError(code, message); }
