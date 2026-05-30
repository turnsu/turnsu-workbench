export const policyGate = {
  capabilityId: "policy-gate",
  statuses: ["pass", "needs_confirmation", "blocked"],
  blocked: ["run_live_wechat_cli", "read_live_wechat", "trade", "send_message", "publish_external"],
  needsConfirmation: ["computer_use.request"]
};
