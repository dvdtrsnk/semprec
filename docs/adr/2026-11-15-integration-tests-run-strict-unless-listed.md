---
status: accepted
date: 2026-11-15
area: [backend]
supersedes: []
superseded-by: null
---

# Integration test files run under strict tenant scope unless a shrink-only list names them

## Context

[[2026-10-05-tenant-scope-propagation]] defines the two modes of `enforceTenantScope`: `warn` logs
`tenant_scope_missing` and continues, `strict` throws `TenantScopeMissingError` before a connection is taken. An unset
variable has been `strict` since issue #1067, and production runs that default. The integration tier did not:
its `globalSetup.ts` set `SEMPREC_TENANT_SCOPE ??= "warn"` for the whole run, and `vitest.integration.config.ts` sets
`LOG_LEVEL=error`, which also hides the `tenant_scope_missing` warning. A code path that lost its scope and was
reached only by ordinary integration tests therefore passed CI and failed in production. Only the isolation suites and
a few other files switched to `strict` for themselves.

Converting the tier at once is not possible. A deterministic sample of thirty files of the tier, run under `strict`,
failed in twenty, where the failures were fixtures and helpers that write without `runInTenant`; the same twenty
passed under `warn`. Roughly two thirds of the tier depends on `warn` today, and converting them is many sources of
work, not one. The e2e tier (`vitest.e2e.config.ts`) shares the same `globalSetup.ts`, and under `strict` most of its
scenarios fail on the same kind of fixture, so it stays on `warn` in this decision.

## Decision

`SEMPREC_TENANT_SCOPE` is chosen per integration test file, not per run.

- `globalSetup.ts` no longer sets the variable. `backend/packages/data/src/testSupport/tenantScopeMode.ts` is a
  `setupFiles` entry of `vitest.integration.config.ts`; before the first test of each file it sets the variable to
  `warn` when the running file's path (relative to `backend/`) is an entry of
  `backend/packages/data/src/testSupport/tenantScopeWarnFiles.json`, and to `strict` otherwise. A file whose path
  cannot be determined makes the setup fail, because either mode would hide the cause. A value the vitest process
  was started with is a developer override and is kept for every file.
- A new integration test file runs `strict`. A file runs `warn` for one of two reasons only: it is listed, or it is
  one of the frozen scope-mode suites, the files that already set or compare the mode themselves in their own code
  (the mode is read on every call, so a file's own switching keeps working after the setup file has run).
- The list started as every integration test file that existed when it was introduced. It only shrinks. Beside it
  `tenantScopeWarnFiles.frozen.json` is a byte copy of that first list and is never edited again.
  `__tests__/tenantScopeWarnFiles.unit.test.ts` fails when the list is unsorted, holds a duplicate, names a missing
  file or a file that is not an integration test file, holds an entry that is not in the frozen file, or when the
  frozen file's SHA-256 (pinned in the test) changes. Adding an entry therefore needs a change of the frozen file and
  of the pinned hash, which the test rejects by design; a renamed file must be converted, not re-listed. The same test
  holds a constant set of the files that mention both `SEMPREC_TENANT_SCOPE` and `"warn"` today (the frozen
  scope-mode suites) and fails for any other integration test file that does, so a new file cannot switch itself to
  `warn`. That set is pinned like the list: the test keeps a never-edited literal copy of its first content with a
  pinned SHA-256, and fails when the live set holds an entry outside that copy, so adding to it needs a change of the
  copy and of the hash. It also only shrinks: a file that stops matching must be removed from the live set.
- Each later source that converts a listed file's fixtures to run under `strict` removes the file from the list (and
  from the constant set of the suites when it was one of them). Nothing is added.
- The e2e tier keeps `warn`: its `test.env` pins `SEMPREC_TENANT_SCOPE: process.env.SEMPREC_TENANT_SCOPE ?? "warn"`,
  as the unit tier is pinned, and gets no setup file.
- `__tests__/tenantScopeModeDefault.test.ts` is an integration test file that is not listed. It fails when the tier
  runs it under `warn` because it asserts the mode and that a query through `createPool` outside any scope rejects
  with `TenantScopeMissingError`.

## Consequences

A new integration test, and every converted one, can no longer reach a data function outside a tenant scope without
failing, which closes the gap between the tier and production for them. The listed files keep today's behaviour, so
the tier passes unchanged and the warning stays hidden for them until they are converted; the list is the visible
backlog, and its length is a number that falls. The decision is not finished until the list is empty.

The mode is decided once per file at setup. A file that wants the other mode for some of its cases switches it
itself, as the isolation suites do; the setup file does not make that unnecessary. An explicit
`SEMPREC_TENANT_SCOPE` in the environment of the vitest process (for example `strict`, to find the files that still
need `warn`) applies to every file of the tier, listed or not.

[[2026-10-05-tenant-scope-propagation]] is not edited. This decision adds to it the rule for how the integration
tier selects the mode its text describes.
