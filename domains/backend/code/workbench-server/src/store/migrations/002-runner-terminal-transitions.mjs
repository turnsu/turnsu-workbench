import { collectionDigest, defineMigration } from "./migration-runner.mjs";

const TERMINAL = ["completed", "failed", "cancelled"];

export const runnerTerminalTransitionsMigration = defineMigration({
  version: "002-runner-terminal-transitions",
  description: "Create deterministic terminal transition markers for legacy durable Runs.",
  async inspect({ db }) {
    return {
      terminalRuns: await collectionDigest(db.collection("runs"), {
        filter: { status: { $in: TERMINAL } },
        idField: "runId",
      }),
      terminalTransitions: await collectionDigest(db.collection("run_terminal_transitions"), {
        idField: "terminalTransitionId",
      }),
    };
  },
  async apply({ db, clock }) {
    const runs = await db.collection("runs").find(
      { status: { $in: TERMINAL } },
      { projection: { runId: 1, status: 1, finishedAt: 1, updatedAt: 1 } },
    ).toArray();
    let inserted = 0;
    let existing = 0;
    let skippedWithoutTerminalEvent = 0;
    for (const run of runs) {
      const logicalEventId = `terminal:${run.runId}:${run.status}`;
      const marker = await db.collection("run_terminal_transitions").findOne({ runId: run.runId });
      if (marker) {
        existing += 1;
        continue;
      }
      const event = await db.collection("run_events").findOne(
        { runId: run.runId, type: `run.${run.status}` },
        { sort: { sequence: 1 } },
      );
      if (!event) {
        skippedWithoutTerminalEvent += 1;
        continue;
      }
      const result = await db.collection("run_terminal_transitions").updateOne(
        { runId: run.runId },
        {
          $setOnInsert: {
            schemaVersion: "workbench-v1",
            terminalTransitionId: logicalEventId,
            logicalEventId,
            runId: run.runId,
            status: run.status,
            eventId: event.eventId,
            checkpointId: null,
            committedAt: run.finishedAt ?? run.updatedAt ?? clock().toISOString(),
          },
        },
        { upsert: true },
      );
      inserted += result.upsertedCount ?? 0;
    }
    return { inserted, existing, skippedWithoutTerminalEvent };
  },
});
