import process from "node:process";

import { MongoClient } from "mongodb";

import {
  backfillDefaultWorkspaceMigration,
  ProductMigrationRunner,
  runnerTerminalTransitionsMigration,
} from "../src/store/migrations/index.mjs";

const args = new Set(process.argv.slice(2));
const dbName = valueAfter("--db");
const dryRun = args.has("--dry-run");
const confirmed = args.has("--confirm-write");
const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/?replicaSet=rs0";

if (!dbName) {
  fail("migration_db_required", "Pass --db <database>; write mode is limited to explicit _test databases or --confirm-write.");
}
if (!dryRun && !dbName.endsWith("_test") && !confirmed) {
  fail("migration_write_confirmation_required", "Write mode requires a _test database or --confirm-write.");
}

const client = new MongoClient(uri);
try {
  await client.connect();
  const runner = new ProductMigrationRunner({
    db: client.db(dbName),
    migrations: [backfillDefaultWorkspaceMigration, runnerTerminalTransitionsMigration],
  });
  const result = await runner.run({
    dryRun,
    context: {
      defaultWorkspaceId: process.env.WORKBENCH_DEFAULT_WORKSPACE_ID || "workspace-local",
      defaultOwnerId: process.env.WORKBENCH_DEFAULT_OWNER_ID || "user-local",
    },
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await client.close();
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] || null : null;
}

function fail(code, message) {
  process.stderr.write(`${JSON.stringify({ code, message })}\n`);
  process.exitCode = 2;
  throw new Error(message);
}
