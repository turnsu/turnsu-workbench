import {
  AgentKernelError,
} from "../../agent-kernel/src/contracts.mjs";
import { MinimalKernelContext } from "../../agent-kernel/src/context.mjs";
import { composeKernelProfile, installKernelProfile } from "../../agent-kernel/src/profile.mjs";

import {
  FIRST_PARTY_SERVICE_TOKENS,
  createFirstPartyBusinessPlugins,
  isUploadedExecutionRef,
} from "./first-party-plugins.mjs";

export const MEETING_ACTION_EXECUTION_REF = Object.freeze({
  capabilityId: "meeting-action-extractor",
  taskIntent: "extract_actions",
  adapterVersion: "1",
  executionMode: "deterministic",
});

/**
 * A Product-owned adapter for deterministic business skills. It installs the
 * same first-party Plugin manifests used by the Agent profile, but owns no
 * Product database, role, secret, or Pi API. The caller supplies any approved
 * execution port for an uploaded skill.
 */
export class FirstPartyBusinessPluginRuntime {
  #uploadedSkillExecutionPort;
  #clock;
  #idFactory;
  #context = null;
  #installation = null;
  #initialization = null;
  #disposed = false;

  constructor({ uploadedSkillExecutionPort = null, clock, idFactory } = {}) {
    if (clock !== undefined && typeof clock !== "function") {
      throw new AgentKernelError("first_party_business_runtime_dependencies_invalid");
    }
    if (idFactory !== undefined && typeof idFactory !== "function") {
      throw new AgentKernelError("first_party_business_runtime_dependencies_invalid");
    }
    this.#uploadedSkillExecutionPort = uploadedSkillExecutionPort;
    this.#clock = clock;
    this.#idFactory = idFactory;
  }

  acceptsExecutionRef(executionRef) {
    return isMeetingExecutionRef(executionRef) || isUploadedExecutionRef(executionRef);
  }

  async probe({ executionRef, workspaceId } = {}) {
    this.#assertActive();
    if (isMeetingExecutionRef(executionRef)) return ready("first_party_meeting_ready");
    if (!isUploadedExecutionRef(executionRef)) return blocked("first_party_skill_unknown");
    if (typeof this.#uploadedSkillExecutionPort?.probeExecution !== "function") {
      return blocked("uploaded_skill_runtime_unavailable");
    }
    try {
      const result = await this.#uploadedSkillExecutionPort.probeExecution({ workspaceId, executionRef: clone(executionRef) });
      return result?.ready === true ? ready("uploaded_skill_ready") : blocked("uploaded_skill_unavailable");
    } catch {
      return blocked("uploaded_skill_runtime_unavailable");
    }
  }

  async invoke({ workspaceId, executionRef, input, materials = [], signal } = {}) {
    this.#assertActive();
    await this.#ensure();
    if (isMeetingExecutionRef(executionRef)) {
      return this.#context.use(FIRST_PARTY_SERVICE_TOKENS.meetingActions).extract(clone(input));
    }
    if (isUploadedExecutionRef(executionRef)) {
      return this.#context.use(FIRST_PARTY_SERVICE_TOKENS.uploadedSkill).execute({
        workspaceId,
        executionRef: clone(executionRef),
        input: clone(input),
        materials,
        signal,
        executionPort: this.#uploadedSkillExecutionPort,
      });
    }
    throw new AgentKernelError("first_party_skill_unknown");
  }

  async service(token) {
    this.#assertActive();
    await this.#ensure();
    return this.#context.use(token);
  }

  async dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    const errors = [];
    try { await this.#installation?.dispose(); } catch (error) { errors.push(error); }
    try { await this.#context?.dispose(); } catch (error) { errors.push(error); }
    this.#installation = null;
    this.#context = null;
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "first_party_business_runtime_dispose_failed");
  }

  async #ensure() {
    if (this.#initialization) return this.#initialization;
    this.#initialization = (async () => {
      const context = new MinimalKernelContext({ scope: "business-plugin-host" });
      const profile = composeKernelProfile({
        id: "first-party-business",
        revision: "1",
        mode: "production_locked",
        plugins: createFirstPartyBusinessPlugins({
          ...(this.#clock ? { clock: this.#clock } : {}),
          ...(this.#idFactory ? { idFactory: this.#idFactory } : {}),
        }),
      });
      const installation = await installKernelProfile({ context, profile });
      this.#context = context;
      this.#installation = installation;
    })();
    try {
      await this.#initialization;
    } catch (error) {
      this.#initialization = null;
      await this.#context?.dispose().catch(() => {});
      this.#context = null;
      throw error;
    }
  }

  #assertActive() {
    if (this.#disposed) throw new AgentKernelError("first_party_business_runtime_disposed");
  }
}

export function createFirstPartyBusinessPluginRuntime(options = {}) {
  return new FirstPartyBusinessPluginRuntime(options);
}

function isMeetingExecutionRef(value) {
  return Boolean(value
    && value.capabilityId === MEETING_ACTION_EXECUTION_REF.capabilityId
    && value.taskIntent === MEETING_ACTION_EXECUTION_REF.taskIntent
    && value.adapterVersion === MEETING_ACTION_EXECUTION_REF.adapterVersion
    && value.executionMode === MEETING_ACTION_EXECUTION_REF.executionMode
    && Object.keys(value).length === 4);
}

function ready(code) {
  return Object.freeze({ status: "ready", ready: true, code });
}

function blocked(code) {
  return Object.freeze({ status: "blocked", ready: false, code });
}

function clone(value) {
  try { return structuredClone(value); } catch { throw new AgentKernelError("first_party_value_invalid"); }
}
