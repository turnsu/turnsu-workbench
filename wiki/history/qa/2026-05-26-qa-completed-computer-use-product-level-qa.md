# 2026-05-26 Computer Use Product-Level QA

## Scope

- Product under test: `wechat-intelligence-radar-mvp`.
- Method: Computer Use desktop walkthrough, local Swift launch checks, and runtime artifact inspection.
- Date/time: 2026-05-26, Asia/Hong_Kong.
- Safety boundary: did not operate the real WeChat app, did not run `wechat-cli init/history/search`, did not call live MCP/RPC, and did not export data outside the project.

## User Journey Attempted

| Step | User intent | Method | Result |
| --- | --- | --- | --- |
| 1 | Launch desktop app from local build | `swift run WeChatIntelligenceRadar`, then Computer Use app discovery | App appeared through bundle id `local.wechat-intelligence-radar.mvp`, but the visible window was the older dashboard UI. |
| 2 | Validate first screen | Computer Use `get_app_state` | First screen showed `QIAOMU RADAR`, metrics, briefing, signal lists, source ranking, and old Agent console. |
| 3 | Try navigation from the old visible UI | Computer Use clicked sidebar item `信号流` | The old visible UI did not expose the new Terminal/Crystal workspace shell. |
| 4 | Verify current build artifact | Shell artifact check | Direct SwiftPM binary contained `QIAOMU TERMINAL`, `Crystal Stream`, and proactive console symbols. The `.app` bundle binary only exposed old UI text before local build-artifact replacement. |
| 5 | Launch current app bundle after local build-artifact replacement | `open .build/.../WeChatIntelligenceRadar.app` and Computer Use | App process started, but Computer Use timed out reading state; System Events reported no window names. Current UI could not be fully operated at user level. |
| 6 | Validate backend/runtime product state | `jq` against runtime artifacts | Latest proactive runtime artifacts exist and are internally linked, but the latest run produced 2 crystals, not the planned minimum of 3. |

## Runtime Evidence

- Latest session: `runtime/sessions/latest-session.json`
  - `runID`: `run-e500d0e1-4a2d-453a-9f88-8fb084a4a115`
  - `status`: `degraded`
  - `sourceFreshness`: `market-bridge=stale`, `onchain-bridge=degraded`, `wechat-export-bridge=blocked`
  - `createdCrystalRefs`: 2
  - `generatedProposalRefs`: 2
  - `memoryRefs`: 3
  - `handoffRefs`: 1
- Crystal store: `runtime/crystals/crystals.json`
  - Count: 2
  - Current examples: `BTC fused signal`, `ETH fused signal`
  - Both are marked `freshness=degraded`
- Proposal store: `runtime/proposals/proposals.json`
  - Count: 2
  - Current examples: `Review BTC fused signal`, `Watch ETH fused signal`
- Runtime health: `runtime/health/latest-health.json`
  - `overallStatus`: `degraded`
  - Passing checks include runtime writable, latest run exists, policy matrix, artifact manifest, proactive artifacts, protected refs, import/export boundary, and secrets boundary.
  - Degraded checks include market snapshot freshness and on-chain provider state.

## Findings

