const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "blocked"]);
const SETTLE_FROM = ["accepted", "running", "cancellation_requested"];

const requiredString = (value, code) => {
  if (typeof value !== "string" || value.length === 0) throw new CommandIntakeError(code);
  return value;
};

const principalIdentity = (principal, commandId) => ({
  workspaceId: requiredString(principal?.workspaceId, "product_command_workspace_required"),
  userId: requiredString(principal?.userId, "product_command_user_required"),
  commandId: requiredString(commandId, "product_command_id_required"),
});

const commandIntent = (principal, command, targetCommandId = command?.targetCommandId) => ({
  schemaVersion: command?.schemaVersion ?? "workbench-v1",
  ...principalIdentity(principal, command?.commandId),
  kind: requiredString(command?.kind, "product_command_kind_required"),
  sessionId: requiredString(command?.sessionId, "product_command_session_required"),
  turnId: requiredString(command?.turnId, "product_command_turn_required"),
  ...(targetCommandId ? {
    targetCommandId: requiredString(targetCommandId, "product_command_target_required"),
  } : {}),
});

const sameIntent = (stored, requested) => (
  stored?.commandId === requested.commandId
  && stored?.workspaceId === requested.workspaceId
  && stored?.userId === requested.userId
  && stored?.kind === requested.kind
  && stored?.sessionId === requested.sessionId
  && stored?.turnId === requested.turnId
  && (stored?.targetCommandId ?? null) === (requested.targetCommandId ?? null)
);

export class CommandIntakeError extends Error {
  constructor(code) {
    super(code);
    this.name = "CommandIntakeError";
    this.code = code;
  }
}

export class CommandIntakeService {
  #commands;
  #now;
  #store;
  #withTransaction;

  constructor({ store, commands = store?.repositories?.productCommands, now = () => new Date().toISOString() } = {}) {
    if (!commands && !store) throw new TypeError("product_command_repository_required");
    if (typeof store?.withTransaction !== "function") {
      throw new TypeError("product_command_transaction_required");
    }
    this.#commands = commands;
    this.#now = now;
    this.#store = store;
    this.#withTransaction = (work) => store.withTransaction(work);
  }

