# CMC Internal Tools

Registered runtime-only tools:

- `cmc.read_market_evidence`
- `cmc.daily_market_overview`
- `cmc.crypto_macro_overview`
- `cmc.detect_market_regime`
- `cmc.track_social_price_divergence`
- `cmc.classify_kline_pattern_quality`
- `cmc.request_mcp_refresh`

These tools are resolved from public skills/extensions by Agent Runtime Host.
CMC provider execution is daemon-managed: official MCP HTTP, MCP bridge, CMC REST,
normalized file, then fixture fallback. Only MCP HTTP/bridge or REST success may
be marked live/fresh. Fixture/manual/normalized-file data must never be marked live.
