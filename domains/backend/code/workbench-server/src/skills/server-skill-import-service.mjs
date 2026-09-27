import { createHash } from "node:crypto";
import {
  lstat,
  readFile,
  readdir,
  realpath,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import { ProductStoreError } from "../store/errors.mjs";
import { inspectSkillPackage } from "../validation/skill-package-inspector.mjs";
import { listLarkToolPoliciesForSkill } from "../tools/lark-tool-policy.mjs";
import {
  formatSkillPackage,
  SKILL_PACKAGE_MEDIA_TYPE,
} from "./skill-package-format.mjs";

const MAX_CANDIDATES = 100;
const MAX_IMPORT_DIRECTORIES = 25;
const MAX_FILES = 256;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_PACKAGE_BYTES = 8 * 1024 * 1024;
const DIRECTORY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BLOCKED_DIRECTORIES = new Set([".git", "node_modules"]);

const defaultFileSystem = Object.freeze({ lstat, readFile, readdir, realpath });
const normalizedName = (value) => String(value ?? "").normalize("NFKC").trim().toLowerCase();
const digest = (value) => createHash("sha256").update(String(value)).digest("hex").slice(0, 20);

function error(code, message, details = {}) {
  return new ProductStoreError(code, message, details);
}

function expandHome(value) {
  const source = String(value ?? "").trim();
  if (source === "~") return homedir();
  if (source.startsWith(`~${sep}`)) return join(homedir(), source.slice(2));
  return source;
}

function containedBy(root, candidate) {
  const value = relative(root, candidate);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function findings(inspection) {
  return inspection.diagnostics.map(({ code, severity, message, path }) => ({
    code,
    severity,
    message,
    ...(path ? { path } : {}),
  }));
}

function injectBuiltInToolPolicy(source, skillName) {
  const policies = listLarkToolPoliciesForSkill(skillName);
  if (policies.length === 0) return source;
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match || /(?:^|\n)tools\s*:/m.test(match[1])) return source;
  const declarations = [
    "tools:",
    ...policies.map((entry) => `  - action: ${entry.action}`),
  ].join("\n");
  return source.replace(match[0], `---\n${match[1]}\n${declarations}\n---\n`);
}

export class ServerSkillImportService {
  constructor({
    allowedRoots,
    store,
    skillUploadService,
    fileSystem = defaultFileSystem,
  } = {}) {
    if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) {
      throw new TypeError("skill_import_roots_required");
    }
    if (
      !store?.connect
      || !store?.authorizeWorkspace
      || !store?.getAuthAccount
      || !store?.createSkill
      || !store?.runIdempotentExternalMutation
    ) {
      throw new TypeError("skill_import_store_required");
    }
    if (
      !skillUploadService?.createUpload
      || !skillUploadService?.inspectUpload
      || !skillUploadService?.promoteUpload
    ) {
      throw new TypeError("skill_import_upload_service_required");
    }
    this.allowedRoots = allowedRoots.map((entry) => resolve(expandHome(entry)));
    this.store = store;
    this.skillUploadService = skillUploadService;
    this.fileSystem = fileSystem;
    this.canonicalRootsPromise = null;
  }

  async scan({ workspaceId, requestedBy, rootPath } = {}) {
    await this.#authorizeAdmin({ workspaceId, requestedBy });
    const root = await this.#authorizedRoot(rootPath);
    const existing = await this.#existingNames(workspaceId);
    const entries = await this.fileSystem.readdir(root, { withFileTypes: true });
    const candidates = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (candidates.length >= MAX_CANDIDATES) break;
      if (!entry.isDirectory() || entry.isSymbolicLink?.() || !DIRECTORY.test(entry.name)) continue;
      try {
        const files = await this.#readSkillDirectory(root, entry.name, { skillFileOnly: true });
        const inspection = inspectSkillPackage({ files });
        const manifest = inspection.manifest;
        if (!manifest?.name || !manifest?.description) continue;
        candidates.push({
          relativeDirectory: entry.name,
          name: manifest.name,
          description: manifest.description,
          status: inspection.status === "failed" ? "invalid" : "ready",
          alreadyExists: existing.has(normalizedName(manifest.name)),
          builtInToolPolicyAvailable: listLarkToolPoliciesForSkill(manifest.name).length > 0,
          findings: findings(inspection),
        });
      } catch (cause) {
        if (cause?.code === "skill_import_package_invalid") continue;
        throw cause;
      }
    }
    return { candidates };
  }

  async import({
    workspaceId,
    requestedBy,
    rootPath,
    directories,
    attachBuiltInToolPolicy = true,
    idempotencyKey,
  } = {}) {
    await this.#authorizeAdmin({ workspaceId, requestedBy });
    if (
      !Array.isArray(directories)
      || directories.length < 1
      || directories.length > MAX_IMPORT_DIRECTORIES
      || new Set(directories).size !== directories.length
      || directories.some((entry) => !DIRECTORY.test(entry))
    ) {
      throw error("skill_import_selection_invalid", "Select valid first-level Skill directories.");
    }
    if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
      throw error("idempotency_key_required", "An idempotency key is required.");
    }
    const root = await this.#authorizedRoot(rootPath);
    return this.store.runIdempotentExternalMutation({
      scope: "server-skill-import",
      key: idempotencyKey,
      request: {
        rootDigest: digest(root),
        directories,
        attachBuiltInToolPolicy,
      },
      workspaceId,
      effectivePrincipalId: requestedBy,
      operationIdKind: "server-skill-import",
      recover: async () => null,
    }, async () => {
      const existing = await this.#existingNames(workspaceId);
      const items = [];
      for (const directory of directories) {
        try {
          let files = await this.#readSkillDirectory(root, directory);
          let inspection = inspectSkillPackage({ files });
          const skillName = inspection.manifest?.name;
          if (attachBuiltInToolPolicy && skillName) {
            files = files.map((file) => file.path === "SKILL.md"
              ? { ...file, content: injectBuiltInToolPolicy(file.content.toString("utf8"), skillName) }
              : file);
            inspection = inspectSkillPackage({ files });
          }
          if (inspection.status === "failed" || !inspection.manifest?.name || !inspection.manifest?.description) {
            items.push({ relativeDirectory: directory, status: "failed", code: "skill_import_package_invalid" });
            continue;
          }
          const nameKey = normalizedName(inspection.manifest.name);
          if (existing.has(nameKey)) {
            items.push({ relativeDirectory: directory, status: "skipped", code: "skill_name_unavailable" });
            continue;
          }
          const suffix = digest(directory);
          const packageBytes = formatSkillPackage(files);
          const upload = await this.skillUploadService.createUpload({
            workspaceId,
            requestedBy,
            idempotencyKey: `${idempotencyKey}:upload:${suffix}`,
            filename: `${basename(directory)}.skill-package`,
            sizeBytes: packageBytes.byteLength,
            mediaType: SKILL_PACKAGE_MEDIA_TYPE,
            ingestMethod: "files",
          });
          const inspected = upload.state === "selecting"
            ? await this.skillUploadService.inspectUpload({
                workspaceId,
                requestedBy,
                uploadId: upload.uploadId,
                idempotencyKey: `${idempotencyKey}:inspect:${suffix}`,
                files,
              })
            : upload;
          if (inspected.state !== "ready_draft") {
            items.push({ relativeDirectory: directory, status: "failed", code: "skill_import_review_required" });
            continue;
          }
          const promoted = await this.skillUploadService.promoteUpload({
            workspaceId,
            requestedBy,
            uploadId: inspected.uploadId,
            idempotencyKey: `${idempotencyKey}:promote:${suffix}`,
          });
          const created = await this.store.createSkill({
            idempotencyKey: `${idempotencyKey}:skill:${suffix}`,
            workspaceId,
            authoredBy: requestedBy,
            request: {
              schemaVersion: "workbench-api-v1",
              data: {
                name: inspection.manifest.name,
                description: inspection.manifest.description,
                category: inspection.manifest.name.startsWith("lark-") ? "lark" : "imported",
                uploadId: promoted.uploadId,
              },
            },
          });
          existing.add(nameKey);
          items.push({
            relativeDirectory: directory,
            status: "imported",
            skillId: created.skill.skillId,
            skillDraftId: created.draft.skillDraftId,
          });
        } catch (cause) {
          items.push({
            relativeDirectory: directory,
            status: "failed",
            code: typeof cause?.code === "string" ? cause.code : "skill_import_failed",
          });
        }
      }
      return { items };
    });
  }

  async #authorizeAdmin({ workspaceId, requestedBy }) {
    await this.store.connect();
    await this.store.authorizeWorkspace({
      userId: requestedBy,
      workspaceId,
      minimumRole: "owner",
    });
    const account = await this.store.getAuthAccount(requestedBy);
    if (account?.role !== "admin" || account.disabled === true) {
      throw error("skill_import_admin_required", "Administrator access is required for server path import.");
    }
  }

  async #canonicalRoots() {
    if (!this.canonicalRootsPromise) {
      this.canonicalRootsPromise = Promise.all(this.allowedRoots.map(async (root) => {
        const canonical = await this.fileSystem.realpath(root);
        const stats = await this.fileSystem.lstat(canonical);
        if (!stats.isDirectory()) throw error("skill_import_root_invalid", "A configured Skill import root is not a directory.");
        return canonical;
      })).catch((cause) => {
        this.canonicalRootsPromise = null;
        throw cause;
      });
    }
    return this.canonicalRootsPromise;
  }

  async #authorizedRoot(rootPath) {
    const requested = expandHome(rootPath);
    if (!isAbsolute(requested)) {
      throw error("skill_import_root_forbidden", "The Skill import root must be an allowed absolute server path.");
    }
    let canonical;
    try {
      canonical = await this.fileSystem.realpath(resolve(requested));
    } catch {
      throw error("skill_import_root_unavailable", "The requested Skill import root is unavailable.");
    }
    const allowed = await this.#canonicalRoots();
    if (!allowed.some((root) => containedBy(root, canonical))) {
      throw error("skill_import_root_forbidden", "The requested Skill import root is outside the server allowlist.");
    }
    return canonical;
  }

  async #existingNames(workspaceId) {
    const [drafts, versions] = await Promise.all([
      this.store.repositories.skillDrafts.list({ workspaceId, limit: 1000 }),
      this.store.repositories.skillVersions.list({ workspaceId, limit: 1000 }),
    ]);
    return new Set([...drafts, ...versions].map((entry) => normalizedName(entry.name)).filter(Boolean));
  }

  async #readSkillDirectory(root, directory, { skillFileOnly = false } = {}) {
    if (!DIRECTORY.test(directory)) {
      throw error("skill_import_selection_invalid", "A Skill directory name is invalid.");
    }
    const directoryPath = join(root, directory);
    let requestedStats;
    try {
      requestedStats = await this.fileSystem.lstat(directoryPath);
    } catch {
      throw error("skill_import_package_invalid", "The selected Skill directory is unavailable.");
    }
    if (requestedStats.isSymbolicLink()) {
      throw error("skill_import_path_forbidden", "Skill directory links and traversal are not allowed.");
    }
    const canonical = await this.fileSystem.realpath(directoryPath);
    if (dirname(canonical) !== root) {
      throw error("skill_import_path_forbidden", "Skill directory links and traversal are not allowed.");
    }
    const stats = await this.fileSystem.lstat(canonical);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw error("skill_import_package_invalid", "The selected Skill path is not a regular directory.");
    }
    if (skillFileOnly) {
      const path = join(canonical, "SKILL.md");
      let skillStats;
      try {
        skillStats = await this.fileSystem.lstat(path);
      } catch {
        throw error("skill_import_package_invalid", "The selected directory has no valid SKILL.md.");
      }
      if (!skillStats.isFile() || skillStats.isSymbolicLink() || skillStats.size > MAX_FILE_BYTES) {
        throw error("skill_import_package_invalid", "The selected directory has no valid SKILL.md.");
      }
      return [{ path: "SKILL.md", content: await this.fileSystem.readFile(path) }];
    }
    const files = [];
    let totalBytes = 0;
    const walk = async (current, prefix = "") => {
      for (const entry of await this.fileSystem.readdir(current, { withFileTypes: true })) {
        if (entry.isSymbolicLink?.()) {
          throw error("skill_import_path_forbidden", "Symbolic links are not allowed in imported Skill packages.");
        }
        if (entry.isDirectory()) {
          if (BLOCKED_DIRECTORIES.has(entry.name)) continue;
          await walk(join(current, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
          continue;
        }
        if (!entry.isFile()) continue;
        const sourcePath = join(current, entry.name);
        const item = await this.fileSystem.lstat(sourcePath);
        if (!item.isFile() || item.isSymbolicLink() || item.size > MAX_FILE_BYTES) {
          throw error("skill_import_package_invalid", "A Skill package file is unsupported.");
        }
        totalBytes += item.size;
        if (files.length >= MAX_FILES || totalBytes > MAX_PACKAGE_BYTES) {
          throw error("skill_import_package_invalid", "The Skill package exceeds product limits.");
        }
        files.push({
          path: prefix ? `${prefix}/${entry.name}` : entry.name,
          content: await this.fileSystem.readFile(sourcePath),
        });
      }
    };
    await walk(canonical);
    if (!files.some((file) => file.path === "SKILL.md")) {
      throw error("skill_import_package_invalid", "The selected directory has no root SKILL.md.");
    }
    return files.sort((left, right) => left.path.localeCompare(right.path));
  }
}

export function createServerSkillImportService(options) {
  return new ServerSkillImportService(options);
}
