---
name: state-writes
description: "How every write to persisted Semprec state must be built - through the choke point, by the single owner, with side effects after the commit, and an affected-row check on every targeted write. Load this BEFORE writing the first line of a function that mutates data, not while reviewing it afterwards. Triggers on: DELETE FROM, UPDATE ... SET, INSERT INTO, rowCount, requireAffectedRows, withTransaction, runAfterCommit, chokePoint., createItem, patchItem, addViewItem, removeViewItem, notifyInvalidation, pg_notify, NOTIFY, any *Store.ts file, a seed or backfill, an agent tool that writes, any handler whose verb is POST, PATCH, PUT or DELETE, registerItemUpdateHook, registerRelationEdgeWriteHook, domainWriteHooks, tenant_id, app.tenant_id, runInTenant, runAsSystem, SELECT ... FOR UPDATE, a guard read before a write, another module's table, SQL text built with a template literal, format('%I'), a DO block, CREATE TRIGGER or CREATE FUNCTION in a test, and a test fixture that writes rows. Skip only when nothing in the change can reach the database."
---

# State writes: choke-point, ownership, approval

Three laws govern every write to persisted state in the Semprec backend. They exist
because the whole system's auditability, undo, realtime sync, and AI-safety story
hangs on writes being observable in exactly one place.

Recorded as ADRs: `docs/adr/2026-09-10-choke-point-api-for-state-writes.md`,
`docs/adr/2026-09-10-single-writer-ownership-model.md`,
`docs/adr/2026-09-10-agent-writes-are-proposals-not-direct-writes.md`,
`docs/adr/2026-09-10-side-effects-follow-the-commit.md`,
`docs/adr/2026-09-30-choke-point-domain-hooks-through-a-per-process-registry.md`,
`docs/adr/2026-10-03-tenant-isolation-through-row-level-security.md`.

## 1. All writes go through the choke-point

Route every mutation of item/database state through the generic choke-point API
(`POST`/`PATCH /api/items`, the relation endpoint, `confirm`/`revise`) or the data
layer's single write function that backs it. Never issue a direct `UPDATE`/`INSERT`
against item tables from a service, worker, or script.

Why: the choke-point is where idempotency keys, `ifVersion` conflict checks,
`owner`/`locked` enforcement, event emission (WS invalidations, `onItemEvent`
heartbeat triggers), and audit history all live. A write that bypasses it is
invisible to all of them — clients don't refresh, heartbeats don't fire, and the
edit history lies.

The one exception: an issue whose explicit Task is to build or extend the
choke-point itself.

A domain's transactional side effect on an item or relation-edge write — one
that must share the write's own open transaction, per §4 below — is never
added as a direct import inside a choke-point module (`chokePoint/itemWrites.ts`,
`chokePoint/relationOps.ts`, …). The `chokepoint-knows-no-domain`
dependency-cruiser rule forbids it. Instead, register a hook next to the
domain logic it wraps and add it to `backend/packages/data/src/domainWriteHooks.ts`,
the single composition point that wires every domain's hook into
`chokePoint/hooks.ts`'s per-process registries:
`registerItemUpdateHook`/`runItemUpdateHooks` for `updateItemWithClient`, and
`registerRelationEdgeWriteHook`/`runRelationEdgeWriteHooks` for
`createRelationWithClient`/`updateRelationWithClient`'s write and
`assertRelationCreatableWithClient`'s pre-validation check (the assertion path
does not commit — hooks registered here must be safe to run with no
subsequent write). See
`docs/adr/2026-09-30-choke-point-domain-hooks-through-a-per-process-registry.md`
for the rationale and the boundary rule's exemptions.

## 2. One owner, one writer

Every piece of state has exactly one owning process (the module contract's
`owner_process` model). Before writing a field, check who owns it:

- `owner: 'user'` fields — written only via user-initiated choke-point calls.
- `owner: 'system'` fields — written only by the single process the module
  contract names. A second process writing the same field is a bug even when the
  value it writes is correct, because two writers drift and the `owner_process`
  check exists precisely to catch that.

If a feature seems to need a second writer, the answer is an explicit ownership
handoff in the module contract, not a quiet extra `UPDATE`.

The same applies to a table another module owns. Add a function to the owning
module's store and call it. Do not write inline SQL against that table, and do
not import the module's internals. A cleanup that deletes across several
modules' tables asks each owner to delete its own rows. Why: a write that
bypasses the owner bypasses whatever invariants the owner enforces, and the
next change to the owner silently stops covering it.

