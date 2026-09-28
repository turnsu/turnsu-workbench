import assert from "node:assert/strict";

const requireContext = (context) => {
  assert.equal(typeof context?.principal?.workspaceId, "string");
  assert.equal(typeof context?.principal?.userId, "string");
  assert.equal(typeof context?.ids, "function");
  assert.equal(typeof context?.backup?.seedSkill, "function");
  assert.equal(typeof context?.backup?.readSkill, "function");
  assert.equal(typeof context?.backup?.assertAvailable, "function");
  assert.equal(typeof context?.backup?.backup, "function");
  assert.equal(typeof context?.backup?.assertAuthenticationFailure, "function");
  assert.equal(typeof context?.backup?.restoreIsolated, "function");
  return context;
};

const runBackupRestore = async (rawContext) => {
  const { ids, backup } = requireContext(rawContext);
  await backup.assertAvailable();
  const skillId = ids("backup-skill");
  const draftId = ids("backup-draft");
  await backup.seedSkill({
    idempotencyKey: ids("backup-create-skill-command"), skillId, draftId,
    name: "Backup restore characterization",
    description: "A controlled Product record used to prove semantic restore.",
  });
  const before = await backup.readSkill({ skillId, draftId });

  const archive = await backup.backup();
  assert.equal(archive?.encryption?.algorithm, "AES-256-GCM");
  assert.equal(archive?.encryption?.format, "looloomi-backup-v1");
  assert.equal(archive?.encryption?.authenticated, true);
  assert.equal(await backup.assertAuthenticationFailure({ handle: archive.handle }), true);

  const restored = await backup.restoreIsolated({ handle: archive.handle });
  assert.equal(typeof restored?.readSkill, "function");
  assert.equal(restored?.isolated, true);
  assert.equal(restored?.verification?.verified, true);
  assert.equal(restored?.verification?.algorithm, "AES-256-GCM");
  assert.equal(restored?.verification?.format, "looloomi-backup-v1");
  try {
    const after = await restored.readSkill({ skillId, draftId });
    assert.deepEqual(after, before);

    return {
      result: {
        status: "passed",
        backupEncrypted: true,
        restoreVerified: true,
      },
      errors: [],
      state: { before, after },
      events: [
        { sequence: 1, type: "product_seed_completed", status: "completed" },
        { sequence: 2, type: "encrypted_backup_completed", status: "completed" },
        { sequence: 3, type: "isolated_restore_completed", status: "completed" },
        { sequence: 4, type: "semantic_readback_completed", status: "completed" },
      ],
      invariants: {
        backupSourceIsSelfSeededProductData: true,
        backupUsesStoreOwnedDriver: true,
        backupArchiveIsAuthenticatedAndEncrypted: true,
        backupAuthenticationRejectsTampering: true,
        restoreTargetsAnIsolatedStore: true,
        restoredProductStateMatchesSemanticReadback: true,
      },
    };
  } finally {
    await restored.dispose?.();
  }
}

export const scenarios = [
  { id: "store.backup-restore", run: runBackupRestore },
];
