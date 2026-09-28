const requiredMethod = (value, name) => {
  if (typeof value?.[name] !== "function") {
    throw new TypeError(`conversation_turn_adapter_${name}_required`);
  }
};

export class ConversationTurnCoordinator {
  #adapter;
  #clock;
  #scheduled = new Map();
  #rescheduleRequested = new Set();
  #active = new Map();

  constructor({ adapter, clock = () => new Date().toISOString() } = {}) {
    for (const name of ["recover", "claimNextTurn", "loadSession", "executeTurn", "handleTurnError"]) {
      requiredMethod(adapter, name);
    }
    if (typeof clock !== "function") throw new TypeError("conversation_turn_clock_invalid");
    this.#adapter = adapter;
    this.#clock = clock;
  }

  async recover() {
    const sessionIds = await this.#adapter.recover();
    for (const sessionId of sessionIds) this.schedule(sessionId);
    return sessionIds;
  }

  schedule(sessionId) {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new TypeError("conversation_turn_session_id_required");
    }
    if (this.#scheduled.has(sessionId)) {
      this.#rescheduleRequested.add(sessionId);
      return;
    }
    const promise = Promise.resolve().then(() => this.#drain(sessionId)).finally(() => {
      if (this.#scheduled.get(sessionId) === promise) {
        this.#scheduled.delete(sessionId);
        if (this.#rescheduleRequested.delete(sessionId)) this.schedule(sessionId);
      }
    });
    this.#scheduled.set(sessionId, promise);
  }

  activeTurn(sessionId) {
    return this.#active.get(sessionId) ?? null;
  }

  abort(sessionId, turnId, reason) {
    const active = this.#active.get(sessionId);
    if (!active || active.turn.turnId !== turnId) return false;
    active.controller.abort(reason);
    return true;
  }

  async waitForIdle(sessionId) {
    while (this.#scheduled.has(sessionId)) {
      await this.#scheduled.get(sessionId);
    }
  }

  async #drain(sessionId) {
    while (true) {
      const turn = await this.#adapter.claimNextTurn(sessionId, this.#clock());
      if (!turn) return;
      const session = await this.#adapter.loadSession(sessionId);
      if (!session) {
        await this.#adapter.handleTurnError({
          sessionId,
          session: null,
          turn,
          error: new Error("conversation_turn_session_not_found"),
          aborted: false,
        });
        continue;
      }
      const controller = new AbortController();
      const active = { session, turn, controller };
      this.#active.set(sessionId, active);
      try {
        await this.#adapter.executeTurn({ session, turn, signal: controller.signal });
      } catch (error) {
        await this.#adapter.handleTurnError({
          sessionId,
          session,
          turn,
          error,
          aborted: controller.signal.aborted,
        });
      } finally {
        if (this.#active.get(sessionId) === active) this.#active.delete(sessionId);
      }
    }
  }
}
