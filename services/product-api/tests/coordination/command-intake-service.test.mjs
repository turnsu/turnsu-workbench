import assert from "node:assert/strict";
import test from "node:test";

import {
  CommandIntakeError,
  CommandIntakeService,
} from "../../src/coordination/command-intake-service.mjs";

const clone = (value) => value === undefined ? undefined : structuredClone(value);
const identityMatches = (command, identity) => (
  command?.commandId === identity.commandId
  && command?.workspaceId === identity.workspaceId
  && command?.userId === identity.userId
);

class MemoryCommandRepository {
  records = new Map();

  async get(identity) {
    const command = this.records.get(identity.commandId);
    return identityMatches(command, identity) ? clone(command) : null;
  }

  async getInternal(commandId) {
    return clone(this.records.get(commandId) ?? null);
  }

  async listRecoverableSkillTests({ limit = 1_000 } = {}) {
    return [...this.records.values()]
      .filter((command) => command.kind === "skill_test"
        && ["accepted", "running", "cancellation_requested"].includes(command.status))
      .slice(0, limit)
      .map(clone);
  }

  async insertAccepted(command) {
    if (this.records.has(command.commandId)) {
      const duplicate = new Error("duplicate_product_command");
      duplicate.code = 11000;
      throw duplicate;
    }
    const accepted = { ...clone(command), status: "accepted", finishedAt: null };
    this.records.set(accepted.commandId, accepted);
    return clone(accepted);
  }

  async compareAndSet(identity, expectedStatuses, patch) {
    const current = this.records.get(identity.commandId);
    if (!identityMatches(current, identity) || !expectedStatuses.includes(current.status)) return null;
    const updated = { ...current, ...clone(patch) };
    this.records.set(identity.commandId, updated);
    return clone(updated);
  }
}

class MemoryStore {
  constructor() {
    this.repositories = { productCommands: new MemoryCommandRepository() };
    this.targets = new Map();
  }

  async withTransaction(work) {
    const commandSnapshot = clone([...this.repositories.productCommands.records]);
    const targetSnapshot = clone([...this.targets]);
    try {
      return await work({ transaction: true });
    } catch (error) {
      this.repositories.productCommands.records = new Map(commandSnapshot);
      this.targets = new Map(targetSnapshot);
      throw error;
    }
  }
}

const principal = { workspaceId: "workspace-a", userId: "user-a" };
const descriptor = (overrides = {}) => ({
  commandId: "command-a",
  kind: "agent_turn",
  sessionId: "session-a",
  turnId: "turn-a",
  ...overrides,
});

const fixture = () => {
  const store = new MemoryStore();
  let tick = 0;
  const service = new CommandIntakeService({
    store,
    now: () => `2026-08-04T00:00:0${tick++}.000Z`,
  });
  return { service, store };
};

test("CommandIntakeService replays only the same principal and immutable command intent", async () => {
  const { service, store } = fixture();
  let targetWrites = 0;
  const persistTarget = async ({ command, session }) => {
    assert.equal(session.transaction, true);
    targetWrites += 1;
    store.targets.set(command.turnId, { turnId: command.turnId });
    return store.targets.get(command.turnId);
  };

  const first = await service.accept({ principal, command: descriptor(), persistTarget });
  const replay = await service.accept({
    principal,
    command: descriptor(),
    persistTarget,
    loadTarget: async ({ command }) => store.targets.get(command.turnId),
  });

  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.command.commandId, first.command.commandId);
  assert.equal(replay.target.turnId, "turn-a");
  assert.equal(targetWrites, 1);
  await assert.rejects(
    service.accept({
      principal: { ...principal, userId: "user-b" },
      command: descriptor(),
      persistTarget,
    }),
    (error) => error.code === 11000,
  );
  await assert.rejects(
    service.accept({ principal, command: descriptor({ turnId: "turn-b" }), persistTarget }),
    (error) => error instanceof CommandIntakeError
      && error.code === "product_command_identity_conflict",
  );
});

