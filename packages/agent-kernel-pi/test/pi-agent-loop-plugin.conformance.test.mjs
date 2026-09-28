import {
  createMinimalAgentKernel,
} from "../../agent-kernel/src/index.mjs";
import {
  defineAgentKernelConformance,
} from "../../agent-testkit/src/index.mjs";
import { createPiAgentLoopPlugin } from "../src/index.mjs";

defineAgentKernelConformance({
  name: "PiAgentLoopPlugin",
  createKernel: ({ loop, sessionPort, toolPipeline, profile }) => createMinimalAgentKernel({
    sessionPort,
    toolPipeline,
    profile,
    loop: createPiAgentLoopPlugin({
      createRuntime: async ({ session }) => new ConformancePiRuntime(loop, session),
    }),
  }),
});

class ConformancePiRuntime {
  #loop;
  #kernelListeners = new Set();
  #binding = null;
  #sessionRef;
  #session;

  constructor(loop, sessionRef) {
    this.#loop = loop;
    this.#sessionRef = sessionRef;
    this.#session = new ConformancePiSession({
      run: async () => {
        const binding = this.#binding;
        if (!binding) throw new Error("conformance_binding_missing");
        for await (const event of this.#loop.run(binding)) {
          if (event?.type === "message" && event?.modelVisible === true
            && typeof event.payload?.text === "string") {
            this.#session.messages.push({
              role: "assistant",
              content: [{ type: "text", text: event.payload.text }],
            });
          }
          for (const listener of [...this.#kernelListeners]) listener(event);
        }
      },
      compact: (session) => this.#loop.compact(session),
    });
  }

  get session() { return this.#session; }

  async ensure() {}

  async bindKernelTools(binding) {
    this.#binding = binding;
  }

  subscribeKernelEvents(listener) {
    this.#kernelListeners.add(listener);
    return () => this.#kernelListeners.delete(listener);
  }

  async compact() {
    return this.#session.compact(this.#binding?.session ?? this.#sessionRef);
  }

  async abort() {
    if (this.#binding?.runId) await this.#loop.cancel(this.#binding.runId);
    await this.#session.abort();
  }

  async dispose() { await this.#session.dispose(); }
}

class ConformancePiSession {
  #run;
  #compact;
  #listeners = new Set();

  constructor({ run, compact }) {
    this.#run = run;
    this.#compact = compact;
    this.messages = [];
  }

  getActiveToolNames() { return ["kernel.conformance.bridge"]; }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async prompt() { await this.#run(); }

  async compact(session) { return this.#compact(session); }

  async abort() {}

  async dispose() {}
}
