---
status: accepted
date: 2026-09-10
area: [backend]
supersedes: []
superseded-by: null
---

# Side effects follow the commit

## Context

A write is invisible to everything outside its transaction until `COMMIT`
succeeds. Anything that *announces* a write — a `NOTIFY`, a realtime
WebSocket invalidation, a push delivery, a queue job that reads the row back
— therefore has two failure modes when it fires from inside the transaction
that performed the write: a subscriber can act on a row that is not visible
yet, and a transaction that later rolls back leaves an announcement already
delivered for a write that never happened.

Both shapes have been hit here. `docPersistence.ts`'s realtime
`notifyDocUpdate` was reported for firing inside the caller's transaction
rather than after it, and issue #105's confirm/reject/revise fix is the same
correction on the proposal path.

The alternative is real and is what the obvious code does: call the effect
directly, inline, right after the write. It is one fewer indirection, it is
easier to read, and it delivers with lower latency. For an effect whose early
delivery is harmless it would be fine. For an effect a rollback must not have
already made visible, it is a correctness bug that only appears under failure.

## Decision

An effect that announces a write is registered with
`runAfterCommit(client, callback)` and runs only once the enclosing
`withTransaction` call's `COMMIT` has actually succeeded. On the rollback path
the registered callbacks are discarded and nothing is announced.

`withTransaction` runs each callback in its own `try`/`catch`: a callback that
throws is logged and the remaining callbacks still run, and the failure never
surfaces as an error from the committed work — the caller must not see a
failure for an operation that succeeded. The consequence is deliberate and
worth stating plainly: **a callback's failure is invisible to its caller**, so
a callback whose delivery matters has to report its own failure, because
nothing above it will.

Two orderings belong to the same decision:

- A guard that decides whether to write runs *before* the write. A validity
  check placed after the insert does not guard anything.
- An idempotency check reads inside the transaction it protects. Read outside
  it, two callers both see "not done yet" and both proceed.

`runAfterCommit` is internal to `@semprec/data` and is deliberately not
re-exported from the package root: the effects it defers belong to the data
layer that performed the write, not to its callers.

## Consequences

- A subscriber never observes an announcement for state that is not committed,
  and a rolled-back transaction announces nothing.
- The hook takes a synchronous callback. Work that must be awaited, retried, or
  survive a process restart belongs in a queue job — written inside the same
  transaction, so it commits or vanishes with the data it describes — not in an
  after-commit callback.
- Because a failing callback is only logged, an effect that needs a delivery
  guarantee cannot rely on this hook alone.
