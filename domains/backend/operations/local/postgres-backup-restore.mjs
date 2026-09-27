import { spawn } from "node:child_process";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  decryptBackupStream,
  encryptBackupStream,
} from "../../code/workbench-server/src/store/backup-encryption.mjs";
import { ProductPostgresStore } from "../../code/workbench-server/src/store/postgres/product-postgres-store.mjs";

export const POSTGRES_IMAGE = "postgres@sha256:80dee66a0ba95a54d143008143e5d7ef628c0e8d5e0666b39d13c8bac3377953";

const CRITICAL_TABLES = Object.freeze([
  "product_users",
  "product_workspaces",
  "workspace_memberships",
  "product_scopes",
  "agent_sessions",
  "agent_turns",
  "workflows",
  "workflow_runs",
  "product_commands",
  "execution_invocations",
  "memory_candidates",
  "durable_memories",
]);

export function parsePostgresConnection(connectionString) {
  if (typeof connectionString !== "string" || connectionString.trim() === "") {
    throw coded("workbench_postgres_url_required");
  }
  let url;
  try { url = new URL(connectionString); }
  catch { throw coded("workbench_postgres_url_invalid"); }
  if (!/^postgres(?:ql)?:$/i.test(url.protocol)) throw coded("workbench_postgres_url_invalid");
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  if (!database || database.includes("/")) throw coded("postgres_database_required");
  if (!url.hostname || !url.username) throw coded("postgres_connection_identity_required");
  return Object.freeze({
    database,
    host: url.hostname,
    port: url.port || "5432",
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    sslmode: url.searchParams.get("sslmode") || "prefer",
  });
}

export function assertRestoreTarget(connectionString, objectTargetRoot) {
  const connection = parsePostgresConnection(connectionString);
  if (!connection.database.endsWith("_restore_test")) {
    throw coded("postgres_restore_target_must_end_restore_test");
  }
  if (typeof objectTargetRoot !== "string" || !basename(objectTargetRoot).endsWith("_restore_test")) {
    throw coded("object_restore_target_must_end_restore_test");
  }
  return connection;
}