test("CommandIntakeService uses CAS for accepted, running, and terminal lifecycle", async () => {
  const { service } = fixture();
  await service.accept({ principal, command: descriptor(), persistTarget: async () => ({}) });
  const running = await service.start({
    principal,
    commandId: "command-a",
    invocationId: "invocation-a",
    attemptId: "attempt-a",
  });
  assert.equal(running.status, "running");
  assert.equal((await service.start({ principal, commandId: "command-a" })).status, "running");

  const completed = await service.settle({ principal, commandId: "command-a", status: "completed" });
  assert.equal(completed.status, "completed");
  assert.ok(completed.finishedAt);
  assert.equal((await service.settle({
    principal,
    commandId: "command-a",
    status: "completed",
  })).finishedAt, completed.finishedAt);
  await assert.rejects(
    service.start({ principal, commandId: "command-a" }),
    (error) => error.code === "product_command_transition_invalid",
  );
});

test("CommandIntakeService resolves repositories lazily and preserves a caller timestamp", async () => {
  const store = {
    repositories: null,
    async withTransaction(work) { return work({ transaction: true }); },
  };
  const service = new CommandIntakeService({ store });
  store.repositories = { productCommands: new MemoryCommandRepository() };
  const at = "2026-08-04T12:34:56.000Z";
  const accepted = await service.accept({
    principal,
    command: descriptor(),
    at,
    persistTarget: async ({ command }) => ({ observedAt: command.updatedAt }),
  });
  assert.equal(accepted.command.createdAt, at);
  assert.equal(accepted.command.updatedAt, at);
  assert.equal(accepted.target.observedAt, at);
  assert.equal((await service.start({ principal, commandId: "command-a", at })).updatedAt, at);
});

test("ordinary accept never revives a terminal command, while explicit recovery methods are visible", async () => {
  const { service } = fixture();
  await service.accept({ principal, command: descriptor(), persistTarget: async () => ({}) });
  await service.start({ principal, commandId: "command-a" });
  const requeued = await service.requeue({ principal, commandId: "command-a" });
  assert.equal(requeued.status, "accepted");
  await service.start({ principal, commandId: "command-a" });
  const failed = await service.settle({ principal, commandId: "command-a", status: "failed" });

  const replay = await service.accept({
    principal,
    command: descriptor(),
    persistTarget: async () => assert.fail("terminal replay must not rewrite target"),
  });
  assert.equal(replay.command.status, "failed");
  assert.equal(replay.command.finishedAt, failed.finishedAt);

  const resumed = await service.resumeExternal({
    principal,
    commandId: "command-a",
    invocationId: "external-invocation-a",
  });
  assert.equal(resumed.status, "running");
  assert.equal(resumed.finishedAt, null);
  assert.equal((await service.recover({ principal, commandId: "command-a" })).status, "running");

  await service.settle({ principal, commandId: "command-a", status: "completed" });
  await assert.rejects(
    service.resumeExternal({ principal, commandId: "command-a" }),
    (error) => error.code === "product_command_transition_invalid",
  );
});

test("recovery inventory and lineage reads stay behind CommandIntakeService", async () => {
  const { service } = fixture();
  await service.accept({
    principal,
    command: descriptor({
      commandId: "skill-test-1",
      kind: "skill_test",
      sessionId: "skill-draft-1",
      turnId: "skill-test-1",
    }),
    persistTarget: async () => ({}),
  });
  await service.accept({
    principal,
    command: descriptor({ commandId: "agent-turn-1" }),
    persistTarget: async () => ({}),
  });

  assert.deepEqual(
    (await service.listRecoverable({ kind: "skill_test" })).map(({ commandId }) => commandId),
    ["skill-test-1"],
  );
  assert.equal((await service.recoverByLineage({
    commandId: "skill-test-1",
    workspaceId: "workspace-a",
    kind: "skill_test",
    sessionId: "skill-draft-1",
    turnId: "skill-test-1",
  })).commandId, "skill-test-1");
  assert.equal(await service.recoverByLineage({
    commandId: "skill-test-1",
    workspaceId: "workspace-a",
    kind: "skill_test",
    sessionId: "another-draft",
    turnId: "skill-test-1",
  }), null);
  assert.throws(
    () => service.listRecoverable({ kind: "workflow_run" }),
    { code: "product_command_recovery_kind_unsupported" },
  );
});

