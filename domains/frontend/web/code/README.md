# Web Code Ownership Map

## Current Build Path

The current Web review prototype lives in:

```text
domains/frontend/web/code/web-prototype/
```

## Current Web-Adjacent Assets

```text
domains/frontend/documents/design/
domains/frontend/documents/design/2026-06-29-relevanceai-authenticated-product-research/
domains/frontend/documents/design/2026-06-29-frontend-interaction-split/
domains/frontend/documents/design/2026-06-22-loopops-v2-prototypes/
```

These are reference assets, not the Web codebase.

## Physical Target

Keep runnable Web code under:

```text
domains/frontend/web/code/
```

Suggested first structure:

```text
domains/frontend/web/code/
  web-prototype/
    src/
    scripts/
    package.json
```

Do not import SwiftUI implementation details into the Web codebase. Share product objects through explicit mock data or shared schema only after the UI shape stabilizes.