export async function createPostgresBackup({
  connectionString,
  objectStoreRoot,
  backupSetDirectory,
  encryptionKey,
  clock = () => new Date().toISOString(),
  spawnTool = spawn,
  snapshot = postgresSnapshot,
} = {}) {
  const connection = parsePostgresConnection(connectionString);
  const key = normalizedKey(encryptionKey);
  const objectInfo = await stat(objectStoreRoot).catch(() => null);
  if (!objectInfo?.isDirectory()) throw coded("object_store_root_unavailable");
  await ensureEmptyDirectory(backupSetDirectory);
  const temporary = await mkdtemp(join(tmpdir(), "looloomi-postgres-backup-"));
  const dump = join(temporary, "product.dump");
  const objects = join(temporary, "objects.tar");
  try {
    await runTool({
      command: process.env.WORKBENCH_PG_DUMP ?? "pg_dump",
      args: [
        "--format=custom", "--no-owner", "--no-privileges", "--file", dump,
        "--dbname", connection.database,
      ],
      env: postgresToolEnvironment(connection),
      spawnTool,
      failureCode: "postgres_backup_dump_failed",
    });
    await runTool({
      command: process.env.WORKBENCH_TAR ?? "tar",
      args: ["-C", objectStoreRoot, "-cf", objects, "."],
      spawnTool,
      failureCode: "object_store_snapshot_failed",
    });
    const [sourceSnapshot, dumpHash, objectHash] = await Promise.all([
      snapshot(connectionString),
      fileHash(dump),
      fileHash(objects),
    ]);
    const databaseArchive = "postgres.dump.lbkp";
    const objectArchive = "objects.tar.lbkp";
    await Promise.all([
      encryptBackupStream({
        source: createReadStream(dump),
        destination: join(backupSetDirectory, databaseArchive),
        key,
      }),
      encryptBackupStream({
        source: createReadStream(objects),
        destination: join(backupSetDirectory, objectArchive),
        key,
      }),
    ]);
    const unsigned = {
      schemaVersion: "looloomi-postgres-backup-set-v1",
      createdAt: iso(clock()),
      sourceDatabase: connection.database,
      sourceSnapshot,
      components: {
        database: { file: databaseArchive, plaintextHash: dumpHash, format: "pg_dump-custom" },
        objects: { file: objectArchive, plaintextHash: objectHash, format: "tar" },
      },
    };
    const manifest = {
      ...unsigned,
      integrity: {
        algorithm: "HMAC-SHA256",
        value: `sha256:${createHmac("sha256", key).update(canonicalJson(unsigned)).digest("hex")}`,
      },
    };
    await writeFile(
      join(backupSetDirectory, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600, flag: "wx" },
    );
    return Object.freeze({ backupSetDirectory, manifest: Object.freeze(manifest) });
  } catch (error) {
    await rm(backupSetDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    key.fill(0);
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function restorePostgresBackup({
  backupSetDirectory,
  targetConnectionString,
  objectTargetRoot,
  encryptionKey,
  spawnTool = spawn,
  snapshot = postgresSnapshot,
} = {}) {
  const connection = assertRestoreTarget(targetConnectionString, objectTargetRoot);
  const key = normalizedKey(encryptionKey);
  const manifest = JSON.parse(await readFile(join(backupSetDirectory, "manifest.json"), "utf8"));
  verifyManifest(manifest, key);
  if (manifest.sourceDatabase === connection.database) throw coded("postgres_restore_source_target_same");
  await ensureEmptyDirectory(objectTargetRoot);
  const temporary = await mkdtemp(join(tmpdir(), "looloomi-postgres-restore-"));
  const dump = join(temporary, "product.dump");
  const objects = join(temporary, "objects.tar");
  try {
    await decryptToFile({
      source: join(backupSetDirectory, manifest.components.database.file),
      destination: dump,
      key,
    });
    await decryptToFile({
      source: join(backupSetDirectory, manifest.components.objects.file),
      destination: objects,
      key,
    });
    const [dumpHash, objectHash] = await Promise.all([fileHash(dump), fileHash(objects)]);
    if (dumpHash !== manifest.components.database.plaintextHash
      || objectHash !== manifest.components.objects.plaintextHash) {
      throw coded("backup_component_hash_mismatch");
    }
    await runTool({
      command: process.env.WORKBENCH_PG_RESTORE ?? "pg_restore",
      args: [
        "--clean", "--if-exists", "--no-owner", "--no-privileges", "--exit-on-error",
        "--dbname", connection.database, dump,
      ],
      env: postgresToolEnvironment(connection),
      spawnTool,
      failureCode: "postgres_restore_failed",
    });
    await runTool({
      command: process.env.WORKBENCH_TAR ?? "tar",
      args: ["-C", objectTargetRoot, "-xf", objects],
      spawnTool,
      failureCode: "object_store_restore_failed",
    });
    const restoredSnapshot = await snapshot(targetConnectionString);
    if (canonicalJson(restoredSnapshot) !== canonicalJson(manifest.sourceSnapshot)) {
      throw coded("postgres_restore_semantic_mismatch");
    }
    return Object.freeze({
      restored: true,
      isolated: true,
      targetDatabase: connection.database,
      sourceSnapshot: manifest.sourceSnapshot,
      restoredSnapshot,
    });
  } catch (error) {
    await rm(objectTargetRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    key.fill(0);
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function postgresSnapshot(connectionString) {
  const store = new ProductPostgresStore({ poolOptions: { connectionString } });
  try {
    await store.connect();
    const readiness = store.createOperationalReadiness();
    const migrationCheck = await readiness.verifyMigrations();
    if (migrationCheck.ok !== true) throw coded("postgres_migration_ledger_invalid");
    const adapter = store.bindAdapter(({ execute }) => Object.freeze({
      query: (uow, text, values = []) => execute(uow, { text, values }),
    }));
    return store.withTransaction(async (uow) => {
      const migrations = (await adapter.query(uow, `
        SELECT version, checksum FROM public.product_schema_migrations
         WHERE status = 'applied' ORDER BY version ASC
      `)).rows.map((row) => ({ version: row.version, checksum: row.checksum }));
      const tableCounts = {};
      for (const table of CRITICAL_TABLES) {
        const row = (await adapter.query(uow, `SELECT count(*)::text AS count FROM public.${table}`)).rows[0];
        tableCounts[table] = Number(row?.count ?? 0);
      }
      const value = { migrations, tableCounts };
      return Object.freeze({
        ...value,
        checksum: `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`,
      });
    });
  } finally {
    await store.close();
  }
}

export async function assertPostgresTools({ spawnTool = spawn } = {}) {
  await runTool({
    command: process.env.WORKBENCH_PG_DUMP ?? "pg_dump",
    args: ["--version"],
    spawnTool,
    failureCode: "pg_dump_unavailable",
  });
  await runTool({
    command: process.env.WORKBENCH_PG_RESTORE ?? "pg_restore",
    args: ["--version"],
    spawnTool,
    failureCode: "pg_restore_unavailable",
  });
  return { available: true };
}

function postgresToolEnvironment(connection) {
  return {
    ...process.env,
    PGHOST: connection.host,
    PGPORT: connection.port,
    PGUSER: connection.user,
    PGPASSWORD: connection.password,
    PGDATABASE: connection.database,
    PGSSLMODE: connection.sslmode,
  };
}

function runTool({ command, args, env = process.env, spawnTool, failureCode }) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawnTool(command, args, { env, stdio: ["ignore", "ignore", "inherit"] });
    child.once("error", () => rejectRun(coded(failureCode)));
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(coded(failureCode, { code, signal }));
    });
  });
}

async function decryptToFile({ source, destination, key }) {
  const output = createWriteStream(destination, { mode: 0o600, flags: "wx" });
  try {
    await decryptBackupStream({ source, destination: output, key });
    await chmod(destination, 0o600);
  } catch (error) {
    output.destroy();
    await rm(destination, { force: true }).catch(() => {});
    throw error;
  }
}

async function ensureEmptyDirectory(path) {
  if (typeof path !== "string" || path.length === 0) throw coded("backup_directory_required");
  const entries = await readdir(path).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (entries && entries.length > 0) throw coded("backup_directory_not_empty");
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function fileHash(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

function verifyManifest(manifest, key) {
  if (manifest?.schemaVersion !== "looloomi-postgres-backup-set-v1"
    || manifest.integrity?.algorithm !== "HMAC-SHA256"
    || typeof manifest.integrity.value !== "string") throw coded("backup_manifest_invalid");
  const { integrity, ...unsigned } = manifest;
  const expected = Buffer.from(createHmac("sha256", key).update(canonicalJson(unsigned)).digest("hex"), "hex");
  const actualHex = integrity.value.replace(/^sha256:/, "");
  if (!/^[a-f0-9]{64}$/.test(actualHex)) throw coded("backup_manifest_invalid");
  const actual = Buffer.from(actualHex, "hex");
  if (!timingSafeEqual(actual, expected)) throw coded("backup_manifest_authentication_failed");
}

function normalizedKey(value) {
  const key = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(String(value ?? ""), "base64");
  if (key.length !== 32) throw coded("backup_key_invalid");
  return key;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function iso(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw coded("backup_clock_invalid");
  return date.toISOString();
}

function coded(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  error.productSafe = true;
  return error;
}
