# LinkCode internal host slice

This slice keeps LinkCode as a reversible local presentation/session host for
native Pi. It does not move Product authority into LinkCode.

LinkCode is BUSL-1.1 source-available. This slice is limited to internal
evaluation; hosted, embedded, redistributed, or otherwise commercially
overlapping use still requires a separate license decision.

Pinned compatibility:

- LinkCode `v0.30.0`, tag commit prefix `da9c0673`
- `@earendil-works/pi-coding-agent` `0.85.1`
- Pi provider only; non-empty `mcpServers` is rejected

The exported bridge reads an authorized Project and Work Item from Product API,
lets Pi stage a bounded Work Item proposal, and exposes approval only as a user
command. Applying an approved proposal uses the Product native-client bearer
token, current `ETag`, and a deterministic idempotency key. Product API and
PostgreSQL therefore remain responsible for ACL, authorization decisions,
commands, concurrency, and durable Work state.

LinkCode/Pi session content is not sent to Product API. The host must provide a
rotating access-token callback; the bridge does not persist credentials in
LinkCode's local database. Pending proposals are deliberately process-local and
fail closed on restart, while applied state and the authoritative command audit
remain Product-owned.

Import the internal adapter from:

```js
import {
  assertLinkCodePiHostCompatibility,
  createLinkCodeProductApiClient,
  createLinkCodeProductWorkBridge,
  createLinkCodeProductWorkExtension,
} from "wechat-onchain-agent-runtime/integrations/linkcode";
```

The LinkCode application itself is not vendored here. Its root runtime requires
Node 24+, while this Product runtime remains on its pinned Node 22.19+ toolchain;
launch them with isolated Node runtimes instead of replacing the project Node.
