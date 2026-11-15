---
status: accepted
date: 2026-11-15
area: [backend]
supersedes: []
superseded-by: null
---

# Give the workspace roots that the service entries reach the built-root contract and check the entries before a release is promoted

## Context

[[2026-11-03-native-workspace-root-exports]] gave four workspace roots (`@semprec/shared`, `@semprec/queue`,
`@semprec/module-registry`, `@semprec/block-model`) a manifest that makes plain Node select `dist/index.js` while
types, browser-aware consumers and the three backend Vitest tiers keep the source entry. It states that this is not
proof that every compiled service starts and that any newly reached workspace root needs concrete analysis instead
of a wildcard manifest change.

That analysis was made on a private export of the tree, built the way `deploy/deploy.sh` `build_release` builds it,
by running every compiled entry that the deploy scripts, the systemd units and the restore runbook start as a plain
`node <dist entry>` from `backend/` with a scrubbed environment. Seven entries (the migration, seed, tenancy
verification, restore ledger validation, tenant key restore, tenant deletion replay and restore test result CLIs of
`@semprec/data`) already started. The four service entries (`semprec-api`, `semprec-agents`, `semprec-ai-gateway`
and `semprec-transcribe` `dist/serve.js`) failed before any application code with `ERR_MODULE_NOT_FOUND`, because
eight further workspace roots still had `"main": "src/index.ts"` and, for seven of them, no `exports` map. A static
walk of the compiled import graph of all eleven entries finds exactly twelve workspace packages, the four of the
earlier decision and those eight, and no `@semprec/*` subpath import in any compiled file. `deploy.sh` runs the
migration, seed and tenancy steps in the staged release and moves `current` only afterwards, so a release whose
services could not load was promoted and the failure appeared after the switch.

## Decision

The contract of [[2026-11-03-native-workspace-root-exports]] covers eight further roots, because the four service
entries reach them: `@semprec/data`, `@semprec/realtime`, `@semprec/application`, `@semprec/notifications`,
`@semprec/ai-gateway-client`, `@semprec/ai-gateway`, `@semprec/agent-runtime` and `@semprec/credentials`. The list is
closed. `e2e`, `module-boundaries`, `realtime-client` and `release` are not on it, because no compiled entry reaches
them. In each of the eight manifests `main` is `dist/index.js`, `types` stays `src/index.ts`, and the root export has
the same ordered conditions as before: `types: ./src/index.ts`, `browser: ./src/index.ts`,
`default: ./dist/index.js`. `@semprec/data` keeps its `./testSupport` and `./testSupport/mcpContractServers`
subpaths; no other subpath gets an entry.

The same exact test aliases apply: each of the three backend Vitest configurations aliases the eight names, spelled
as `^@semprec/<name>$`, to the package's `src/index.ts`, so the tiers keep testing source and never `dist`. No other
`@semprec/*` import and no subpath is aliased.

A workspace package that a deploy-started entry newly reaches gets the same contract in the same change.
`nativeEntrypoints.e2e.test.ts` and the deploy check are the mechanism that fails when it does not. The test names
every compiled entry that `deploy/deploy.sh`, the units, the timer scripts and `deploy/README.md` mention and fails
when one is missing from the checker's table, and it runs the real compiled entries; the deploy check runs the same
entries before the release is promoted.

The deploy check, `backend/scripts/check-native-entrypoints.mjs`, is run by `deploy.sh` right after the build and
before the release env file, the migration, the seed and the tenancy verification. It starts each of the eleven
compiled entries as `process.execPath <entry>` from the staged `backend/` with an environment of `PATH` and `HOME`
only, so it has no test resolver, loader, `NODE_OPTIONS`, `NODE_PATH` or secret. With no configuration every entry
refuses before it connects or writes anything. An entry passes when its output holds its own refusal and no
module-resolution failure; any failure stops the deploy before `current` and the running services are touched.

## Consequences

The check proves that every compiled entry loads and reaches its configuration refusal. It does not prove that a
service starts: the owned-database start of the gateway, agents and transcribe services is an additional test, and
the start of `semprec-api` under strict tenant scope is outside this decision.

A new unit or script that starts another compiled entry fails the coverage case until the entry is added to the
checker's table; a new workspace package reached by an entry fails the checker until its manifest follows the
contract. Both are failures of a test or of a staged release, never of a running service.

Each new root costs one manifest change and three exact aliases. The earlier decision's accepted text is unchanged;
this decision extends its closed list and does not replace it.
