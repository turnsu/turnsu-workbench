import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ServerSkillImportService } from "../../src/skills/server-skill-import-service.mjs";
import { inspectSkillPackage } from "../../src/validation/skill-package-inspector.mjs";

const larkSkill = (name = "lark-calendar") => `---
name: ${name}
version: 1.0.0
description: Read calendar events and create an event after confirmation.
metadata:
  requires:
    bins: ["lark-cli"]
  cliHelp: "lark-cli calendar --help"
---

# Calendar
`;

function setupStore({ role = "admin", drafts = [] } = {}) {
  const created = [];
  return {
    created,
    externalIdempotencyOptions: [],
    async connect() {},
    async authorizeWorkspace({ minimumRole }) {
      assert.equal(minimumRole, "owner");
      return { role: "owner" };
    },
    async getAuthAccount() {
      return { userId: "user-owner", role, disabled: false };
    },
    async runIdempotentExternalMutation(options, mutation) {
      this.externalIdempotencyOptions.push({
        scope: options.scope,
        effectivePrincipalId: options.effectivePrincipalId,
      });
      return mutation("server-skill-import-operation");
    },
    repositories: {
      skillDrafts: { async list() { return drafts; } },
      skillVersions: { async list() { return []; } },
    },
    async createSkill(input) {
      created.push(input);
      return {
        skill: { skillId: `skill-${created.length}` },
        draft: { skillDraftId: `skill-draft-${created.length}` },
      };
    },
  };
}

function setupUploadService() {
  const inspectedFiles = [];
  return {
    inspectedFiles,
    async createUpload() {
      return { uploadId: "upload-1", state: "selecting" };
    },
    async inspectUpload({ uploadId, files }) {
      inspectedFiles.push(files);
      const inspection = inspectSkillPackage({ files });
      assert.equal(inspection.status, "passed");
      return { uploadId, state: "ready_draft", inspection };
    },
    async promoteUpload({ uploadId }) {
      return { uploadId, state: "promoted" };
    },
  };
}

test("admin scan/import stays inside the allowlisted server root and attaches exact Lark actions", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "looloomi-skill-import-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const calendar = join(root, "lark-calendar");
  await mkdir(join(calendar, "references"), { recursive: true });
  await writeFile(join(calendar, "SKILL.md"), larkSkill());
  await writeFile(join(calendar, "references", "agenda.md"), "Read only the requested date.");
  const store = setupStore();
  const uploads = setupUploadService();
  const service = new ServerSkillImportService({
    allowedRoots: [root],
    store,
    skillUploadService: uploads,
  });

  const scan = await service.scan({
    workspaceId: "workspace-local",
    requestedBy: "user-owner",
    rootPath: root,
  });
  assert.deepEqual(scan.candidates.map((entry) => ({
    directory: entry.relativeDirectory,
    status: entry.status,
    tools: entry.builtInToolPolicyAvailable,
  })), [{ directory: "lark-calendar", status: "ready", tools: true }]);

  const imported = await service.import({
    workspaceId: "workspace-local",
    requestedBy: "user-owner",
    rootPath: root,
    directories: ["lark-calendar"],
    idempotencyKey: "idem-server-import-1",
  });
  assert.deepEqual(imported.items, [{
    relativeDirectory: "lark-calendar",
    status: "imported",
    skillId: "skill-1",
    skillDraftId: "skill-draft-1",
  }]);
  const skillSource = await readFile(join(calendar, "SKILL.md"), "utf8");
  assert.equal(skillSource.includes("\ntools:"), false, "source directory remains unchanged");
  const importedSource = uploads.inspectedFiles[0]
    .find((file) => file.path === "SKILL.md").content.toString("utf8");
  assert.match(importedSource, /action: lark\.calendar\.agenda/);
  assert.match(importedSource, /action: lark\.calendar\.create/);
  assert.equal(store.created[0].request.data.uploadId, "upload-1");
  assert.equal(store.externalIdempotencyOptions[0].effectivePrincipalId, "user-owner");
});

test("server path import rejects members, traversal, and directory symlinks", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "looloomi-skill-import-root-"));
  const outside = await mkdtemp(join(tmpdir(), "looloomi-skill-import-outside-"));
  context.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  await mkdir(join(outside, "lark-calendar"));
  await writeFile(join(outside, "lark-calendar", "SKILL.md"), larkSkill());
  await symlink(join(outside, "lark-calendar"), join(root, "linked-calendar"));

  const memberService = new ServerSkillImportService({
    allowedRoots: [root],
    store: setupStore({ role: "member" }),
    skillUploadService: setupUploadService(),
  });
  await assert.rejects(
    () => memberService.scan({
      workspaceId: "workspace-local",
      requestedBy: "user-member",
      rootPath: root,
    }),
    { code: "skill_import_admin_required" },
  );

  const adminService = new ServerSkillImportService({
    allowedRoots: [root],
    store: setupStore(),
    skillUploadService: setupUploadService(),
  });
  await assert.rejects(
    () => adminService.scan({
      workspaceId: "workspace-local",
      requestedBy: "user-owner",
      rootPath: outside,
    }),
    { code: "skill_import_root_forbidden" },
  );
  const result = await adminService.import({
    workspaceId: "workspace-local",
    requestedBy: "user-owner",
    rootPath: root,
    directories: ["linked-calendar"],
    idempotencyKey: "idem-server-import-symlink",
  });
  assert.deepEqual(result.items, [{
    relativeDirectory: "linked-calendar",
    status: "failed",
    code: "skill_import_path_forbidden",
  }]);
});
