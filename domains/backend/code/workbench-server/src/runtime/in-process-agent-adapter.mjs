import { WorkflowSkillRegistryError } from "../../../../../agent/code/agent-runtime/core/workflow/workflow-skill-executor-registry.mjs";
import {
  isUploadedExecutionRef,
  UPLOADED_SKILL_INTERNAL_TOOL_NAME,
} from "../../../../../agent/code/agent-runtime/extensions/uploaded-skill-executor/binding.mjs";

import {
  AgentRuntimePort,
  AgentRuntimePortError,
  assertAgentRuntimePort,
} from "./agent-runtime-port.mjs";

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 120000;
const DEFAULT_MAX_ACTIVE_INVOCATIONS = 64;
const MAX_ACTIVE_INVOCATIONS = 1024;

export function createInProcessAgentAdapter(options) {
  return assertAgentRuntimePort(new InProcessAgentAdapter(options));
}

export class InProcessAgentAdapter extends AgentRuntimePort {
  #agentRuntimeCore;
  #piKernel;
  #executorRegistry;
  #uploadedSkillRuntime;
  #activeInvocations = new Map();
  #defaultTimeoutMs;
  #maxTimeoutMs;
  #maxActiveInvocations;
  #now;

  constructor({
    agentRuntimeCore,
    piKernel,
    executorRegistry,
    uploadedSkillRuntime = null,
    defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
    maxTimeoutMs = MAX_TIMEOUT_MS,
    maxActiveInvocations = DEFAULT_MAX_ACTIVE_INVOCATIONS,
    now = () => new Date().toISOString(),
  } = {}) {
    super();
    if (
      typeof agentRuntimeCore?.skillReadiness !== "function"
      || typeof agentRuntimeCore?.executeKernelTool !== "function"
      || typeof agentRuntimeCore?.buildFinalReadModel !== "function"
      || typeof agentRuntimeCore?.generateBuilderProposal !== "function"
      || typeof piKernel?.ensure !== "function"
      || typeof piKernel?.status !== "function"
      || typeof executorRegistry?.resolve !== "function"
      || typeof executorRegistry?.acceptsInput !== "function"
      || typeof executorRegistry?.readKernelOutput !== "function"
      || typeof now !== "function"
    ) {
      throw new AgentRuntimePortError("agent_runtime_adapter_invalid_dependencies");
    }
    this.#defaultTimeoutMs = positiveInteger(defaultTimeoutMs, "agent_runtime_adapter_invalid_timeout");
    this.#maxTimeoutMs = positiveInteger(maxTimeoutMs, "agent_runtime_adapter_invalid_timeout");
    this.#maxActiveInvocations = positiveInteger(
      maxActiveInvocations,
      "agent_runtime_adapter_invalid_capacity",
    );
    if (this.#defaultTimeoutMs > this.#maxTimeoutMs || this.#maxTimeoutMs > MAX_TIMEOUT_MS) {
      throw new AgentRuntimePortError("agent_runtime_adapter_invalid_timeout");
    }
    if (this.#maxActiveInvocations > MAX_ACTIVE_INVOCATIONS) {
      throw new AgentRuntimePortError("agent_runtime_adapter_invalid_capacity");
    }
    this.#agentRuntimeCore = agentRuntimeCore;
    this.#piKernel = piKernel;
    this.#executorRegistry = executorRegistry;
    this.#uploadedSkillRuntime = uploadedSkillRuntime;
    this.#now = now;
  }

  async probeSkill(executionRef, { workspaceId } = {}) {
    if (isUploadedExecutionRef(executionRef)) {
      if (typeof this.#uploadedSkillRuntime?.probeExecution !== "function") {
        return skillProbe(false, "uploaded_skill_runtime_unavailable");
      }
      try {
        await this.#piKernel.ensure();
        if (!this.#isUploadedToolBound()) return skillProbe(false, "uploaded_skill_tool_unavailable");
        return await this.#uploadedSkillRuntime.probeExecution({ workspaceId, executionRef });
      } catch {
        return skillProbe(false, "uploaded_skill_runtime_unavailable");
      }
    }
    const registration = this.#resolveRegistration(executionRef);
    if (!registration) return skillProbe(false, "skill_execution_ref_unknown");

    try {
      await this.#piKernel.ensure();
      const readiness = this.#agentRuntimeCore.skillReadiness(
        registration.internalBinding.skillId,
      );
      return readiness?.ready && this.#isToolBound(registration)
        ? skillProbe(true, "skill_loaded_and_bound")
        : skillProbe(false, "skill_not_ready");
    } catch {
      return skillProbe(false, "skill_runtime_unavailable");
    }
  }

  async invokeSkillNode({ invocationId, workspaceId, executionRef, input, timeoutMs, signal } = {}) {
    if (isUploadedExecutionRef(executionRef)) {
      return this.#invokeUploadedSkill({
        invocationId,
        workspaceId,
        executionRef,
        input,
        timeoutMs,
        signal,
      });
    }
    const registration = this.#resolveRegistration(executionRef);
    if (!registration) throw new AgentRuntimePortError("skill_execution_ref_unknown");
    if (!this.#executorRegistry.acceptsInput(registration, input)) {
      throw new AgentRuntimePortError("skill_input_invalid");
    }

    const normalizedInvocationId = boundedIdentifier(invocationId, "invocation_id_invalid");
    const active = this.#beginInvocation(normalizedInvocationId, { timeoutMs, signal });
    try {
      await raceWithAbort(this.#piKernel.ensure(), active.controller.signal);
      const readiness = this.#agentRuntimeCore.skillReadiness(
        registration.internalBinding.skillId,
      );
      if (!readiness?.ready || !this.#isToolBound(registration)) {
        throw new AgentRuntimePortError("skill_not_ready");
      }

      throwIfAborted(active.controller.signal);
      active.executionPromise = Promise.resolve(
        this.#agentRuntimeCore.executeKernelTool(
          registration.internalBinding.toolName,
          structuredClone(input),
          { signal: active.controller.signal },
        ),
      );
      const kernelResult = await raceWithAbort(
        active.executionPromise,
        active.controller.signal,
      );
      return this.#executorRegistry.readKernelOutput(registration, kernelResult);
    } catch (error) {
      throw mapInvocationError(error);
    } finally {
      this.#endInvocation(normalizedInvocationId, active);
    }
  }

  async generateBuilderProposal(input) {
    try {
      return await this.#agentRuntimeCore.generateBuilderProposal(input);
    } catch (error) {
      if (error?.code === "builder_proposal_invalid") {
        throw new AgentRuntimePortError("builder_proposal_invalid");
      }
      throw new AgentRuntimePortError("builder_proposal_unavailable");
    }
  }

  async buildAuthoritativeFinal({ runId, finalText, evidenceGaps = [], reviewPacket = null } = {}) {
    const normalizedRunId = boundedIdentifier(runId, "final_request_invalid");
    const normalizedFinalText = boundedText(finalText, 1000000, "final_request_invalid");
    const productEvidenceGaps = projectEvidenceGaps(evidenceGaps);
    const productReviewPacket = projectReviewPacket(reviewPacket);

    let authoritativeFinal;
    try {
      authoritativeFinal = this.#agentRuntimeCore.buildFinalReadModel({
        runID: normalizedRunId,
        taskID: `workflow-task:${normalizedRunId}`,
        sessionID: `workflow-session:${normalizedRunId}`,
        status: "completed",
        finalText: normalizedFinalText,
        finalTextSource: "workflow_runner_authoritative_final",
        toolObservations: {
          outputGuard: {
            status: "passed",
            reason: "workflow_final_authority",
          },
          cmcFreshnessGate: {
            status: "not_applicable",
            reason: "workflow_final_authority",
          },
        },
        artifactPath: null,
        now: this.#now,
      });
    } catch {
      throw new AgentRuntimePortError("final_authority_unavailable");
    }
    if (
      authoritativeFinal?.schemaVersion !== "agent-final-read-model-v1"
      || typeof authoritativeFinal.finalText !== "string"
      || authoritativeFinal.finalText.length === 0
    ) {
      throw new AgentRuntimePortError("final_authority_invalid");
    }

    return Object.freeze({
      finalText: authoritativeFinal.finalText,
      evidenceGaps: productEvidenceGaps,
      reviewPacket: productReviewPacket,
      agentFinalReadModel: structuredClone(authoritativeFinal),
    });
  }

  async cancelInvocation(invocationId) {
    const normalizedInvocationId = boundedIdentifier(invocationId, "invocation_id_invalid");
    const active = this.#activeInvocations.get(normalizedInvocationId);
    if (!active) throw new AgentRuntimePortError("invocation_unknown");
    active.controller.abort(new AgentRuntimePortError("invocation_cancelled"));
    return Object.freeze({ cancelled: true });
  }

  #resolveRegistration(executionRef) {
    try {
      return this.#executorRegistry.resolve(executionRef);
    } catch (error) {
      if (error instanceof WorkflowSkillRegistryError) {
        throw new AgentRuntimePortError("skill_execution_ref_invalid");
      }
      throw error;
    }
  }

  #isToolBound(registration) {
    const registeredTools = this.#piKernel.status()?.registeredTools;
    return Array.isArray(registeredTools)
      && registeredTools.includes(registration.internalBinding.toolName);
  }

  #isUploadedToolBound() {
    const registeredTools = this.#piKernel.status()?.registeredTools;
    return Array.isArray(registeredTools) && registeredTools.includes(UPLOADED_SKILL_INTERNAL_TOOL_NAME);
  }

  async #invokeUploadedSkill({ invocationId, workspaceId, executionRef, input, timeoutMs, signal }) {
    if (typeof this.#uploadedSkillRuntime?.probeExecution !== "function") {
      throw new AgentRuntimePortError("uploaded_skill_runtime_unavailable");
    }
    const normalizedInvocationId = boundedIdentifier(invocationId, "invocation_id_invalid");
    const active = this.#beginInvocation(normalizedInvocationId, { timeoutMs, signal });
    try {
      await raceWithAbort(this.#piKernel.ensure(), active.controller.signal);
      const readiness = await this.#uploadedSkillRuntime.probeExecution({ workspaceId, executionRef });
      if (!readiness?.ready || !this.#isUploadedToolBound()) {
        throw new AgentRuntimePortError("skill_not_ready");
      }
      throwIfAborted(active.controller.signal);
      active.executionPromise = Promise.resolve(this.#agentRuntimeCore.executeKernelTool(
        UPLOADED_SKILL_INTERNAL_TOOL_NAME,
        { workspaceId, executionRef: structuredClone(executionRef), input: structuredClone(input) },
        { signal: active.controller.signal },
      ));
      const kernelResult = await raceWithAbort(active.executionPromise, active.controller.signal);
      const output = kernelResult?.details?.workflowOutput;
      if (!output || typeof output !== "object" || Array.isArray(output)) {
        throw new AgentRuntimePortError("skill_output_invalid");
      }
      return structuredClone(output);
    } catch (error) {
      throw mapInvocationError(error);
    } finally {
      this.#endInvocation(normalizedInvocationId, active);
    }
  }

  #beginInvocation(invocationId, { timeoutMs, signal }) {
    if (this.#activeInvocations.has(invocationId)) {
      throw new AgentRuntimePortError("invocation_duplicate");
    }
    if (this.#activeInvocations.size >= this.#maxActiveInvocations) {
      throw new AgentRuntimePortError("invocation_capacity_exceeded");
    }
    if (signal !== undefined && !isAbortSignal(signal)) {
      throw new AgentRuntimePortError("invocation_signal_invalid");
    }

    const controller = new AbortController();
    const boundedTimeoutMs = timeoutMs === undefined
      ? this.#defaultTimeoutMs
      : Math.min(positiveInteger(timeoutMs, "invocation_timeout_invalid"), this.#maxTimeoutMs);
    const timer = setTimeout(() => {
      controller.abort(new AgentRuntimePortError("invocation_timeout"));
    }, boundedTimeoutMs);
    timer.unref?.();

    let removeExternalAbortListener = () => {};
    if (signal) {
      const abortFromExternalSignal = () => {
        controller.abort(new AgentRuntimePortError("invocation_cancelled"));
      };
      if (signal.aborted) {
        abortFromExternalSignal();
      } else {
        signal.addEventListener("abort", abortFromExternalSignal, { once: true });
        removeExternalAbortListener = () => signal.removeEventListener("abort", abortFromExternalSignal);
      }
    }

    const active = {
      controller,
      timer,
      removeExternalAbortListener,
      executionPromise: null,
    };
    this.#activeInvocations.set(invocationId, active);
    return active;
  }

  #endInvocation(invocationId, active) {
    clearTimeout(active.timer);
    active.removeExternalAbortListener();
    if (active.controller.signal.aborted && active.executionPromise) {
      active.executionPromise
        .finally(() => this.#deleteActiveInvocation(invocationId, active))
        .catch(() => {});
      return;
    }
    this.#deleteActiveInvocation(invocationId, active);
  }

  #deleteActiveInvocation(invocationId, active) {
    if (this.#activeInvocations.get(invocationId) === active) {
      this.#activeInvocations.delete(invocationId);
    }
  }
}

