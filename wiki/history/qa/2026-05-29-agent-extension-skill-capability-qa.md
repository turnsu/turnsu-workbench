# Agent Extension / Skill Capability QA

Date: 2026-05-29

## 1. Conclusion

This QA pass verifies the Agent Runtime Host extension/skill path at the agent layer:

- WeChatCLI extension basic integration works through fixture/export normalization.
- Live WeChat and live `wechat-cli` command execution remain blocked.
- CMC MCP live evidence was collected through the available CoinMarketCap MCP tool, normalized into the project's CMC extension input artifact, and consumed by the `cmc-skill-hub` extension through `normalizedFileProvider`.
- The frontend public surface remains skill/extension only; raw tools/providers/modules are not exposed by `/capabilities`.

The CMC live test is project-closed-loop rather than daemon-direct-MCP: the external MCP result is written as `runtime/market/cmc-skill-hub.normalized.json`, then the agent runtime reads it through its existing extension package contract.

## 2. CMC MCP Live Evidence

Execution:

```text
mcp__crypto_skill_hub__.execute_skill
unique_name: daily_market_overview
parameters: { preview: true }
```

Result summary:

- status: `ok`
- timestamp: `2026-05-29T12:49:15.019024+00:00`
- confidence: `medium`
- regime: `headwind_tightening`
- risk bias: `defensive_research_only`
- composite score: `58`
- raw response: not persisted in wiki or runtime

Normalized project artifact:

```text
runtime/market/cmc-skill-hub.normalized.json
```

Normalized fields:

- provider: `mcpProvider`
- skill: `daily_market_overview`
- status: `ok`
- market_read.regime: `headwind_tightening`
- watchlist count: `5`

## 3. Agent Runtime Test

Command:

```bash
cd agent-runtime
npm test
```

Result:

```text
control_plane_smoke=pass
sessionID=session-331cc79d-9819-4fa5-91dd-a3b477132ff0
runID=run-3f03fa84-0e31-4fc0-93d3-b694d13d9b67
taskID=task-deddd4f3-66a0-4a0a-8978-8d4d7b3fd0a6
status=completed
async_smoke=pass
runID=run-27179a13-2d02-4c4c-b0e0-0994f41781a3
taskID=task-5c559b4e-be89-4b2f-9393-cc985cd29cff
```

Latest async artifact root:

```text
runtime/agent/runs/run-27179a13-2d02-4c4c-b0e0-0994f41781a3
```

Run manifest checks:

- status: `completed`
- currentStage: `final_output`
- internalToolsExposed: `false`
- selectedSkillIDs: `wechat-onchain-intelligence`, `cmc-market-radar`
- selectedExtensionIDs: `wechat-cli-export-bridge`, `cmc-skill-hub`
- context source count: `7`
- context chunk count: `7`
- raw private transcript included: `false`
- full raw content included: `false`
- secret material included: `false`

## 4. WeChatCLI Extension QA

Artifact:

```text
runtime/agent/runs/run-27179a13-2d02-4c4c-b0e0-0994f41781a3/wechat-cli-import.json
```

Verified fields:

- source: `fixture_export`
- policy: `pass`
- messageCount: `3`
- artifactPath: `runtime/wechat/messages.normalized.json`
- liveCommandsBlocked: `true`
- notExecuted:
  - `wechat-cli init`
  - `wechat-cli history`
  - `wechat-cli search`
  - `wechat-cli sessions`
  - `wechat-cli new-messages`

Policy evidence:

- `wechat_cli.import_export_file` actionIntent: `import_user_or_fixture_wechat_export`
- displayTitle: `导入微信导出记录`
- publicSummary: `只处理 fixture 或用户提供的导出文件，不运行 live wechat-cli。`

Control-plane smoke also passed the blocked live-command gate:

```bash
node agent-runtime/control-plane/smoke-test.mjs
```

Result:

```text
control_plane_smoke=pass
```

## 5. CMC Extension QA

Artifact:

```text
runtime/agent/runs/run-27179a13-2d02-4c4c-b0e0-0994f41781a3/cmc-daily_market_overview.json
```

Verified fields:

- provider: `normalizedFileProvider`
- skillName: `daily_market_overview`
- marketSnapshotArtifact: `runtime/market/latest-market-snapshot.json`
- evidence.market_read.regime: `headwind_tightening`
- evidence.watchlist count: `5`

Market snapshot:

```text
runtime/market/latest-market-snapshot.json
```

Verified fields:

- freshness: `fresh`
- sourceName: `CMC Skill Hub normalizedFileProvider`
- upstreamStatus: `normalized_provider`
- asset count: `5`
- first asset source: `cmc_skill_hub_normalizedFileProvider`
- first asset isLive: `true`

Note: `mcpProviderStatus` remains `missing_config_local_provider_used` inside the daemon artifact because the daemon did not directly call MCP. The live MCP evidence entered through the supported normalized-file provider, which is the intended project-closed-loop boundary for this QA.

## 6. Public Surface QA

The daemon was started locally on a temporary test port and queried through `/capabilities`.

Result:

```json
{
  "internalToolsExposed": false,
  "skillCount": 7,
  "extensionCount": 3,
  "toolCount": 0,
  "extensions": [
    "wechat-cli-export-bridge",
    "cmc-skill-hub",
    "local-memory"
  ]
}
```

The local daemon process was stopped after the query.

## 7. Safety Checks

Search for live command strings in the latest run only found the `notExecuted` list:

```text
wechat-cli init
wechat-cli history
wechat-cli search
wechat-cli sessions
wechat-cli new-messages
```

Search across redacted tool-call surfaces returned no matches for sample private text, sender metadata, authorization headers, or API-key patterns:

```bash
rg "Authorization|Bearer |sk-|apiKey|cookie|BTC 今天讨论|ETH CA|sender" \
  runtime/agent/runs/run-27179a13-2d02-4c4c-b0e0-0994f41781a3/tool-calls.json \
  runtime/agent/runs/run-27179a13-2d02-4c4c-b0e0-0994f41781a3/tool-details
```

Protected reference checks:

- `git -C ../wechat-cli_raw status --short`: no changed files
- newer-file check against `../assignment-agent-raw`: no files
- newer-file check against `../wechat-cli_raw`: no files

## 8. Remaining Notes

- The CMC live route is validated as MCP -> normalized artifact -> extension provider -> market snapshot -> agent run.
- The daemon still does not directly call MCP, which is consistent with the current extension package boundary.
- A future regression script could automate this full QA path, but this pass intentionally only adds the wiki report and normalized live evidence artifact.
