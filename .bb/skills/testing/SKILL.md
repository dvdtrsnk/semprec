---
name: testing
description: "How tests are written in this repository - test behaviours and acceptance criteria rather than branches, table-driven tests and shared fixtures, both sides of every permission check, the harness the issue names, fixtures through production writes, real Postgres, real multi-tenant isolation through the shared harness, and no test that passes by accident. Load this BEFORE writing or changing any test, and before claiming a change is covered. Triggers on: *.test.ts, *.unit.test.ts, *.e2e.test.ts, describe(, it(, test(, it.each, expect(, beforeEach, afterAll, vitest, globalSetup, testSupport, fixture, createTestTenant, createRuntimeRolePool, withTenantTransaction, getTestPool, resetDatabase, an Acceptance criterion that names a test, a review finding about test coverage or test correctness, and the mobile tests: commonTest, *Test.kt, src/androidTest, *Tests.swift and XCTestCase. Skip only when the change adds no behaviour and touches no test."
---

# Tests that fail when the code is wrong

Policy and backend tiers: `docs/architecture/testing.md`. This skill is the
working checklist.

Mobile tests (Kotlin `commonTest`, Android `src/test` and `src/androidTest`,
the Swift XCTest bundles under `mobile/apple/`) follow sections 1–4, 7–9 and
the typed-boundary rule of section 10. Sections 5 and 6 and the SQL rule of
section 10 do not apply there: `mobile/` has no database and no vitest. Which
layer tests what is in `shared-viewmodel` (§3), `kmp-shared`,
`android-compose`, `apple-swiftui` and `mobile-navigation`, and `mobile-verify`
runs them.

## 1. Test behaviours, not branches

Write the test list from the issue's Acceptance criteria and the behaviours a
caller can observe: the result, the rows written, the jobs enqueued, the status
a route returns, and the reachable failure paths (not found, refused, provider
failed, malformed input at an edge).

- Each clause of an Acceptance criterion that names a test is asserted; a
  two-part criterion needs both parts.
- Do not add a test just because a branch exists. A reachable branch that
  matters is covered by the behaviour it produces.
- No test for an unreachable or defensive branch, one that only guards a state
  the types or the database already exclude. If it seems to need a test,
  remove the branch instead.
- Variations of one behaviour are one `it.each` / `describe.each` table, not
  copies of a test body. Repeated setup belongs in a shared fixture in
  `testSupport/`, not re-written per file.

## 2. Both sides of every permission or guard

For a check that refuses something, test the refused path *and* the allowed
path, through the real entry point. A refusal-only test still passes when the
wiring that grants the allowed case is removed.

## 3. Re-check existing tests after you add a condition

A new guard can make an existing test pass for the wrong reason: a race, retry
or already-decided test may now stop at your check before reaching the path it
is named for. Make sure each nearby test still reaches its path.

## 4. The tests the issue lists are deliverables

When the issue names a test, a harness or a file, write that test with that
harness, against the real composition. A pure-helper test does not stand in
for the integration test the issue asked for. If you cannot deliver one, say so
in the pull request; never substitute quietly.

## 5. Multi-tenant isolation through the shared harness

Every multi-tenant test uses `backend/packages/data/src/testSupport/tenantFixtures.ts`;
no test builds its own tenant or role setup. Isolation is tested for every
read and write path that crosses tenant data.

- Assert isolation through `createRuntimeRolePool(adminPool, role)`, never the
  superuser pool from `getTestPool()`, which bypasses row-level security.
- A cross-tenant test needs two tenants (`createTestTenant`), not two users.
- Test SQL runs in `withTenantTransaction(pool, tenantId, fn)`; production code
  in `runInTenant`/`runAsSystem`. A verification read opens a new scoped
  transaction.
- Never rely on `app_sole_tenant()`.

## 6. Real Postgres, fixtures through production writes

Integration tests run against the real Postgres `globalSetup` provisions; no
database mocks or stubbed query layers. Build state with the functions
production uses (the choke point, the owning store, `testSupport/` helpers).
Raw SQL only for a state the API cannot produce, with a one-line reason.

## 7. Assert what did not happen, exactly

On a refusal or failure path, assert no row written, no job enqueued, no
notification sent, as well as the error. On a success path assert exact counts
and values. Each scenario gets its own fixture.

## 8. Tests must not depend on luck

- Restore anything global you change (`process.env`, registries, fake timers).
- Never patch a pooled client and return it to the pool.
- No dependence on wall-clock time, unordered rows or one runtime's ICU output.
- Settle every un-awaited promise before releasing what it uses; close every
  pool or client you create.
- Observe a dependency through its public API, not its private tables.

## 9. A concurrency claim needs a concurrent test

If the code claims serialisation, mutual exclusion or ordering, test it with
real concurrency (worker concurrency ≥ 2, explicit start/finish signals with
timeouts, assertions that hold whichever side starts first).

## 10. Repository rules apply to tests too

- **Typed boundaries, mobile included.** Parse `unknown` instead of casting it.
  In Kotlin, no `!!` and no unchecked `as` or `get<T>` on a value from outside
  the code's own types; in Swift, no force-unwrap, `try!` or `as!` on one — use
  `XCTUnwrap` and a checked cast.
- **SQL in `backend/` tests**: every `query` has a row type; never interpolate
  values into SQL or DDL.

## Before committing, check

- [ ] Every Acceptance criterion is asserted; tests describe behaviours, not branches.
- [ ] No test exists only for a defensive or unreachable branch.
- [ ] Variations are tables; repeated setup is a shared fixture.
- [ ] Every guard has an allowed-path test as well as a refused-path test.
- [ ] Every test the issue names exists, with the harness it names.
- [ ] Isolation tests use the shared harness, a runtime-role pool and two tenants.
- [ ] Fixtures use production writes; failure paths assert absent side effects.
- [ ] No test depends on time, order, shared mutable state or private internals.
- [ ] No test casts a boundary value unchecked, mobile tests included.
