# Backend Code Ownership Map

## Current Backend-Owned Swift Areas

```text
domains/frontend/app/code/WeChatIntelligenceRadarApp/Services/RuntimeBackend.swift
domains/frontend/app/code/WeChatIntelligenceRadarApp/Services/RuntimeRepository.swift
domains/frontend/app/code/WeChatIntelligenceRadarApp/Services/RuntimeCommand.swift
domains/frontend/app/code/WeChatIntelligenceRadarApp/Services/RuntimeQuery.swift
domains/frontend/app/code/WeChatIntelligenceRadarApp/Services/RuntimeMutation.swift
domains/frontend/app/code/WeChatIntelligenceRadarApp/Services/RuntimeProductServices.swift
domains/frontend/app/code/WeChatIntelligenceRadarApp/Services/AgentDaemonClient.swift
domains/frontend/app/code/WeChatIntelligenceRadarApp/Services/*Store*.swift
domains/frontend/app/code/WeChatIntelligenceRadarApp/Services/*DataAdapter*.swift
```

## Current Backend-Owned Runtime Areas

```text
runtime/
scripts/start-agent-daemon.sh
scripts/stop-agent-daemon.sh
scripts/reset-local-runtime.sh
domains/agent/code/agent-runtime/bin/wechat-agent-daemon.mjs
domains/agent/code/agent-runtime/lib/mongo-store.mjs
```

## Mixed Areas To Split Later

```text
domains/frontend/app/code/WeChatIntelligenceRadarApp/Services/AgentOrchestrator.swift
domains/frontend/app/code/WeChatIntelligenceRadarApp/Services/CapabilityRegistry.swift
domains/frontend/app/code/WeChatIntelligenceRadarApp/Services/PolicyGate.swift
domains/agent/code/agent-runtime/runtime/
domains/agent/code/agent-runtime/control-plane/
```

These contain both backend product boundary and agent execution semantics.

## Future Physical Target

When build paths are ready, backend code can move toward:

```text
domains/backend/code/swift-services/
domains/backend/code/daemon/
domains/backend/code/storage/
domains/backend/code/scripts/
```

Any physical move should update `Package.swift`, daemon scripts, and tests in the same change.
