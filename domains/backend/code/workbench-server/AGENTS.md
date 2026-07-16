# Workbench Server Rules

Read the repository `AGENTS.md` and `wiki/architecture/CURRENT_SYSTEM_ARCHITECTURE.md`
before editing this package.

- `@looloomi/workbench-contracts` is the only public schema owner. Do not duplicate public
  request, response, event, or read-model schemas in this package.
- Keep HTTP, application services, product store, compiler, runner, and Agent adapter in
  separate modules with explicit injected ports.
- Do not add Product API routes to `wechat-agent-daemon.mjs` and do not reuse
  `AgentMongoStore` collections for product data.
- Tests use `looloomi_workbench_test` and isolated temporary runtime paths only.
- Persist Run events before making them deliverable. Product responses must not expose
  provider payloads, internal tools, secrets, bearer tokens, or artifact paths.
- Keep worker file ownership disjoint. Do not edit a sibling module owned by another
  active work package.
