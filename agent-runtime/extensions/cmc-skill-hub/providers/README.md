# CMC Skill Hub Providers

- `mcpHttpProvider`: calls the official CoinMarketCap MCP streamable HTTP endpoint through the daemon.
- `mcpProvider`: normalized live output produced by MCP HTTP or an explicitly configured MCP bridge.
- `cmcRestProvider`: fallback CoinMarketCap REST refresh when MCP is not configured.
- `normalizedFileProvider`: reads `runtime/market/cmc-skill-hub.normalized.json` when present; never live.
- `fixtureProvider`: deterministic local evidence for smoke tests; never live.