function skillProbe(ready, code) {
  return Object.freeze({
    status: ready ? "ready" : "blocked",
    ready,
    code,
  });
}

function mapInvocationError(error) {
  if (error instanceof AgentRuntimePortError) return error;
  if (error instanceof WorkflowSkillRegistryError) {
    if (
      error.code === "workflow_registry_kernel_output_missing"
      || error.code === "workflow_registry_output_schema_mismatch"
    ) {
      return new AgentRuntimePortError("skill_output_invalid");
    }
  }
  return new AgentRuntimePortError("skill_invocation_failed");
}

function raceWithAbort(promise, signal) {
  const pending = Promise.resolve(promise);
  if (signal.aborted) {
    pending.catch(() => {});
    throw abortReason(signal);
  }
  let removeAbortListener = () => {};
  const aborted = new Promise((_, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  });
  return Promise.race([pending, aborted]).finally(removeAbortListener);
}

function throwIfAborted(signal) {
  if (signal.aborted) throw abortReason(signal);
}

function abortReason(signal) {
  return signal.reason instanceof AgentRuntimePortError
    ? signal.reason
    : new AgentRuntimePortError("invocation_cancelled");
}

function isAbortSignal(value) {
  return Boolean(
    value
    && typeof value.aborted === "boolean"
    && typeof value.addEventListener === "function"
    && typeof value.removeEventListener === "function",
  );
}

function positiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new AgentRuntimePortError(code);
  return value;
}

function boundedIdentifier(value, code) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 128
    || value !== value.trim()
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  ) {
    throw new AgentRuntimePortError(code);
  }
  return value;
}

function boundedText(value, maxLength, code) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new AgentRuntimePortError(code);
  }
  return value;
}

function projectEvidenceGaps(value) {
  if (!Array.isArray(value)) throw new AgentRuntimePortError("final_request_invalid");
  return Object.freeze(value.map((gap) => {
    if (!gap || typeof gap !== "object" || Array.isArray(gap)) {
      throw new AgentRuntimePortError("final_request_invalid");
    }
    const projected = {
      code: boundedText(gap.code, 128, "final_request_invalid"),
      summary: boundedText(gap.summary, 2000, "final_request_invalid"),
    };
    if (gap.nodeId !== undefined) {
      projected.nodeId = boundedIdentifier(gap.nodeId, "final_request_invalid");
    }
    return Object.freeze(projected);
  }));
}

function projectReviewPacket(value) {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.items)) {
    throw new AgentRuntimePortError("final_request_invalid");
  }
  return Object.freeze({
    nodeId: boundedIdentifier(value.nodeId, "final_request_invalid"),
    title: boundedText(value.title, 200, "final_request_invalid"),
    summary: boundedText(value.summary, 2000, "final_request_invalid"),
    items: Object.freeze(value.items.map((item) => boundedText(item, 1000, "final_request_invalid"))),
    canRequestChanges: value.canRequestChanges === true,
  });
}
