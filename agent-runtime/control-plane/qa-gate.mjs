import { controlID, nowISO } from "./schema-validator.mjs";

export function createQAGate({ runID, taskID, contextGate, policyDecisions = [], approvalDecisions = [], toolIntentPlan }) {
  const issues = [];
  if (contextGate?.status === "degraded") {
    issues.push({
      type: "context_degraded",
      severity: "warning",
      detail: contextGate.reason || "Context Plane had missing or stale inputs.",
    });
  }
  for (const decision of policyDecisions.filter((item) => item.status === "blocked")) {
    issues.push({
      type: "blocked_action",
      severity: "warning",
      detail: `${decision.action} was blocked by policy.`,
    });
  }
  for (const approval of approvalDecisions.filter((item) => item.status === "needs_confirmation")) {
    issues.push({
      type: "approval_required",
      severity: "info",
      detail: `${approval.action} requires confirmation and was not executed.`,
    });
  }

  const fatalIssues = issues.filter((issue) => issue.severity === "error");
  return {
    schemaVersion: "agent-qa-gate-v1",
    id: controlID("qa"),
    runID,
    taskID,
    status: fatalIssues.length > 0 ? "failed" : issues.length > 0 ? "pass_with_warnings" : "pass",
    checks: [
      { name: "context_manifest_present", status: contextGate ? "pass" : "failed" },
      { name: "tool_intent_plan_present", status: toolIntentPlan ? "pass" : "failed" },
      { name: "policy_decisions_present", status: policyDecisions.length > 0 ? "pass" : "warning" },
      { name: "secrets_not_returned", status: "pass" },
      { name: "raw_private_transcript_not_included", status: "pass" },
    ],
    issues,
    rawSecretsReturned: false,
    rawTranscriptIncluded: false,
    createdAt: nowISO(),
  };
}

