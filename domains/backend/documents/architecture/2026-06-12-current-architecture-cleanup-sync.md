# Current Architecture Cleanup Sync

- Date: 2026-06-12
- Status: superseded product architecture, retained as historical implementation background
- Superseded by: [Current System Architecture](../../../../wiki/architecture/CURRENT_SYSTEM_ARCHITECTURE.md)
- Scope: Blocks Workbench App, Agent Runtime Core, Pi Kernel, daemon host shell, capability packages, wiki cleanup

This document no longer defines the active product surface. Its internal Agent
Runtime Core and Pi Kernel observations may be used only where they do not
conflict with the current Web Skill / Workflow / Loop architecture.

## Summary

The project is now organized around one product surface and one runtime brain:

- Product surface: `Blocks Workbench` in the macOS SwiftUI App.
- Runtime brain: `Agent Runtime Core`.
- Agentic execution kernel: Pi SDK behind `Pi Kernel`.
- Host process: local daemon shell.
- User-facing abilities: capability packages.

Older product forms such as Research OS, Apple minimal Today Desk, Queue Canvas, Split Focus, Unified Workstream, Command Desk v2, source browser, and global Inspector are historical references only. They must not be used as active implementation targets.

## Swift App

The Swift App is a local-first macOS workbench. It has three user-facing areas:

- `Workbench`: default Blocks Workbench for Crypto, Markets, and Office loops.
- `History`: completed answers, drafts, follow-ups, and task-local compatibility detail. WeChat, Token, and Watchlist are internal history filters, not top-level products.
- `Settings`: runtime readiness, privacy, provider status, and diagnostics.

Default UI rules:

- No global `RuntimeRightInspectorView` in the product shell.
- No source-browser-first information architecture.
- No raw provider, tool, normalizer, worker, artifact field, or secret names in user-facing copy.
- `AgentFinalReadModel.finalText` remains the only final answer source.

`AgentWorkspaceV2` remains an internal compatibility/debug surface opened from task context when needed. It is not the default product shell.

## Agent Runtime Core

`Agent Runtime Core` owns product-runtime decisions and authoritative artifacts:

- capability catalog normalization;
- route planning and `core-route-plan.json`;
- tool selection diagnostics;
- GateEngine decision classes;
- final read model construction;
- authoritative final output writing;
- capability-loop read models;
- memory and subagent contract read models;
- CMC-vs-Pi runtime tool dispatch;
- deterministic fallback and degraded market final copy.

The Core boundary keeps business decisions out of the daemon host shell and out of Swift UI state.

## Daemon Shell

The daemon is the local host process. It keeps host responsibilities only:

- HTTP and SSE endpoints;
- local auth token;
- Mongo connection lifecycle;
- run/session/task filesystem paths;
- local process and script boundaries;
- low-level provider transport functions until they are large enough to extract into provider adapters.

The daemon must not become the product brain again. New planner, gate, final-output, capability-loop, memory, or subagent decisions belong in Core modules.

## Pi Kernel

Pi remains the agentic kernel for extension/session/tool execution. It does not own:

- public product capability names;
- final output authority;
- mutation commit policy;
- CMC/equity evidence gates;
- Swift presentation contracts.

The app may adopt more Pi features later, but those features must enter through Core contracts.

## Capability Packages

Current packages:

- `CMC Skill Hub`: crypto market research and CMC returned-result display.
- `Markets Research`: equity/cross-asset research framework and dispatcher; live equity provider remains deferred.
- `Office / Meeting`: meeting minutes and document draft tasks.
- `WeChatCLI`: local read-only source connector for group messages and evidence.
- `Context Plane`: bounded local context pack and source-trust artifacts.

Capability packages expose user-understandable task intents. Internal tools and providers stay hidden.

## Active Source Of Truth

Use these files as current architecture/product truth:

- `PRODUCT.md`
- `DESIGN.md`
- `wiki/prd/2026-06-11-agent-workbench-product-redesign-prd.md`
- `wiki/architecture/2026-06-11-agent-workbench-interaction-redesign.md`
- `wiki/architecture/2026-06-12-agent-runtime-core-pi-kernel-redesign.md`
- `wiki/state/2026-06-12-agent-runtime-core-pi-kernel-gate-cleanup-state.md`
- `wiki/architecture/2026-06-12-markets-research-capability-package-integration.md`

Historical docs remain under `wiki/history/` and are decision background only.

## Cleanup Record

This cleanup pass:

- keeps `Workbench / History / Settings` as the product navigation;
- moves WeChat, Token, and Watchlist into `History` filters;
- keeps Ops under `Settings` diagnostics;
- keeps Agent Console as internal compatibility/debug;
- removes OS noise such as `.DS_Store`;
- narrows `PROJECT_WIKI.md` to current active architecture, QA, and next actions;
- preserves history docs instead of deleting decision context.