A derived `owner: 'system'` field that must always reflect other properties on the
same item (e.g. Tasks' `time`, computed from `timeFrom`/`timeTo`) is computed
inline inside the choke-point's create/update path, keyed off the database's
`ownerModuleId`, in the same transaction as the write that changed its inputs —
not via a second writer reacting after the fact. This is distinct from the
`allowedSystemKeys` escape hatch (which only relaxes the permission check for a
caller that already computed the value); a derived field needs the value computed
automatically regardless of caller. See
`docs/adr/2026-09-19-derived-system-properties-computed-inline-at-choke-point.md`.

## 3. Agent code proposes, humans (or grants) confirm

AI/agent code never writes state directly. An agent-originated change is a
*proposal*: it goes through the approval queue / `confirm` flow, where a logged-in
user or an explicit pre-authorized grant turns it into a real write. This
separation of suggestion from write is a core product decision, not a formality —
it is what makes it safe to let agents run unattended.

So when implementing an agent tool or heartbeat that "should update X": create a
proposal card / approval request instead, and let `confirm` do the write inside its
transaction.

## 4. Side effects follow the commit

A write is not visible until its transaction commits, so anything that tells the
rest of the system about it must happen *after* the commit, not inside it:
`NOTIFY`, a WebSocket invalidation, a notification row's push delivery, a queue
job that reads the row back. Fire one inside the transaction and a listener can
act on state that is not there yet — or that never arrives, because the
transaction rolled back after the message was already sent.

Use `runAfterCommit(client, ...)` rather than a bare call following the `await`.
`withTransaction` runs each registered callback in its own `try`/`catch` after
`COMMIT`, logs one that throws, and carries on to the rest — the failure never
reaches the caller, because the write it announces actually succeeded. That is
deliberate, and it cuts both ways: a callback whose delivery matters has to
report its own failure, since nothing above it will. Anything needing a real
delivery guarantee belongs in a queue job written inside the same transaction.

This is a different pattern from the domain write hooks in §1: `runAfterCommit`
is for effects that must observe the committed row and are allowed to fail
independently of the write (`NOTIFY`, a push, an invalidation). A domain side
effect that itself must be part of the write's atomicity — it either commits
with the row or rolls back with it — is not a "side effect that follows the
commit" at all; it is registered via `registerItemUpdateHook`/
`registerRelationEdgeWriteHook` and runs *inside* the transaction, before
commit. Reach for `runAfterCommit` only once the domain hook's own transactional
work is done and something outside the transaction needs to know.

Related checks worth doing in the same pass:

- A guard that decides whether to write must run *before* the write, not after
  it. A validity check placed after the insert is not a guard, it is a comment.
- A check read outside the transaction that performs the write is not a guard —
  idempotency or otherwise. Two callers can both read "not done yet" and both
  proceed; a `getView`/`listX`-style pre-fetch that confirms a row exists can be
  stale by the time the delete or update that follows it actually runs, because
  a concurrent write committed in the gap. Confirm the condition from the write
  itself, not from a lookup that ran before it.
- A targeted `UPDATE`/`DELETE` still reports success when it matches zero rows,
  unless you check how many rows it actually touched. `WHERE id = $1` against a
  row that is already gone returns `rowCount: 0`, not an error. Use
  `requireAffectedRows(result, context)` (next to `requireSingleRow` in
  `db/pool.ts`) when the row is expected to exist by construction — a delete
  keyed off an id just read back, an update guarded by a prior existence check.
  When zero rows is itself a legitimate outcome the caller has to handle (a
  bulk operation that may affect nobody, a remove that might target a
  non-member), check `result.rowCount` yourself and turn it into the
  domain-appropriate response — a `NotFoundError`, not a silent success. Either
  way, this is what makes the previous point actionable: the write confirms its
  own outcome, so the stale pre-check no longer matters.
- A guard enforced on one direction of a paired write is not automatically
  enforced on its counterpart. If `add`/`create`/`lock` checks a precondition,
  `remove`/`delete`/`unlock` needs the same check — a rule found on one side of
  a pair is exactly where a reviewer looks for it on the other.
- **Being inside the transaction is not enough. Lock the row the guard reads.**
  `withTransaction` runs at READ COMMITTED unless you pass its `isolation`
  option, so a plain `SELECT` inside it still lets a concurrent transaction
  change the row before your write commits. Raising the isolation level
  instead turns the race into serialization failures that every caller must
  then retry, so prefer the row lock unless an ADR for that path says
  otherwise. When a read decides whether a write happens, read with
  `SELECT … FOR UPDATE` (or `FOR SHARE` when you only need the row to stay as
  it is) in the same `withTransaction` as the write. Every path that reaches the
  write needs the same guard, including a cached or reused result. Never claim
  in a comment or ADR that a check and a write are "serialized" unless a lock
  makes them so. Without one, the honest claim is that a refused write rolls
  back atomically.
- **Writes that must hold together share one transaction.** Several statements
  on a plain client, or several auto-committed calls, leave a half-written state
  when the second one fails. Put the whole group in one `withTransaction`. This
  matters most on a final failure path that nothing retries.
- **Never hold a transaction open across slow external work** (a child process,
  a network call, a model call). It pins a pooled connection and holds its
  locks for the whole duration. Do the slow work first, then open the
  transaction for the check and the write.
- **A side effect reports what this call actually did.** Emit a success event
  only when the affected-row count, or a re-read, shows that this call
  performed the write. Build the payload from `RETURNING`, not from a snapshot
  read before the write.
- **Take row locks across tables in the order the existing write path uses.**
  A new path that locks the same tables in the opposite order deadlocks
  against it under load.

## 5. Every write stays inside the caller's tenant

Each user's data lives in that user's own tenant; a write must never reach
another's. Why: `docs/adr/2026-10-03-tenant-isolation-through-row-level-security.md`.

- The tenant comes only from a trusted source. Today those are: the
  authenticated session, a NOTIFY payload stamped by its publisher, an internal
  caller whose identity was verified by reading a row (for example the agent's
  Projects item) while the tenant scope was already set on the connection from
  another trusted source, an MCP run credential, or a router function resolving
  an external identifier to its tenant. Reading a row does not make the row's
  tenant trusted: never derive the tenant for later writes from a row you
  happened to read. The tenant never comes from a request body, query string,
  path segment, caller-settable header or a model's output.
- Until the enqueue-stamp mechanism exists, do not read the tenant from any
  job payload field. Once it is implemented, a tenant stamped onto the job at
  enqueue by the producing code (from the producer's scope, not filled in by
  the job's originator) will also be a trusted source.
- Run the write inside the tenant scope (`app.tenant_id`) established from one
  of those sources. In code that is `runInTenant(tenantId, fn)` or, for work
  that belongs to no tenant, `runAsSystem(reason, fn)`, both from
  `backend/packages/shared/src/tenantScope.ts`
  (`docs/adr/2026-10-05-tenant-scope-propagation.md`). Wrap the entry point
  itself, not only the inner function. That includes every handler branch,
  a `start()` that installs timers or listeners, the callbacks those install,
  and a connection you open by hand.
- Never rely on the transitional sole-tenant fallback. `app_tenant_default()`
  falls back to `app_sole_tenant()`, which yields a tenant only while exactly
  one exists, so unscoped code works today and fails closed — or worse —
  the day a second tenant is created.
- A helper that per-tenant code calls must not read a table without row-level
  security unless it filters by the tenant itself. Check each helper you reuse.
- Let the `tenant_id` column default stamp the row; do not pass it. RLS
  `WITH CHECK` refuses a row for another tenant anyway.
- Existence and uniqueness checks are per tenant, and another tenant's id is
  handled exactly like a missing id.
- Cross-tenant system work runs tenant by tenant, each tenant's work inside
  that tenant — never as one query over every tenant.

## 6. SQL text is built from constants only

Values are bound as parameters (`$1`), always, and that includes tests. When a
statement cannot take parameters (DDL, a trigger or function body, `ALTER
ROLE`), quote inside Postgres: `format('%I', name)` for identifiers and
`format('%L', value)` for literals, executed in a `DO` block or a function. You
can also pass test values through a scratch table or a `set_config` setting that
the body reads. `JSON.stringify` and other general-purpose escapers are not SQL
quoters. When interpolation is unavoidable and the value is provably closed (a
literal union, a generated UUID), say so in a comment next to it, as
`createRuntimeRolePool` in
`backend/packages/data/src/testSupport/tenantFixtures.ts` does.

Why: a test helper is copied into production code more often than it is
re-reviewed, and the reviewer cannot tell a safe interpolation from an
injection without the invariant written down.

## Before committing, check

- [ ] No raw SQL mutation of item tables outside the data layer's write path.
- [ ] Every field written is owned by the process this code runs in.
- [ ] No agent/LLM-driven code path reaches a write without approval/`confirm`.
- [ ] New write behavior has a test exercising the choke-point route, not the
      internals.
- [ ] Every notification, invalidation or enqueue fires after the commit, not
      inside the transaction.
- [ ] Every targeted `UPDATE`/`DELETE` checks its affected-row count
      (`requireAffectedRows`, or a manual `NotFoundError` when zero is a
      legitimate outcome) rather than trusting a pre-fetch that ran before it.
- [ ] Every guard the "add"/"create"/"lock" side of a pair enforces is enforced
      by its "remove"/"delete"/"unlock" counterpart too.
- [ ] The tenant of every write comes from a trusted source, never from a
      request body, query string, path segment, caller-settable header, model
      output or any job payload field (until the enqueue-stamp mechanism
      exists), and never derived from a row you happened to read.
- [ ] No write sets `tenant_id` explicitly; the column default stamps it.
- [ ] Existence and uniqueness checks are per tenant, and another tenant's id
      gets the same outcome as a missing id.
- [ ] Cross-tenant system work runs inside each tenant in turn, not as one
      query over all tenants.
- [ ] Every read that decides a write runs in the write's transaction with a
      row lock, on every path that reaches the write.
- [ ] Writes that must hold together run in one `withTransaction`, and no
      transaction spans a slow external call.
- [ ] Success events depend on what this call actually wrote, and payloads
      come from `RETURNING`.
- [ ] Another module's tables are written only through that module's store.
- [ ] Every entry point, timer and callback of new code runs under
      `runInTenant`/`runAsSystem`, never through the sole-tenant fallback.
- [ ] No value is interpolated into SQL text, tests included; any unavoidable
      interpolation has its safety invariant in a comment.
