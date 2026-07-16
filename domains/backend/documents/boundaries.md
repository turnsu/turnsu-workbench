# Backend Boundaries

## Backend Owns

- Product persistence.
- Product-safe read models.
- Runtime command/query/mutation bridge.
- Daemon process boundary.
- Local auth/path/env handling.
- App/Web API shape once Web exists.
- Storage lifecycle and migration notes.

## Backend Does Not Own

- App-native layout.
- Web interaction design.
- Agent prompt content.
- Skill package content.
- Provider reasoning policy beyond process/API enforcement.

## Backend Can Depend On

- Agent outputs after they are converted into product-safe read models.
- Frontend requests expressed as product actions.
- Shared schemas where needed.

## Separation From Agent

Backend should answer:

- Where is the data?
- How is it stored?
- Which process handles the request?
- What read model is safe for UI?
- What mutation is allowed at product boundary?

Agent should answer:

- What should be reasoned about?
- Which capability or tool path is relevant?
- What evidence is needed?
- What final content or structured result should be produced?
