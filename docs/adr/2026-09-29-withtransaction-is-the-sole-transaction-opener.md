---
status: accepted
date: 2026-09-29
area: [backend]
supersedes: []
superseded-by: null
---

# withTransaction is the sole transaction opener

## Context

[[2026-09-10-side-effects-follow-the-commit]] introduced `runAfterCommit`:
an effect registered on a `PoolClient` and fired by `withTransaction` only
after its own `COMMIT` succeeds. That mechanism keys the pending callbacks on
the `PoolClient` object itself, via a `WeakMap`.

A pooled client is not tied to one caller's transaction — after `release()`,
`pg` hands the same `PoolClient` to whichever `pool.connect()` call is next in
line, which may belong to an unrelated request. Two call sites hand-rolled
their own `BEGIN`/`COMMIT`/`ROLLBACK` instead of going through
`withTransaction`: `createPoolClientTransactionRunner` and
`repairInterruptedRuns`. Neither drained `runAfterCommit`'s callback list.
A callback registered by a store inside one of those hand-rolled transactions
stayed parked on the `PoolClient` past that transaction's own `COMMIT`, and
fired only when `withTransaction` next acquired that same client from the
pool — attached to a later, unrelated transaction — or never fired at all if
that client happened to be released and the pool never handed it back before
the process exited.

## Decision

`withTransaction` is the only sanctioned way to open a transaction on a
pooled `Pool`/`PoolClient`. No call site issues `BEGIN`/`COMMIT`/`ROLLBACK`
directly against a client obtained from a pool; every transactional write
goes through `withTransaction`, passing an `isolation` option when it needs
one.

`withTransaction` is the single place that drains and fires (or discards, on
rollback) the callbacks parked on a given client, so this is not a style
preference: a hand-rolled `BEGIN`/`COMMIT` bypasses that drain and leaves the
callback list to be picked up, and misattributed, by whichever transaction
next acquires the same client.

## Consequences

- A new transactional code path reaches for `withTransaction`, never
  `client.query("BEGIN")` directly, even when it has no after-commit callback
  of its own today — a callback added later by a store it calls into would
  otherwise silently misfire.
- `createPoolClientTransactionRunner` and `repairInterruptedRuns` were
  converted to `withTransaction` for this reason; any future transaction
  runner follows the same rule.
- `withTransaction` needing a new isolation level (beyond `repeatable_read`
  and `serializable`) is the only ADR-worthy addition; raw `BEGIN` variants
  are not an accepted alternative.
