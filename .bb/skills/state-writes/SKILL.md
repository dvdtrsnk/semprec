---
name: state-writes
description: "How every write to persisted Semprec state must be built - through the choke point, by the single owner, with side effects after the commit, and an affected-row check on every targeted write. Load this BEFORE writing the first line of a function that mutates data, not while reviewing it afterwards. Triggers on: DELETE FROM, UPDATE ... SET, INSERT INTO, rowCount, requireAffectedRows, withTransaction, runAfterCommit, chokePoint., createItem, patchItem, addViewItem, removeViewItem, notifyInvalidation, pg_notify, NOTIFY, any *Store.ts file, a seed or backfill, an agent tool that writes, and any handler whose verb is POST, PATCH, PUT or DELETE. Skip only when nothing in the change can reach the database."
---

# State writes: choke-point, ownership, approval

Three laws govern every write to persisted state in the Semprec backend. They exist
because the whole system's auditability, undo, realtime sync, and AI-safety story
hangs on writes being observable in exactly one place.

Recorded as ADRs: `docs/adr/2026-09-10-choke-point-api-for-state-writes.md`,
`docs/adr/2026-09-10-single-writer-ownership-model.md`,
`docs/adr/2026-09-10-agent-writes-are-proposals-not-direct-writes.md`,
`docs/adr/2026-09-10-side-effects-follow-the-commit.md`.

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
