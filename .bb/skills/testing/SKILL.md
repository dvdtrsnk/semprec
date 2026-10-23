---
name: testing
description: "How tests are written in this repository so they actually fail when the code is wrong - one test per branch you add, both sides of every permission check, the harness the issue names, fixtures through production writes, real multi-tenant isolation, and no test that passes by accident. Load this BEFORE writing or changing any test, and before claiming a change is covered. Triggers on: *.test.ts, *.unit.test.ts, *.e2e.test.ts, describe(, it(, test(, expect(, beforeEach, afterAll, vitest, globalSetup, testSupport, fixture, createTestTenant, createRuntimeRolePool, withTenantTransaction, getTestPool, resetDatabase, an Acceptance criterion that names a test, and a review finding about test coverage or test correctness. Skip only when the change adds no behaviour and touches no test."
---

# Tests that fail when the code is wrong

Test findings are the largest single group of blocking review findings on this
repository: about a quarter of every finding the implementing agent later
fixed. They are almost never "there is no test". They are "a branch has no
test", "the test passes even with the code removed", or "the test does not use
the harness the issue asked for". Each rule below exists because it was missed
repeatedly.

The three test tiers and which one a file belongs to are defined in
`.bb/AGENTS.md` (`## Tests`).

## 1. One named test for every branch you add

Before you push, list every branch the diff adds or changes, and name the test
that reaches *that branch on its own*:

- each `if`/early `return`/`throw`, each arm of a ternary or `??`, each
  `catch`;
- each not-found outcome — one per lookup, not one for the whole function;
- each mode or flag value (live vs dry-run, default vs override);
- each error-to-status mapping on a route, including the method, body-size and
  malformed-input cases of a new endpoint;
- each call site of a guard you added in several places, not only the primary
  one;
- each clause of an Acceptance criterion that names a test — a two-part
  criterion needs both parts asserted.

Why: a branch with no test can be deleted and every test still passes. That
is exactly the sentence the review bot writes, and it cannot be argued with.

When a review finding names one untested branch, sweep its siblings in the same
function before replying — reviewers report the first one they see, not all of
them.

## 2. Both sides of every permission or guard

For a check that refuses something, test the refused path *and* the allowed
path, end to end through the real entry point. A test of only the refusal
still passes when the wiring that grants the allowed case is removed, so it
proves the guard exists but not that it is connected.

## 3. Re-check existing tests after you add a condition

A new guard can make an existing test pass for the wrong reason. A race,
retry or already-decided test that used to reach the code it is named for may
now stop at your new check first. After adding a condition, go through every
existing test that touches the same code. Make sure each one still reaches the
path its name describes, and change its fixture if it no longer does.

Why: this pattern produces passing, green, meaningless tests that nobody notices
until the guarded behaviour regresses.

## 4. The tests the issue lists are deliverables

When the issue names a test, a harness or a file, write that test with that
harness, at the call site and against the real database. A test of a pure
helper does not stand in for the integration test the issue asked for, and a
"functionally equivalent" harness is not the one it named. If you cannot
deliver a required test, say so in the pull request description. Do not
quietly substitute another one.

Why: the issue author chose the harness because it exercises the property
that matters (tenant isolation, real concurrency, the production composition
root). A substitute usually skips exactly that property.

## 5. Multi-tenant tests prove isolation only on a runtime-role pool

The harness lives in `backend/packages/data/src/testSupport/tenantFixtures.ts`.
Its header comment is the reference; the rules that keep failing are:

- Assert isolation through a pool from `createRuntimeRolePool(adminPool, role)`.
  Never use the superuser pool from `getTestPool()`, because superusers and
  table owners bypass row-level security and such a test proves nothing.
- A cross-tenant test needs two tenants (`createTestTenant`), not two users in
  one tenant.
- Seed and assert inside a tenant: `withTenantTransaction(pool, tenantId, fn)`
  for test SQL, and `runInTenant`/`runAsSystem` from
  `backend/packages/shared/src/tenantScope.ts` around production code.
  `withTenantTransaction` sets `app.tenant_id` transaction-locally, so a query
  after its `COMMIT` runs unscoped again. Open a new scoped transaction for a
  verification read.
- Do not lean on `app_sole_tenant()`. It returns the tenant only while exactly
  one tenant exists, so a test that passes through it stops testing anything
  the moment a second tenant is created.

Why: `docs/adr/2026-10-03-tenant-isolation-through-row-level-security.md` and
`docs/adr/2026-10-05-tenant-scope-propagation.md`.

## 6. Fixtures go through production writes

Build test state with the same functions production uses: the choke point, the
owning store's functions, and the helpers in `testSupport/`. Use raw SQL
`INSERT`/`UPDATE` only for a state the API cannot produce, and put a one-line
comment on it saying why.

Why: a raw-SQL fixture skips the hooks, ownership checks and derived fields
the choke point applies. The test then runs against a state that production
can never reach, and it breaks silently when that write path changes.

## 7. Assert what did not happen, exactly

On a refusal or failure path, assert the absence of side effects as well as
the error. That means no row written, no job enqueued, no notification sent,
no heartbeat fired. On a success path, assert the exact count and the exact
values routed, not a delta of a running total. Give each scenario its own fixture
rather than chaining scenarios in one test.

Why: "it threw the right error" is also true of an implementation that wrote
half the state first and then threw.

## 8. Tests must not depend on luck

- Restore anything global you change: `process.env`, module-level registries
  (reset them in `beforeEach`), fake timers.
- Never patch a pooled client and return it to the pool. Take a dedicated
  client or pool for fault injection.
- Never depend on wall-clock time, on row order without `ORDER BY`, or on one
  runtime's ICU output. Derive locale-formatted expectations with the same
  `Intl` API the code uses.
- Settle every deliberately un-awaited promise (attach a handler, await it)
  before the resources it uses are released.
- Close every pool or client you create, in `afterAll` or `finally`.
- Observe a dependency through its public API, not its private tables (for
  example graphile-worker's `_private_*` tables). Where nothing else is
  possible, keep the access in one helper with a comment naming the version
  it was checked against.

Why: each of these produced a test that was green locally and failed under
CI load, or failed in a different test file than the one that caused it.

## 9. A concurrency claim needs a concurrent test

If code or a docstring claims serialisation, mutual exclusion or ordering, test
it with real concurrency. Use a worker with concurrency of at least 2, and
explicit start/finish signals with timeouts. Write assertions that hold
whichever handler starts first. A test that runs the two operations one after
the other proves nothing about a race.

## 10. Repository rules apply to tests too

Rule 6 of `.bb/AGENTS.md` (typed boundaries) and the SQL rules in the
`state-writes` skill do not stop at `__tests__/`. Give every `query` a row
type, parse `unknown` instead of casting it, and never interpolate values into
SQL or DDL, a test trigger body included.

## Before committing, check

- [ ] Every branch the diff adds has a named test that reaches it alone; flagged
      branches had their siblings swept.
- [ ] Every guard has an allowed-path test as well as a refused-path test.
- [ ] Existing tests near the new condition still reach the path they are named for.
- [ ] Every test the issue names exists, with the harness it names.
- [ ] Isolation tests use a runtime-role pool and two tenants.
- [ ] Fixtures use production writes; any raw SQL has a reason comment.
- [ ] Failure-path tests assert the absence of side effects.
- [ ] No test depends on time, order, shared mutable state or private internals.
