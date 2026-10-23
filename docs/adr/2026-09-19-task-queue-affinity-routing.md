---
status: accepted
date: 2026-09-19
area: [backend]
supersedes: []
superseded-by: null
---

# Every queue task declares which runtime owns it

## Context

Graphile Worker jobs all live in one Postgres-backed queue, but issue #91
stands up two long-lived composition roots against it: an `api` runtime and
an `agents` runtime. Each runtime registers only the handlers it owns — a
`TaskList` passed to `run()` is total for the task names it claims, so a job
whose name isn't in the runner's `TaskList` simply has no handler to run.
Before #91 can split the queue across two runners, every task name — core,
transitional (`heartbeatFire`), and module-contributed — needs an
unambiguous, closed answer to "which runtime handles this," decided once
rather than re-derived per runner or left to whichever runtime happens to
register a matching handler first.

Module tasks are the harder case: modules are loaded dynamically
(`@semprec/module-registry`), so the affinity data can't be a hardcoded
switch in `@semprec/data` — it has to travel with the module's own manifest
and be validated at load time, the same way the manifest's other
choke-point-relevant fields already are.

## Decision

Every queue task carries a mandatory `queueAffinity: 'api' | 'agents'`:

- **Core and agent tasks**: `@semprec/queue` exports `CORE_TASK_AFFINITY`
  (one entry per `CORE_TASK_NAMES` name) and `AGENT_TASK_NAMES` (the closed
  three-name agents catalog) as plain data, not derived from any registry.
- **Module tasks**: `ModuleTaskDescriptor` in `@semprec/module-registry`
  gains a mandatory `queueAffinity` field, validated by the manifest's Zod
  schema (`z.enum(MODULE_TASK_AFFINITIES)`) — a missing or unknown value
  fails `ModuleRegistry.loadModule` the same way any other invalid manifest
  field does, before the module is ever active.
- **Resolution**: `@semprec/data`'s `resolveTaskAffinitySets(moduleRegistry)`
  merges the core/agent catalogs with the registry's loaded module tasks
  into two disjoint `Set<string>`s (`api`, `agents`), throwing if a module
  task's name collides with a core/agent name or with another module's task
  in the other set. This is the single function both of #91's composition
  roots call before reporting readiness, so "which runner owns this task" has
  exactly one implementation, not one per call site.

`@semprec/module-registry` deliberately does not depend on `@semprec/queue`
(`.dependency-cruiser.cjs` enforces the boundary) — `MODULE_TASK_AFFINITIES`
is a local literal tuple (`["api", "agents"] as const`) rather than an import
of `@semprec/queue`'s `TASK_AFFINITIES`. The two lists are required to stay
identical by convention (both are the fixed two-runtime split this ADR
defines), not by a shared import, because introducing that import would
create the reverse dependency this repository's package graph forbids.

## Consequences

- A new module task without `queueAffinity`, or with any value other than
  `'api'`/`'agents'`, fails to load with an actionable error instead of
  silently landing on whichever runtime's `TaskList` happens to include it.
- Adding a third runtime, or renaming either existing one, is a two-file
  change (`TASK_AFFINITIES` in `@semprec/queue`, `MODULE_TASK_AFFINITIES` in
  `@semprec/module-registry`) plus whatever `resolveTaskAffinitySets` callers
  need updating — not a search-and-replace across every handler registration.
- `resolveTaskAffinitySets` is the one place "does every active task belong
  to exactly one runtime" is provable; #91's composition roots call it at
  startup rather than each re-deriving their own view of task ownership.
- This issue only declares the data. Actually routing jobs to two separate
  `run()` composition roots, and validating a runner's registered handlers
  against its selected affinity set, is #91's scope.