| ID | Severity | Area | Evidence | User impact | Recommendation |
| --- | --- | --- | --- | --- | --- |
| QA-P0-001 | P0 | Launch / packaging | `.build/.../WeChatIntelligenceRadar` was dated 2026-05-26 and contained `Crystal Stream`; `.build/.../WeChatIntelligenceRadar.app/Contents/MacOS/WeChatIntelligenceRadar` was dated 2026-05-24 and only exposed old `QIAOMU RADAR` UI before manual replacement. | A user launching the app bundle can see a stale product that does not include Phase 0-5 work. | Add a deterministic app-bundle build step or stop relying on stale SwiftPM `.app` bundle output for desktop QA. Gate release on bundle binary string/version parity with the direct executable. |
| QA-P0-002 | P0 | Current desktop operability | After replacing the local build app-bundle binary and opening it, process `WeChatIntelligenceRadar` started, but Computer Use `get_app_state` timed out and System Events returned no window names. | The current Crystal-first UI cannot be completed through a normal user-level desktop walkthrough. | Debug `applicationDidFinishLaunching` with the current binary inside the app bundle. Add a launch smoke test that asserts a visible window titled `WeChat Intelligence Radar` within a timeout. |
| QA-P1-003 | P1 | Product entry | The only Computer Use-operable first screen was the old dashboard: metrics, briefing, signal list, and old Agent console. | The intended Yansu-inspired Crystal-first workbench is not the visible default in the user walkthrough. | Make `TerminalWorkspaceSidebar` plus `CrystalConsoleView` the verified default in the app bundle, and include a screenshot/automation check in QA. |
| QA-P1-004 | P1 | Phase acceptance | Latest `runtime/crystals/crystals.json` contains 2 crystals, while the phase plan requires at least 3. | The runtime does not yet satisfy the minimum Crystal density expected for a useful agent console. | Update fixture inputs or crystalizer grouping so the local smoke run deterministically emits at least 3 high-quality crystals. |
| QA-P1-005 | P1 | Product trust / status clarity | Latest session is `degraded` because `market-bridge=stale`, `onchain-bridge=degraded`, and `wechat-export-bridge=blocked`. These are correct policy outcomes, but the current user-level UI could not be inspected to confirm explanatory copy. | A user may read `degraded` as product failure rather than expected permissioned-boundary behavior. | In the visible Ops/Run Deck UI, show each degraded source with reason, artifact path, and allowed next action. |
| QA-P2-006 | P2 | Search / command bar | `TerminalTopCommandBar` has local `@State private var searchText`, but no command/query dispatch is wired. | The `Search / CA / symbol` field appears functional but does not filter or navigate. | Route search text into `RuntimeQuery` for messages, tokens, crystals, proposals, and artifacts. |
| QA-P2-007 | P2 | Handoff lifecycle | `runtime/handoffs/` already contains multiple generated handoff JSON files and `index.json`; no user-visible retention or cleanup control was verified. | Repeated QA or product use can accumulate stale handoffs and confuse handoff selection. | Add retention settings, explicit delete/archive actions, and a handoff status filter. |
| QA-P2-008 | P2 | Automation readiness | Computer Use can read the old UI tree, but current UI launch either has no visible window or an inaccessible window tree. | Product-level QA cannot reliably catch UI regressions. | Add an accessibility-friendly UI smoke mode with bounded data and a stable launch path, then assert key labels: `Crystal Stream`, `Agent Proposal`, `Memory Review`, `Handoff Builder`, and `Bridge Contracts`. |
| QA-P2-009 | P2 | Mixed language polish | Old operable UI and current source combine Chinese labels with English panel names and actions, for example `Agent 操作台`, `Search / CA / symbol`, `Refresh`, `Useful`, `False`, `Handoff`. | The product feels more like an internal prototype than a coherent desk application. | Decide on bilingual system rules or a primary UI language, then apply consistently across workspace nav, inspector actions, and Ops panels. |
| QA-P3-010 | P3 | Test strategy | `swift test` validates compilation of framework-free checks, while visible UI behavior depends on manual app launch. | Build success can mask desktop launch regressions. | Add a non-network UI smoke check or an app lifecycle test that fails when the main window is absent. |

## Positive Findings

- The runtime/data/Ops backend is materially present: sessions, crystals, proposals, memory, handoffs, bridges, health, and manifest artifacts exist.
- Policy boundaries are respected in artifacts: live WeChat is blocked, export requires confirmation, Swift does not store secrets, and live on-chain is degraded instead of fabricated.
- The old visible dashboard remains coherent as a static intelligence board, which means the earlier MVP surface still has a usable fallback.

## Product QA Conclusion

Original conclusion before fixes: not pass for full user-level product QA.

Post-fix conclusion on 2026-05-26: pass for local MVP acceptance with one tooling caveat. The user-opened product surface now shows the current Crystal-first console, including Crystal Stream, action proposal, memory review, handoff builder, Inspector, and Run Deck. Runtime smoke now deterministically emits 3 crystals and 3 proposals. App-bundle launch is no longer dependent on stale SwiftPM bundle output.

Tooling caveat: direct Computer Use state capture may still fail to attach to the macOS window in some runs. Product acceptance is now covered by a deterministic app-bundle build script, a bounded UI smoke mode that asserts a visible `WeChat Intelligence Radar` window, LaunchServices `open -W` verification, and the user-provided screenshot of the current UI.

## Follow-Up Gate Status

Post-fix gate status:

