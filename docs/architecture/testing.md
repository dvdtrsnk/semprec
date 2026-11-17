# Testing

How tests are written and run in this repository. The `testing` skill
(`.bb/skills/testing/SKILL.md`) is the working checklist; this document is the policy it
implements. Mobile and web specifics live in their own skills and review rules.

## Policy

- **Test behaviour and acceptance criteria, not branches.** Each test states one observable
  behaviour of the unit under test: an Acceptance criterion, a documented contract, a failure
  path a caller can reach. Coverage of an `if` is not a goal in itself.
- **Do not add a test just because a branch exists.** A branch that is reachable and matters is
  covered by the behaviour it produces; a test named after the branch adds nothing.
- **No tests for unreachable or defensive branches.** A guard that only protects against a state
  the types or the database already rule out gets no test. If a defensive branch seems to need
  one, the branch is likely the thing to remove.
- **Prefer table-driven tests and shared fixtures.** Variations of one behaviour are one
  `it.each` / `describe.each` table, not copies of a test body. Repeated setup moves into a
  fixture in `testSupport/` rather than being re-written per file.
- **Both sides of every permission check.** A check that refuses something is tested on the
  refused path *and* on the allowed path, through the real entry point. A refusal-only test
  still passes when the wiring that grants the allowed case is removed.
