import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

import { POSTGRES_MIGRATIONS } from "../../code/workbench-server/src/store/postgres/migrations/index.mjs";
import { POSTGRES_IMAGE } from "./postgres-backup-restore.mjs";

const execFile = promisify(execFileCallback);

export async function createPostgresReleaseManifest({ repositoryRoot, clock = () => new Date().toISOString() } = {}) {
  if (typeof repositoryRoot !== "string" || repositoryRoot.length === 0) {
    throw new TypeError("release_repository_root_required");
  }
  const [head, status, migrations] = await Promise.all([
    git(repositoryRoot, ["rev-parse", "HEAD"]),
    git(repositoryRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    migrationManifest(),
  ]);
  const candidate = {
    head: head.trim(),
    statusDigest: digest(Buffer.from(status, "utf8")),
    dirty: status.length > 0,
  };
  return Object.freeze({
    schemaVersion: "looloomi-postgres-release-v1",
    createdAt: new Date(clock()).toISOString(),
    database: {
      authority: "postgresql",
      image: POSTGRES_IMAGE,
      migrationMode: "before-traffic",
      fallback: false,
      migrations,
    },
    candidate,
  });
}

export async function writePostgresReleaseManifest({ repositoryRoot, outputFile, clock } = {}) {
  const manifest = await createPostgresReleaseManifest({ repositoryRoot, clock });
  await mkdir(dirname(outputFile), { recursive: true, mode: 0o700 });
  await writeFile(outputFile, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return manifest;
}

export async function validatePostgresReleaseManifest({ repositoryRoot, manifestFile } = {}) {
  const expected = JSON.parse(await readFile(manifestFile, "utf8"));
  if (expected?.schemaVersion !== "looloomi-postgres-release-v1"
    || expected.database?.authority !== "postgresql"
    || expected.database?.fallback !== false
    || expected.database?.image !== POSTGRES_IMAGE) {
    throw coded("postgres_release_manifest_invalid");
  }
  const current = await createPostgresReleaseManifest({ repositoryRoot });
  if (expected.candidate?.head !== current.candidate.head
    || expected.candidate?.statusDigest !== current.candidate.statusDigest
    || canonicalJson(expected.database.migrations) !== canonicalJson(current.database.migrations)) {
    throw coded("postgres_release_candidate_changed");
  }
  return Object.freeze({ valid: true, manifest: expected });
}

async function migrationManifest() {
  return Promise.all(POSTGRES_MIGRATIONS.map(async ({ version, description, sql, loadSql }) => {
    const source = sql ?? await loadSql();
    return Object.freeze({ version, description, checksum: digest(Buffer.from(source, "utf8")) });
  }));
}

async function git(cwd, args) {
  const { stdout } = await execFile("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function coded(code) {
  const error = new Error(code);
  error.code = code;
  error.productSafe = true;
  return error;
}
