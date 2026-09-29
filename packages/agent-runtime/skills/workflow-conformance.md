---
name: workflow-conformance
description: Proves the test-only Workflow bridge path through Agent Runtime Core and the PI Kernel with deterministic structured output.
compatibility: Available only in isolated Agent Runtime test mode with the workflow-conformance extension enabled.
disable-model-invocation: true
---

# Skill: Workflow Conformance

Purpose: verify the production Workflow Skill executor path without a live model call.

Input:
- `text`: bounded text to echo.
- `delayMs`: optional bounded test delay used only to exercise invocation cancellation.

Output:
- `echo`: the exact input text;
- `charCount`: Unicode code-point count.

Rules:
- test mode only;
- no network, provider, artifact, or product mutation;
- execution must pass through Agent Runtime Core and the PI tool definition.
