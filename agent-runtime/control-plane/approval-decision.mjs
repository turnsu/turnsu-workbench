import { controlID, nowISO } from "./schema-validator.mjs";

export function createApprovalDecisions({ policyDecisions = [] }) {
  return policyDecisions
    .filter((decision) => decision.status === "needs_confirmation" || decision.status === "blocked")
    .map((decision) => ({
      schemaVersion: "agent-approval-decision-v1",
      id: controlID("approval"),
      policyDecisionID: decision.id,
      action: decision.action,
      status: decision.status === "blocked" ? "blocked" : "needs_confirmation",
      approved: false,
      approvalAvailable: decision.status !== "blocked",
      reason:
        decision.status === "blocked"
          ? "Blocked actions cannot be approved in this MVP runtime."
          : "The runtime records a confirmation boundary but does not execute external UI/provider actions automatically.",
      requestedAt: nowISO(),
      decidedAt: null,
      decidedBy: null,
    }));
}

