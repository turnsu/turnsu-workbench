import { nowISO, safeArray } from "./schema-validator.mjs";

const baseStages = [
  "task_intent",
  "execution_profile",
  "context_plane",
  "planner",
  "tool_intent_plan",
  "policy_gate",
  "approval_gate",
  "model_route",
  "tool_execution",
  "qa_gate",
  "metrics",
  "checkpoint",
  "final_output",
];

export function createExecutionProfile({ taskIntent, tools = [], attachments = [] }) {
  const taskType = taskIntent?.taskType || "daily_intelligence";
  const stages = [...baseStages];
  if (attachments.length > 0 && !stages.includes("attachment_analysis")) {
    stages.splice(3, 0, "attachment_analysis");
  }

  const profileID =
    taskType === "long_running_watch"
      ? "sequential_long_task_mvp"
      : taskType === "image_context_analysis"
        ? "sequential_image_assisted_mvp"
        : "sequential_research_mvp";

  return {
    schemaVersion: "agent-execution-profile-v1",
    profileID,
    runID: taskIntent.runID,
    taskID: taskIntent.taskID,
    taskType,
    plannerMode: "deterministic_control_plane_mvp",
    workerPolicy: {
      mode: "sequential_mvp",
      maxWorkers: 1,
      reason: "MVP writes worker/checkpoint decisions without launching multi-worker sandbox.",
    },
    requiredStages: stages,
    allowedToolNames: safeArray(tools),
    contextPlaneRequired: true,
    policyGateRequired: true,
    approvalGateRequired: true,
    qaGateRequired: true,
    checkpointRequired: true,
    retryPolicy: {
      maxRetries: 0,
      retryMode: "record_only",
      reason: "First version records retry ledger; automatic retry is intentionally off.",
    },
    modelRouteType: taskType === "image_context_analysis" ? "vision_assisted_text" : "text_planning_and_synthesis",
    createdAt: nowISO(),
  };
}

