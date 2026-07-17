import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("single-machine Mongo compose pins image, enables auth, and materializes no credentials in YAML", async () => {
  const compose = await readFile(new URL("../../../../../../docker-compose.yml", import.meta.url), "utf8");
  assert.match(compose, /mongo@sha256:340c1c56fb10e95cf79ff547f8664b96bc6ead9909bc355238cbf865a9695a6f/);
  assert.match(compose, /MONGO_INITDB_ROOT_USERNAME_FILE/);
  assert.match(compose, /MONGO_INITDB_ROOT_PASSWORD_FILE/);
  assert.match(compose, /mongo_replica_key/);
  assert.match(compose, /WORKBENCH_MONGO_BIND_IP:-127\.0\.0\.1/);
  assert.match(compose, /WORKBENCH_MONGO_REPLICA_HOST:-127\.0\.0\.1:27017/);
  assert.match(compose, /WORKBENCH_MONGO_DATA_DIR/);
  assert.doesNotMatch(compose, /MONGO_INITDB_ROOT_PASSWORD:\s*[^/]/);
  assert.doesNotMatch(compose, /image:\s+mongo:7\s*$/m);
});

test("container restore boundary only permits isolated _test targets", async () => {
  const restore = await readFile(new URL("../../../../operations/local/mongo-container/mongo-restore.sh", import.meta.url), "utf8");
  const verify = await readFile(new URL("../../../../operations/local/mongo-container/mongo-verify-restore.sh", import.meta.url), "utf8");
  const summary = await readFile(new URL("../../../../operations/local/mongo-container/mongo-snapshot-summary.sh", import.meta.url), "utf8");
  assert.match(restore, /_test\$/);
  assert.match(restore, /--nsFrom/);
  assert.match(restore, /--nsTo/);
  assert.match(verify, /mongo-snapshot-summary\.sh/);
  assert.match(summary, /execution_events/);
  assert.match(summary, /execution_checkpoints/);
  assert.match(summary, /agent_turns/);
  assert.match(summary, /memory_deletion_tombstones/);
  assert.match(summary, /audit_events/);
});

test("restore summary includes migration ledger and critical index counts", async () => {
  const summary = await readFile(new URL("../../../../operations/local/mongo-container/mongo-snapshot-summary.sh", import.meta.url), "utf8");
  assert.match(summary, /_migrationLedger/);
  assert.match(summary, /product_schema_migrations/);
  assert.match(summary, /_indexCounts/);
  assert.match(summary, /getIndexes/);
});