- **Multi-tenant isolation is tested**, for every read and write path that crosses tenant data,
  through the one shared harness (see [Tenant isolation harness](#tenant-isolation-harness)).
- **Integration tests use real Postgres.** No database mocks, no in-memory substitutes, no
  stubbed query layer. A test that needs a database belongs in the integration tier.
- **Fixtures are created through production write paths** (see [Fixtures](#fixtures)).
- **The tests an issue names are deliverables.** When an issue names a test, a harness or a
  file, that test is written with that harness against the real composition. A test that
  cannot be delivered is stated in the pull request, never quietly substituted.

## Backend test tiers

Three tiers, selected by filename; a file belongs to exactly one. Configs are at
`backend/vitest.unit.config.ts`, `backend/vitest.integration.config.ts` and
`backend/vitest.e2e.config.ts`; `pnpm run test:unit|test:integration|test:e2e` in `backend/`
runs them, and `pnpm run verify` runs all three plus lint, build and the static checks.

| Tier        | Files            | Database                       | Tenant scope mode           |
| ----------- | ---------------- | ------------------------------ | --------------------------- |
| unit        | `*.unit.test.ts` | none; must not import any      | pinned `warn` in the config |
| integration | `*.test.ts`      | one embedded Postgres per run  | per file, `strict` default  |
| e2e         | `*.e2e.test.ts`  | same `globalSetup` as above    | pinned `warn` in the config |

- Unit files must not import anything that reaches Postgres, directly or through
  `testSupport/testDb.ts`.
- E2e scenarios load real modules through `@semprec/module-registry` and wire them into the
  real queue and database as a composition root does; they assert cross-module behaviour no
  single package's suite exercises.
- All tiers resolve workspace packages to their TypeScript source through the config aliases.
- Integration and e2e run with `fileParallelism: false` and `LOG_LEVEL=error` unless the
  developer overrides it.

### Global setup

`backend/packages/data/src/testSupport/globalSetup.ts` provisions the database for the
integration and e2e tiers:

- starts one `embedded-postgres` instance on a free port (`SEMPREC_TEST_PG_PORT` pins one),
  UTF8 encoding, `max_locks_per_transaction=1024`, and sweeps stale `semprec-pg-*` directories;
- creates `semprec_test`, exports `TEST_DATABASE_URL` and a deterministic test-only
  `CREDENTIALS_MASTER_KEY`;
- runs the same schema steps, in the same order, as `backend/packages/data/src/db/runMigrationsCli.ts`
  (migrations, host-asset activation, queue schema and grants, tenant-scoped steps on a
  `semprec_data` pool). A step added to the CLI is added here too;
- exports `TEST_TENANT_ZERO_ID` (the tenant the migrations create) and drops the single-tenant
  guard index so the two-tenant harness can create more tenants;
- refuses to run when workspace roots do not resolve to source modules.

`resetDatabase(pool)` (`testSupport/testDb.ts`) truncates the schema and removes every tenant
except tenant zero, which keeps its id for the whole run.

### Tenant scope mode per file

Production runs `SEMPREC_TENANT_SCOPE=strict`: a data call outside a tenant scope throws
`TenantScopeMissingError`. The integration tier matches that per file:

- `testSupport/tenantScopeMode.ts` (a `setupFiles` entry) sets `strict` for every file, and
  `warn` only for files listed in `testSupport/tenantScopeWarnFiles.json`. A file whose path
  cannot be determined fails setup. A value the vitest process was started with overrides
  every file.
- The list only shrinks. `tenantScopeWarnFiles.frozen.json` is its pinned original;
  `testSupport/__tests__/tenantScopeWarnFiles.unit.test.ts` fails on an unsorted list, a
  duplicate, a missing file, an entry absent from the frozen copy, or a new file that switches
  itself to `warn`.
- A new integration file runs `strict`. Converting a listed file's fixtures to run in scope
  removes it from the list; nothing is ever added.
- `testSupport/__tests__/tenantScopeModeDefault.test.ts` asserts the tier really defaults to
  `strict`.

## What a test asserts

- **Failure paths assert what did not happen.** On a refusal or failure, assert the error
  *and* the absence of side effects: no row written, no job enqueued, no notification, no
  realtime event.
- **Success paths assert exact results**: exact counts and exact values routed, not a delta of
  a running total, and not "at least one".
- **One scenario, one fixture.** Scenarios are not chained inside one test.
- **A concurrency claim needs a concurrent test.** Code or a docstring that claims
  serialisation, mutual exclusion or ordering is tested with real concurrency (a worker with
  concurrency of at least 2, explicit start/finish signals with timeouts) and assertions that
  hold whichever side starts first. Sequential calls prove nothing about a race.
- **Re-check neighbouring tests after adding a condition.** A new guard can make an existing
  race, retry or already-decided test stop early and pass for the wrong reason. Each existing
  test near the change must still reach the path its name describes.
- **A test must fail when the behaviour is removed.** A test that stays green with the code
  under test deleted is rewritten or removed.

## Tenant isolation harness

All multi-tenant tests use `backend/packages/data/src/testSupport/tenantFixtures.ts`; its
header comment is the reference. No test builds its own tenant or role setup.

- `createTestTenant(pool, { status })` creates a tenant; a cross-tenant test needs two tenants,
  not two users in one tenant.
- Isolation is asserted through `createRuntimeRolePool(adminPool, "semprec_data" | "semprec_side")`.
  The superuser pool from `getTestPool()` bypasses row-level security, so an isolation assertion
  on it proves nothing.
- Test SQL runs inside `withTenantTransaction(pool, tenantId, fn)`; production code runs inside
  `runInTenant` / `runAsSystem` (`backend/packages/shared/src/tenantScope.ts`).
  `withTenantTransaction` scopes only its own transaction; a verification read opens a new one.
- `inTenantZero(fn)` and `bindToTenantZero(target)` run a job producer (the choke point, a
  store) inside tenant zero so the jobs it enqueues carry a tenant.
- `createTenantZeroUser`, `tenantForNextTestUser` and `setTenantAiBudget` cover the common
  per-tenant setup.
- Never rely on `app_sole_tenant()` in a test: it stops resolving the moment a second tenant
  exists.
- Work that bypasses row-level security (an owner-pool step) is tested with at least two
  tenants for every join it makes: a source row in one tenant must never reach a target row in
  another.

## Fixtures

- Test state is built with the functions production uses: the choke point, the owning store's
  functions and the helpers exported from `@semprec/data/testSupport`
  (`backend/packages/data/src/testSupport/testDb.ts` and the `*Fixtures.ts` files beside it).
- Raw SQL `INSERT` / `UPDATE` is used only for a state the write path cannot produce, with a
  one-line comment saying why. A raw fixture skips hooks, ownership checks and derived fields,
  so the test would run against a state production never reaches.
- A fixture needed by more than one file is added to `testSupport/` once and reused.
- Fakes are limited to the outside world: provider transports, mail transports
  (`mailSendFakes.ts`), DNS (`dnsLookupStub.ts`), MCP contract servers (`mcpContractServers.ts`).
  Internal owners (accounting, dispatchers, stores, the choke point) are never faked to make a
  test pass.

## Cross-service composition

Services must not import each other (`no-service-to-service` in
`backend/dependency-cruiser.rules.json`), tests included. A test that must observe a path
through two services composes them as processes:

- The owning service's test spawns a **compiled fixture child** of the other service, kept under
  that service's `src/__tests__/fixtures/` (for example
  `services/semprec-ai-gateway/src/__tests__/fixtures/*Gateway.ts`,
  `services/semprec-agents/src/__tests__/fixtures/liveVoiceWorker.ts`), built by that service's
  existing build. The child composes the real production owners of its own service.
- Only **outbound provider transport** is replaced: the provider's fixed URL is redirected to an
  owned loopback listener that returns bounded synthetic protocol responses, and every
  unexpected destination is refused. Synthetic responses prove protocol composition, not model
  quality, and are labelled as such.
- Compiled workspace packages resolve through the test-only allowlisting resolver
  `services/semprec-transcribe/src/__tests__/fixtures/workspaceDistResolver.mjs` (wrapped, never
  widened, by a service-specific resolver where needed). It maps declared public workspace
  entries to built JavaScript and fails on anything else; it never falls back to source.
  Missing or stale builds fail the test.
- The child shares the run's database through a runtime-role connection passed in its
  environment, verifies that role is not a superuser and not `BYPASSRLS`, and binds only
  allocated `127.0.0.1` ports. IPC frames are typed and bounded and never carry credentials,
  raw text, audio or provider errors.
- The parent bounds startup, output and lifetime, awaits the child's exit, closes servers,
  sockets and pools in dependency order, and preserves the primary error over cleanup errors.
  It never kills by name or pattern.

## Test hygiene

- Restore everything global a test changes: `process.env`, module-level registries (reset in
  `beforeEach`), fake timers.
- Never patch a pooled client and return it to the pool; take a dedicated client or pool for
  fault injection.
- No dependence on wall-clock time, on row order without `ORDER BY`, or on one runtime's ICU
  output; derive locale-formatted expectations with the same `Intl` API the code uses.
- Settle every deliberately un-awaited promise before the resources it uses are released.
- Close every pool or client a test creates, in `afterAll` or `finally`.
- Observe a dependency through its public API, not its private tables (such as graphile-worker's
  `_private_*`). Where unavoidable, keep the access in one helper naming the version checked.
- Typed boundaries apply to tests: parse `unknown` instead of casting it; in Kotlin no `!!` or
  unchecked `as`, in Swift no force-unwrap, `try!` or `as!` on values from outside the code's
  own types.
- SQL rules apply to tests: every `query` has a row type, and values are never interpolated
  into SQL or DDL, a test trigger body included.

## Other platforms

- `web/` runs every `*.test.ts` / `*.test.tsx` with Vitest.
- `mobile/` tests sit beside the code they test (`commonTest`, Android `src/test` and
  `src/androidTest`, Swift XCTest bundles, `SemprecUITests`) and run through
  `mobile/scripts/verify`; the policy above applies except for the database and vitest rules.
  Which layer tests what is defined by the mobile skills.