test("command and target persistence share one transaction and roll back together", async () => {
  const { service, store } = fixture();
  await assert.rejects(
    service.accept({
      principal,
      command: descriptor(),
      persistTarget: async ({ command }) => {
        store.targets.set(command.turnId, { turnId: command.turnId });
        throw new Error("target_write_failed");
      },
    }),
    /target_write_failed/,
  );
  assert.equal(store.repositories.productCommands.records.size, 0);
  assert.equal(store.targets.size, 0);
});

test("cancellation intake binds its command to the target and requests cancellation atomically", async () => {
  const { service } = fixture();
  await service.accept({ principal, command: descriptor(), persistTarget: async () => ({}) });
  await service.start({ principal, commandId: "command-a" });

  let observedTarget;
  const accepted = await service.acceptCancellation({
    principal,
    targetCommandId: "command-a",
    command: descriptor({
      commandId: "cancel-command-a",
      kind: "cancel_agent_turn",
      targetCommandId: "command-a",
    }),
    persistTarget: async ({ command, targetCommand }) => {
      observedTarget = targetCommand;
      return { cancellationCommandId: command.commandId };
    },
  });

  assert.equal(accepted.command.targetCommandId, "command-a");
  assert.equal(accepted.command.status, "completed");
  assert.ok(accepted.command.finishedAt);
  assert.equal(accepted.target.cancellationCommandId, "cancel-command-a");
  assert.equal(observedTarget.status, "cancellation_requested");
  assert.equal((await service.recover({ principal, commandId: "command-a" })).status, "cancellation_requested");

  const replay = await service.acceptCancellation({
    principal,
    targetCommandId: "command-a",
    command: descriptor({
      commandId: "cancel-command-a",
      kind: "cancel_agent_turn",
      targetCommandId: "command-a",
    }),
    persistTarget: async () => assert.fail("replay must not rewrite cancellation target"),
    loadTarget: async ({ command, targetCommand }) => ({
      cancellationCommandId: command.commandId,
      targetStatus: targetCommand.status,
    }),
  });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.target, {
    cancellationCommandId: "cancel-command-a",
    targetStatus: "cancellation_requested",
  });
});

test("cancelling an accepted command can settle both the queued target and cancellation command", async () => {
  const { service } = fixture();
  await service.accept({ principal, command: descriptor(), persistTarget: async () => ({}) });

  const accepted = await service.acceptCancellation({
    principal,
    targetCommandId: "command-a",
    targetStatus: "cancelled",
    command: descriptor({
      commandId: "cancel-command-a",
      kind: "cancel_agent_turn",
      targetCommandId: "command-a",
    }),
    persistTarget: async ({ targetCommand }) => ({ targetStatus: targetCommand.status }),
  });

  assert.equal(accepted.command.status, "completed");
  assert.equal(accepted.target.targetStatus, "cancelled");
  const target = await service.recover({ principal, commandId: "command-a" });
  assert.equal(target.status, "cancelled");
  assert.ok(target.finishedAt);
});

test("requestCancellation is the only direct non-terminal cancellation transition", async () => {
  const { service, store } = fixture();
  await service.accept({
    principal,
    command: descriptor({ commandId: "command-cancel-direct" }),
    persistTarget: async () => ({ targetId: "target-cancel-direct" }),
  });
  await service.start({ principal, commandId: "command-cancel-direct" });

  const requested = await service.requestCancellation({
    principal,
    commandId: "command-cancel-direct",
    at: "2026-08-04T10:00:03.000Z",
  });
  assert.equal(requested.status, "cancellation_requested");
  assert.equal(requested.updatedAt, "2026-08-04T10:00:03.000Z");
  assert.equal(
    (await service.requestCancellation({ principal, commandId: "command-cancel-direct" })).status,
    "cancellation_requested",
  );
  await service.settle({ principal, commandId: "command-cancel-direct", status: "cancelled" });
  await assert.rejects(
    service.requestCancellation({ principal, commandId: "command-cancel-direct" }),
    { code: "product_command_transition_invalid" },
  );
  assert.equal(
    store.repositories.productCommands.records.get("command-cancel-direct").status,
    "cancelled",
  );
});
