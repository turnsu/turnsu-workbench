import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  POSTGRES_IMAGE,
  assertRestoreTarget,
  parsePostgresConnection,
} from "../../../../operations/local/postgres-backup-restore.mjs";

test("local compose pins PostgreSQL, uses a password file, and binds only loopback", async () => {
  const compose = await readFile(new URL("../../../../../../docker-compose.yml", import.meta.url), "utf8");
  assert.match(compose, new RegExp(POSTGRES_IMAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(compose, /POSTGRES_PASSWORD_FILE:\s*\/run\/secrets\/postgres_password/);
  assert.match(compose, /WORKBENCH_POSTGRES_BIND_IP:-127\.0\.0\.1/);
  assert.match(compose, /WORKBENCH_POSTGRES_DATA_DIR/);
  assert.match(compose, /pg_isready/);
  assert.doesNotMatch(compose, /POSTGRES_PASSWORD:\s*[^$]/);
  assert.doesNotMatch(compose, /mongo/i);
});

test("startup requires a PostgreSQL DSN and migrates before accepting traffic", async () => {
  const root = new URL("../../../../../../", import.meta.url);
  const [script, environment] = await Promise.all([
    readFile(new URL("scripts/start-workbench-server.sh", root), "utf8"),
    readFile(new URL(".env.example", root), "utf8"),
  ]);
  assert.match(script, /workbench_postgres_url_missing/);
  assert.match(script, /migrate-product-store\.mjs/);
  assert.ok(script.indexOf("migrate-product-store.mjs") < script.indexOf("exec \"$NODE_BIN\""));
  assert.match(script, /bin\/workbench-server\.mjs/);
  assert.doesNotMatch(script, /ENTRYPOINT=.*src\/server\.mjs/);
  assert.match(script, /WORKBENCH_MANAGED_POSTGRES/);
  assert.match(script, /WORKBENCH_ENV_FILE/);
  assert.doesNotMatch(script, /mongo/i);
  for (const variable of [
    "WORKBENCH_POSTGRES_DATA_DIR",
    "WORKBENCH_POSTGRES_URL",
    "WORKBENCH_SECRETS_DIR",
    "WORKBENCH_REGISTRATION_OPEN",
    "WORKBENCH_BOOTSTRAP_ADMIN_TOKEN",
    "WORKBENCH_SKILL_IMPORT_ROOTS",
  ]) {
    assert.match(environment, new RegExp(`^${variable}=`, "m"));
  }
  assert.doesNotMatch(environment, /MONGODB|WORKBENCH_MONGO/);
});

test("PostgreSQL restore accepts only explicit database and object _restore_test targets", () => {
  const target = "postgresql://operator:secret@127.0.0.1:5432/looloomi_restore_test?sslmode=disable";
  assert.equal(parsePostgresConnection(target).database, "looloomi_restore_test");
  assert.equal(assertRestoreTarget(target, "/private/tmp/objects_restore_test").database, "looloomi_restore_test");
  assert.throws(
    () => assertRestoreTarget(
      "postgresql://operator:secret@127.0.0.1:5432/looloomi",
      "/private/tmp/objects_restore_test",
    ),
    /postgres_restore_target_must_end_restore_test/,
  );
  assert.throws(
    () => assertRestoreTarget(target, "/private/tmp/objects"),
    /object_restore_target_must_end_restore_test/,
  );
});
