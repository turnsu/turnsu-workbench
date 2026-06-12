# Agent Gate Overdefense Problem Review

- Date: 2026-06-12
- Status: historical problem review
- Scope: CMC gates, output guard, confidence/risk/status fields, mutation policy, Swift sanitizer

## 1. Problem Statement

The current project has too many gates. Many were introduced to patch real bugs:

- fake live market data;
- CMC transport success with empty parsed evidence;
- model-invented concrete prices;
- raw provider/internal ID leakage;
- product mutations imported from weak evidence;
- frontend final-output source competition.

Those fixes were reasonable in isolation, but the accumulated system now uses gates to compensate for business logic, parser, provider, routing, and UI bugs. This is not sustainable.

The new principle should be:

```text
Keep engineering gates.
Fix business behavior as product/runtime bugs.
Do not use gates as a substitute for provider, parser, planner, or UI implementation.
```

## 2. Gate Inventory

The current system includes or implies these decision points:

- Policy Gate.
- approval gate.
- CMC freshness gate.
- CMC evidence gate.
- CMC price gate.
- Skill Hub display gate.
- returned-price whitelist.
- output guard.
- internal-surface sanitizer.
- product mutation policy.
- source trust report.
- confidence field.
- risk field.
- blocked / degraded / usable statuses.
- final read model precedence.
- Swift humanize / strip internal surface.
- UI debug / inspector state.

Some of these are real engineering boundaries. Others are business-level uncertainty modeled as blocking logic.

## 3. Why Overdefense Happened

### 3.1 Transport Was Confused With Truth

CMC transport returning `ok` did not mean the App had a usable price snapshot or parsed research evidence. Gates were added to prevent false claims.

The correct fix is a provider/result contract:

- transport status;
- parsed result status;
- price snapshot status;
- source attribution;
- empty reason.

The incorrect long-term pattern is to add more blocking gates around the final answer.

### 3.2 Parser Bugs Became User-Facing Restrictions

When `readableEvidence=[]` or `assets=[]`, the App often treated the result as unusable. In reality this can mean:

- provider returned a summary but parser failed;
- provider returned non-structured text;
- capability returned useful qualitative output but no price snapshot;
- App did not normalize the returned fields.

Parser gaps are bugs or feature work, not proof that a result should be hidden.

### 3.3 Business Confidence Became a Gate

Fields like `confidence`, `risk`, `source trust`, and `degraded` were often used as if they were hard safety boundaries. For research workflows this is usually wrong.

Low confidence should trigger:

- clearer caveats;
- review prompt;
- request for more material;
- source attribution display.

It should not automatically rewrite the final output into a generic template.

### 3.4 Product Mutations Became a Separate Decision System

`productMutationPolicy` is useful, but it should be derived from engineering decisions:

- user permission;
- action risk;
- required schema validity;
- source attribution;
- idempotency;
- artifact integrity.

It should not become another independent gate with its own business interpretation.

### 3.5 Swift Became a Second Output Guard

Swift `humanize` and sanitizer are useful as display safety fallbacks, but they should not be another semantic gate. If the backend writes bad final text, the fix belongs in the backend final read model contract, not in increasingly aggressive line deletion in the frontend.

## 4. Gates to Keep

### 4.1 Authorization / Policy Gate

Keep as a hard gate.

Purpose:

- trading execution;
- sending messages;
- publishing to Feishu;
- cloud document overwrite/delete;
- destructive local actions;
- external posting;
- secret or private data movement.

This is an engineering/product safety boundary.

### 4.2 Secret and Internal Surface Guard

Keep as a hard gate.

Purpose:

- secrets;
- Authorization headers;
- raw request bodies;
- provider internals;
- internal tool names;
- local file paths;
- raw artifact fields that should not be user-facing.

This is an engineering leakage boundary.

### 4.3 Schema / Contract Validation

Keep as a hard gate for writes and state transitions.

Purpose:

- malformed artifacts;
- missing runID/taskID;
- invalid final read model;
- invalid product mutation schema;
- stale or incompatible artifact version.

This is an engineering integrity boundary.

### 4.4 Numeric Claim Provenance

Keep, but narrow its scope.

Purpose:

- prevent App/LLM-generated prices, support/resistance, entry/exit, stop loss, take profit, and trading ranges when no source supports them.

This should not block displaying provider-returned text. It should only block unsupported numeric claims and execution-style levels.

### 4.5 Mutation Commit Gate

Keep as an engineering write boundary.

Purpose:

- idempotency;
- user confirmation for high-impact writes;
- schema validity;
- source artifact availability;
- action scope.

This should not decide whether research text is useful. It only decides whether something may be committed to the workbench state.

### 4.6 Resource / Timeout / Concurrency Gate

Keep as operational engineering guardrails:

- timeout;
- retry budget;
- parallelism limit;
- cancellation;
- daemon shutdown;
- subagent namespace.

## 5. Gates to Remove or Downgrade

### 5.1 Freshness as a Hard Business Gate

Freshness should become metadata on evidence and price snapshots. It should not independently rewrite a final answer.

Bad:

```text
freshness != fresh -> final unusable
```

Better:

```text
source observedAt / expiresAt / providerType -> shown in data note
```

### 5.2 Confidence as a Hard Gate

Confidence should become a review hint or UI signal, not a blocker.

Bad:

```text
confidence < 0.6 -> discard answer
```

Better:

```text
confidence low -> ask for review or missing source
```

### 5.3 Risk as a Generic Gate

Risk should only feed Policy Gate when an action has real-world impact. For ordinary research and drafting, risk should be explanation metadata.

### 5.4 Evidence Gate as Broad "Can Answer / Cannot Answer"

Evidence should be scoped per claim:

- source-backed claim;
- model inference;
- user-provided context;
- missing evidence.

It should not be one broad gate that downgrades a whole answer because one parser field is empty.

### 5.5 Output Guard as Business Rewriter

Output Guard should prevent leakage and unsupported numeric/action claims. It should not rewrite domain content into generic templates because a business field is missing.

If output quality is bad, fix:

- provider adapter;
- parser;
- prompt;
- planner route;
- final formatter;
- UI renderer.

Do not hide the bug behind another output template.

## 6. New Gate Model

The target is a small `Core Gate Engine`:

```text
Core Gate Engine
├── PolicyDecision
├── ContractDecision
├── ClaimProvenanceDecision
├── OutputSafetyDecision
└── MutationCommitDecision
```

Everything else becomes metadata:

- confidence;
- risk;
- freshness;
- source trust;
- degraded;
- usable;
- empty reason;
- parser warning.

Metadata can appear in task-local review or data notes, but should not become independent gates.

## 7. Business Bugs Must Be Fixed Directly

Examples:

| Business issue | Correct fix | Wrong fix |
| --- | --- | --- |
| CMC result not parsed | improve normalizer / result extractor | hide final answer |
| wrong tool selected | fix router / planner | add confidence gate |
| price missing | add provider snapshot or say missing | block all research |
| low-quality summary | improve prompt / formatter | generic fallback template |
| Office draft poor | improve document worker | policy-gate the draft |
| UI confused | redesign read model / interaction | add more status chips |

## 8. Historical Lesson

Gates are for engineering invariants, safety, provenance, and commit boundaries. They are not a product quality strategy. If a capability returns poor business output, that is a feature bug to fix through provider, parser, planner, prompt, or UI work.
