import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const script = fileURLToPath(new URL("../../scripts/migrate-product-store.mjs", import.meta.url));
const node = process.execPath;

test("PostgreSQL migration CLI reports the append-only manifest without a database connection", async () => {
  const { stdout, stderr } = await execute(node, [script, "--print-manifest"], {
    cwd: fileURLToPath(new URL("../../../../domains", import.meta.url)),
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  assert.equal(stderr, "");
  const manifest = JSON.parse(stdout);
  assert.equal(manifest.schemaVersion, "looloomi-postgres-schema-migration-manifest-v1");
  assert.ok(manifest.migrations.some(({ version }) => version === "009_g4_personal_scope_activation"));
  assert.ok(manifest.migrations.every(({ checksum }) => /^sha256:[a-f0-9]{64}$/.test(checksum)));
});

test("PostgreSQL migration CLI dry run never connects and never reveals URL credentials", async () => {
  const url = "postgresql://migration-user:secret@127.0.0.1:1/looloomi_cli_test";
  const { stdout, stderr } = await execute(node, [script, "--dry-run", "--url", url], {
    cwd: fileURLToPath(new URL("../../../../domains", import.meta.url)),
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  assert.equal(stderr, "");
  assert.equal(stdout.includes("secret"), false);
  const result = JSON.parse(stdout);
  assert.equal(result.database, "looloomi_cli_test");
  assert.ok(result.migrations.length >= 9);
});
