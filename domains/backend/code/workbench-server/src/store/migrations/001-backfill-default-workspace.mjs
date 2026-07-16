import { collectionDigest, defineMigration } from "./migration-runner.mjs";

export const LEGACY_PRODUCT_COLLECTIONS = Object.freeze([
  "skills",
  "templates",
  "workflows",
  "workflow_revisions",
  "compile_results",
  "execution_plans",
  "runs",
  "run_node_attempts",
  "run_events",
  "run_read_models",
  "review_decisions",
  "idempotency_records",
  "audit_events",
]);

export const backfillDefaultWorkspaceMigration = defineMigration({
  version: "001-backfill-default-workspace",
  description: "Backfill legacy Product records into one private workspace without replacing existing tenant values.",
  async inspect({ db }) {
    const collections = {};
    for (const name of LEGACY_PRODUCT_COLLECTIONS) {
      const collection = db.collection(name);
      const all = await collectionDigest(collection);
      const missingWorkspace = await collection.countDocuments({ workspaceId: { $exists: false } });
      collections[name] = { ...all, missingWorkspace };
    }
    return { collections };
  },
  async apply({ db, defaultWorkspaceId = "workspace-local", defaultOwnerId = "user-local", clock }) {
    const now = clock().toISOString();
    await db.collection("product_users").updateOne(
      { userId: defaultOwnerId },
      {
        $setOnInsert: {
          schemaVersion: "workbench-v1",
          userId: defaultOwnerId,
          displayName: "Local owner",
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true },
    );
    await db.collection("product_workspaces").updateOne(
      { workspaceId: defaultWorkspaceId },
      {
        $setOnInsert: {
          schemaVersion: "workbench-v1",
          workspaceId: defaultWorkspaceId,
          name: "Private workspace",
          createdBy: defaultOwnerId,
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true },
    );
    await db.collection("workspace_memberships").updateOne(
      { workspaceId: defaultWorkspaceId, userId: defaultOwnerId },
      {
        $setOnInsert: {
          schemaVersion: "workbench-v1",
          membershipId: `membership-${defaultWorkspaceId}-${defaultOwnerId}`,
          workspaceId: defaultWorkspaceId,
          userId: defaultOwnerId,
          role: "owner",
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true },
    );

    const results = {};
    for (const name of LEGACY_PRODUCT_COLLECTIONS) {
      const update = await db.collection(name).updateMany(
        { workspaceId: { $exists: false } },
        { $set: { workspaceId: defaultWorkspaceId } },
      );
      results[name] = { workspaceBackfilled: update.modifiedCount ?? 0 };
    }
    for (const name of ["skills", "workflows"]) {
      const update = await db.collection(name).updateMany(
        { ownerId: { $exists: false } },
        { $set: { ownerId: defaultOwnerId } },
      );
      results[name].ownerBackfilled = update.modifiedCount ?? 0;
    }
    const templateProjection = await db.collection("templates").updateMany(
      { lifecycleProjection: { $exists: false } },
      { $set: { lifecycleProjection: "pending" } },
    );
    results.templates.lifecycleProjectionPending = templateProjection.modifiedCount ?? 0;
    return { defaultWorkspaceId, defaultOwnerId, collections: results };
  },
});