  async accept({ principal, command, persistTarget, loadTarget, at, session } = {}) {
    if (typeof persistTarget !== "function") throw new TypeError("product_command_target_persistence_required");
    const intent = commandIntent(principal, command);
    return this.#transaction(session, (transactionSession) => (
      this.#acceptInTransaction({ intent, persistTarget, loadTarget, at, session: transactionSession })
    ));
  }

  async start({ principal, commandId, invocationId, attemptId, at, session } = {}) {
    return this.#transaction(session, (transactionSession) => this.#transition({
      identity: principalIdentity(principal, commandId),
      expectedStatuses: ["accepted"],
      nextStatus: "running",
      patch: {
        ...(invocationId ? { invocationId } : {}),
        ...(attemptId ? { attemptId } : {}),
      },
      at,
      session: transactionSession,
    }));
  }

  async acceptCancellation({
    principal,
    command,
    targetCommandId = command?.targetCommandId,
    targetStatus,
    cancellationStatus = "completed",
    persistTarget,
    loadTarget,
    at,
    session,
  } = {}) {
    if (typeof persistTarget !== "function") throw new TypeError("product_command_target_persistence_required");
    if (!TERMINAL_STATUSES.has(cancellationStatus)) {
      throw new CommandIntakeError("product_command_terminal_status_required");
    }
    const targetIdentity = principalIdentity(principal, targetCommandId);
    const intent = commandIntent(principal, command, targetIdentity.commandId);
    return this.#transaction(session, async (transactionSession) => {
      const commands = this.#repository();
      const existing = await commands.get(principalIdentity(principal, intent.commandId), {
        session: transactionSession,
      });
      if (existing) {
        if (!sameIntent(existing, intent)) throw new CommandIntakeError("product_command_identity_conflict");
        const existingTarget = await commands.get(targetIdentity, { session: transactionSession });
        const target = typeof loadTarget === "function"
          ? await loadTarget({ command: existing, targetCommand: existingTarget, session: transactionSession })
          : null;
        return { command: existing, target, targetCommand: existingTarget, replayed: true };
      }
      const target = await commands.get(targetIdentity, { session: transactionSession });
      if (!target) throw new CommandIntakeError("product_command_target_not_found");
      if (!(["accepted", "running"].includes(target.status))) {
        throw new CommandIntakeError(
          TERMINAL_STATUSES.has(target.status)
            ? "product_command_target_finished"
            : "product_command_transition_invalid",
        );
      }
      const now = at ?? this.#now();
      const nextTargetStatus = targetStatus
        ?? (target.status === "accepted" ? "cancelled" : "cancellation_requested");
      const legalTargetStatuses = target.status === "accepted"
        ? ["cancellation_requested", "cancelled"]
        : ["cancellation_requested"];
      if (!legalTargetStatuses.includes(nextTargetStatus)) {
        throw new CommandIntakeError("product_command_transition_invalid");
      }
      const accepted = await commands.insertAccepted({
        ...intent,
        createdAt: now,
        updatedAt: now,
      }, { session: transactionSession });
      const targetAfterCancellation = await commands.compareAndSet(
        targetIdentity,
        [target.status],
        {
          status: nextTargetStatus,
          updatedAt: now,
          ...(TERMINAL_STATUSES.has(nextTargetStatus) ? { finishedAt: now } : {}),
        },
        { session: transactionSession },
      );
      if (!targetAfterCancellation) throw new CommandIntakeError("product_command_transition_conflict");
      const persisted = await persistTarget({
        command: accepted,
        targetCommand: targetAfterCancellation,
        session: transactionSession,
      });
      const settledCancellation = await commands.compareAndSet(
        principalIdentity(principal, accepted.commandId),
        ["accepted"],
        {
          status: cancellationStatus,
          updatedAt: now,
          finishedAt: now,
        },
        { session: transactionSession },
      );
      if (!settledCancellation) throw new CommandIntakeError("product_command_transition_conflict");
      return {
        command: settledCancellation,
        target: persisted,
        targetCommand: targetAfterCancellation,
        replayed: false,
      };
    });
  }

  async settle({ principal, commandId, status, at, session } = {}) {
    if (!TERMINAL_STATUSES.has(status)) {
      throw new CommandIntakeError("product_command_terminal_status_required");
    }
    const finishedAt = at ?? this.#now();
    return this.#transaction(session, (transactionSession) => this.#transition({
      identity: principalIdentity(principal, commandId),
      expectedStatuses: SETTLE_FROM,
      nextStatus: status,
      patch: { finishedAt },
      at: finishedAt,
      session: transactionSession,
    }));
  }

  async requestCancellation({ principal, commandId, at, session } = {}) {
    return this.#transaction(session, (transactionSession) => this.#transition({
      identity: principalIdentity(principal, commandId),
      expectedStatuses: ["accepted", "running"],
      nextStatus: "cancellation_requested",
      at,
      session: transactionSession,
    }));
  }

  recover({ principal, commandId, session } = {}) {
    return this.#repository().get(principalIdentity(principal, commandId), { session });
  }

  async recoverByLineage({
    commandId,
    workspaceId,
    kind,
    sessionId,
    turnId,
    session,
  } = {}) {
    const identity = {
      commandId: requiredString(commandId, "product_command_id_required"),
      workspaceId: requiredString(workspaceId, "product_command_workspace_required"),
      kind: requiredString(kind, "product_command_kind_required"),
      sessionId: requiredString(sessionId, "product_command_session_required"),
      turnId: requiredString(turnId, "product_command_turn_required"),
    };
    const commands = this.#repository();
    if (typeof commands.getInternal !== "function") {
      throw new CommandIntakeError("product_command_lineage_lookup_unavailable");
    }
    const command = await commands.getInternal(identity.commandId, { session });
    return command?.commandId === identity.commandId
      && command.workspaceId === identity.workspaceId
      && command.kind === identity.kind
      && command.sessionId === identity.sessionId
      && command.turnId === identity.turnId
      ? command
      : null;
  }

  listRecoverable({ kind, limit = 1_000, session } = {}) {
    if (kind !== "skill_test") {
      throw new CommandIntakeError("product_command_recovery_kind_unsupported");
    }
    const commands = this.#repository();
    if (typeof commands.listRecoverableSkillTests !== "function") {
      throw new CommandIntakeError("product_command_recovery_lookup_unavailable");
    }
    return commands.listRecoverableSkillTests({ limit, session });
  }

  findActiveForSession({
    principal,
    sessionId,
    kind,
    targetCommandId,
    invocationId,
    session,
  } = {}) {
    if (typeof this.#repository().findActiveForSession !== "function") {
      throw new CommandIntakeError("product_command_session_lookup_unavailable");
    }
    return this.#repository().findActiveForSession({
      workspaceId: requiredString(principal?.workspaceId, "product_command_workspace_required"),
      userId: requiredString(principal?.userId, "product_command_user_required"),
      sessionId: requiredString(sessionId, "product_command_session_required"),
      kind: requiredString(kind, "product_command_kind_required"),
      ...(targetCommandId ? { targetCommandId } : {}),
      ...(invocationId ? { invocationId } : {}),
    }, { session });
  }

  async requeue({ principal, commandId, at, session } = {}) {
    return this.#transaction(session, (transactionSession) => this.#transition({
      identity: principalIdentity(principal, commandId),
      expectedStatuses: ["running"],
      nextStatus: "accepted",
      patch: { finishedAt: null },
      at,
      session: transactionSession,
    }));
  }

  async resumeExternal({ principal, commandId, invocationId, attemptId, at, session } = {}) {
    return this.#transaction(session, async (transactionSession) => {
      const identity = principalIdentity(principal, commandId);
      const commands = this.#repository();
      const current = await commands.get(identity, { session: transactionSession });
      if (!current) throw new CommandIntakeError("product_command_not_found");
      if (current.status === "running") return current;
      const resumable = ["accepted", "failed", "blocked"].includes(current.status);
      if (!resumable) throw new CommandIntakeError("product_command_transition_invalid");
      const updated = await commands.compareAndSet(identity, [current.status], {
        status: "running",
        updatedAt: at ?? this.#now(),
        finishedAt: null,
        ...(invocationId ? { invocationId } : {}),
        ...(attemptId ? { attemptId } : {}),
      }, { session: transactionSession });
      if (!updated) throw new CommandIntakeError("product_command_transition_conflict");
      return updated;
    });
  }

  async #acceptInTransaction({ intent, persistTarget, loadTarget, at, session }) {
    const identity = principalIdentity(intent, intent.commandId);
    const commands = this.#repository();
    const existing = await commands.get(identity, { session });
    if (existing) {
      if (!sameIntent(existing, intent)) throw new CommandIntakeError("product_command_identity_conflict");
      const target = typeof loadTarget === "function"
        ? await loadTarget({ command: existing, session })
        : null;
      return { command: existing, target, replayed: true };
    }
    const now = at ?? this.#now();
    const accepted = await commands.insertAccepted({
      ...intent,
      createdAt: now,
      updatedAt: now,
    }, { session });
    const target = await persistTarget({ command: accepted, session });
    return { command: accepted, target, replayed: false };
  }

  async #transition({ identity, expectedStatuses, nextStatus, patch = {}, at, session }) {
    const commands = this.#repository();
    const current = await commands.get(identity, { session });
    if (!current) throw new CommandIntakeError("product_command_not_found");
    if (current.status === nextStatus) return current;
    if (!expectedStatuses.includes(current.status)) {
      throw new CommandIntakeError("product_command_transition_invalid");
    }
    const updated = await commands.compareAndSet(identity, [current.status], {
      ...patch,
      status: nextStatus,
      updatedAt: at ?? this.#now(),
    }, { session });
    if (!updated) throw new CommandIntakeError("product_command_transition_conflict");
    return updated;
  }

  #transaction(session, work) {
    return session ? work(session) : this.#withTransaction(work);
  }

  #repository() {
    const commands = this.#commands ?? this.#store?.repositories?.productCommands;
    if (!commands) throw new TypeError("product_command_repository_required");
    return commands;
  }
}