1. Pass: `swift build`, `swift test`, and `swift run WeChatIntelligenceRadar --smoke-check` pass through scratch-path validation.
2. Pass: opening the app bundle shows the current Crystal-first UI, not the old dashboard.
3. Replaced for this checkpoint: direct Computer Use attachment remains a tooling caveat, but UI smoke plus LaunchServices launch plus user screenshot now verifies the main window.
4. Pass: runtime smoke emits 3 crystals.
5. Pass: Run Deck/Ops UI explains `degraded`, `blocked`, and `stale` source states with artifact/source context and allowed local actions.

## Fix Implementation Record

| ID | Status | Fix |
| --- | --- | --- |
| QA-P0-001 | Fixed | Added deterministic `scripts/build-debug-app-bundle.sh` output at `.build/debug-app/WeChatIntelligenceRadar.app`, removed stale app-bundle paths before packaging, copied the current executable and resource bundle, and ad-hoc signed the bundle. |
| QA-P0-002 | Fixed with tooling caveat | Added `--ui-smoke-check` app mode and explicit window creation/activation. Direct executable UI smoke asserts title, root content, visibility, and `windowNumber`; LaunchServices `open -W` path passes. |
| QA-P1-003 | Fixed | Current app bundle launches the Crystal-first workspace. User-provided screenshot verifies the visible page contains Crystal Stream, Inspector, proposals, memory, handoff, and Run Deck. |
| QA-P1-004 | Fixed | Updated fixture coverage so the default month smoke run produces BTC, ETH, and SOL crystals. |
| QA-P1-005 | Fixed | Run Deck/Ops panels show degraded/blocked/stale bridge and source states with localized status labels, reasons, and allowed local actions. |
| QA-P2-006 | Fixed | Routed the command/search field into `DashboardViewModel.searchQuery` and filtered messages, tokens, crystals, proposals, handoffs, and watchlist entries from runtime state. |
| QA-P2-007 | Fixed | Added handoff archive and purge commands, idempotent index updates, and UI controls for archiving and clearing archived handoffs. |
| QA-P2-008 | Fixed | Added UI smoke mode and app-bundle launch verification so launch regressions fail before manual walkthrough. |
| QA-P2-009 | Improved | Applied Chinese-first labels across navigation, deck tabs, actions, status copy, and empty states. Domain terms such as Crystal, Token, Inspector, and Run remain where they are product concepts. |
| QA-P3-010 | Fixed | Added non-network UI smoke check and app-bundle script verification to complement `swift test` and runtime smoke. |

## Fix Verification Evidence

| Check | Result |
| --- | --- |
| `swift build --scratch-path /private/tmp/wechat-radar-build` | Pass: `Build complete! (0.31s)`. |
| `swift test --scratch-path /private/tmp/wechat-radar-test-build` | Pass: `Build complete! (182.90s)`. |
| `swift run --scratch-path /private/tmp/wechat-radar-build WeChatIntelligenceRadar --smoke-check` | Pass: `runID=run-7c2fe19c-a6cc-43b4-b053-5a597a46f6f6`, `status=degraded`, `freshness=degraded`. |
| Runtime artifact query | Pass: `runtime/crystals/crystals.json` count `3`, `runtime/proposals/proposals.json` count `3`, latest session has `createdCrystalRefs=3` and `generatedProposalRefs=3`. |
| `scripts/build-debug-app-bundle.sh` | Pass: produced `.build/debug-app/WeChatIntelligenceRadar.app` from the current executable and resource bundle. |
| `.build/debug-app/WeChatIntelligenceRadar.app/Contents/MacOS/WeChatIntelligenceRadar --ui-smoke-check` | Pass: `ui_smoke_visible=true`, `ui_smoke_content=true`, `ui_smoke_window_number=242824`, `ui_smoke=pass`. |
| `open -W -n .build/debug-app/WeChatIntelligenceRadar.app --args --ui-smoke-check` | Pass: exited successfully through the user-style app-bundle launch path. |
| User-level visual check | Pass: user-provided screenshot shows the current Crystal-first console, not the old dashboard. |

Note: the sandboxed `swift run` path initially failed because Swift/Clang attempted to write module cache files under `/Users/chenge/.cache`. The validation passed after running the same command with approved elevated permissions. The project script uses `/private/tmp/wechat-radar-build` as the default scratch path to avoid stale `.build` app-bundle behavior.
