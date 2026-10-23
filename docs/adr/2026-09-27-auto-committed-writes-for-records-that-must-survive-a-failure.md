---
status: accepted
date: 2026-09-27
area: [backend]
supersedes: []
superseded-by: null
---

# Auto-committed writes for records that must survive a failure

## Context

The default shape for a data-layer write here is a statement run on the
`PoolClient` of a caller's `withTransaction`, so that everything one operation
writes commits or rolls back together. That default has one failure mode: a
row whose whole purpose is to record that the operation *failed* is written,
then the operation throws, and the rollback erases the row along with the rest.

Issue #628 hit exactly this. `login()` ran inside the login route's
`withTransaction`; a wrong password recorded a failed `login_attempts` row and
then threw `UnauthorizedError`, which rolled the row back. The failure streak
therefore always read zero and the lockout never engaged — a security control
that silently did nothing, with every test that shared the transaction still
passing.

Neither existing ADR covers the fix.
[[2026-09-10-side-effects-follow-the-commit]] is about announcing a write only
after it commits, not about a write that must outlive a rollback.
[[2026-09-10-bracket-non-transactional-calls-with-staleness-checked-transactions]]
is about keeping slow external calls out of a transaction, not about which
writes may sit outside one.

The alternatives were real: catch the error, commit, then rethrow (the
transaction boundary then depends on every caller doing this correctly); a
separate transaction opened just for the failure row (the same thing with more
ceremony); or an after-rollback hook (a new mechanism in `withTransaction`
serving one caller).

## Decision

A write whose record must survive the operation failing — an append-only
audit or attempt row such as a failed `login_attempts` entry — is issued as an
auto-committed statement directly on the `Pool`, never on a `PoolClient` of an
enclosing `withTransaction`. A function that performs such a write takes a
`Pool`, not a `Pool | PoolClient`, so a caller cannot hand it a transaction
that would roll the record back. It documents in its docstring which writes
are auto-committed and why.

Writes that must stay atomic with each other within the same function — for
`login()`, the new session and the streak-resetting success row — still run
together in their own `withTransaction` inside that function.

The pattern applies only to append-only rows where a record standing alone,
without the rest of the operation, is correct. It is not a way to escape a
transaction for ordinary state writes, which keep going through the choke
point inside a transaction.

## Consequences

- A failure record persists regardless of what the operation does after
  writing it, so controls that read those records (lockout, rate limits,
  auditing) see every failure.
- The auto-committed row cannot be rolled back with the surrounding work. If
  the operation fails for an unrelated reason after the row is written, the row
  stays; for append-only audit data that is acceptable by construction, and a
  write for which it is not acceptable does not qualify for this pattern.
- A function using this pattern cannot be composed into a caller's larger
  transaction. Callers that need that atomicity must not use it.
- Tests must exercise the failure path end to end through the real boundary
  (the route, not a shared test transaction), since a shared transaction hides
  exactly the rollback this pattern exists to avoid.
