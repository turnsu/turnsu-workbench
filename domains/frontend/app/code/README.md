# App Code Ownership Map

## Current Build Path

SwiftPM currently builds the app from:

```text
domains/frontend/app/code/WeChatIntelligenceRadarApp
```

Do not move this directory without updating `Package.swift`, build scripts, test paths, and docs in the same change.

## App-Owned Files Today

```text
domains/frontend/app/code/WeChatIntelligenceRadarApp/Views/
domains/frontend/app/code/WeChatIntelligenceRadarApp/ViewModels/
domains/frontend/app/code/WeChatIntelligenceRadarApp/Models/*Interaction*
domains/frontend/app/code/WeChatIntelligenceRadarApp/Models/*Layout*
domains/frontend/app/code/WeChatIntelligenceRadarApp/Resources/
domains/frontend/app/code/WeChatIntelligenceRadarApp/WeChatIntelligenceRadarApp.swift
```

## Mixed Ownership To Split Later

```text
domains/frontend/app/code/WeChatIntelligenceRadarApp/Services/
domains/frontend/app/code/WeChatIntelligenceRadarApp/Models/
domains/frontend/app/code/WeChatIntelligenceRadarApp/Fixtures/
```

These currently mix App, Backend, and Agent adapter concerns. Do not treat all files under `domains/frontend/app/code/WeChatIntelligenceRadarApp` as frontend just because they are compiled into the app target.

## Current Physical Target

```text
domains/frontend/app/code/WeChatIntelligenceRadarApp/
```

`Package.swift` now points at this directory for the executable target. Tests live under `domains/frontend/app/code/Tests/WeChatIntelligenceRadarAppTests/`.
