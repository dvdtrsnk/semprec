---
status: accepted
date: 2026-09-27
area: [backend]
supersedes: []
superseded-by: null
---

# AI budget reservations under a global advisory lock

## Context

[[2026-09-10-ai-gateway-monopoly-on-provider-calls]] routes every provider call
through `semprec-ai-gateway`, which enforces the daily and monthly budget caps
and records one `ai_gateway_calls` row per call. Until issue #620 the gateway
checked the budget, called the provider, and only then inserted the row with
the real cost. Two calls started concurrently both read the same spend, both
passed the check, and together overshot the cap by the full cost of every call
in flight — the cap bounded nothing under concurrency, and each extra
connection or service calling the gateway widened the gap.

The alternatives considered:

- `SERIALIZABLE` isolation on the check-and-insert. A concurrent insert shows
  up as a serialization failure, so every caller needs a retry loop, and the
  conflict detection depends on the predicate locks Postgres happens to take
  for the spend query.
- A `SELECT ... FOR UPDATE` on a budget row (e.g. the settings row holding the
  caps). It serializes the same way, but couples the gateway to that row's
  owner and makes every settings write contend with every model call.
- Holding one lock across the provider call. Correct, but it serializes the
  provider round trips themselves, so one slow transcription blocks every chat
  completion.
- Recording the row only after the call (the old shape). Simple, but it is the
  race itself.

## Decision

**Reservation lifecycle.** Every gateway call owns one `ai_gateway_calls` row
with a `status` of `reserved`, `settled` or `failed`:

1. **Reserve.** Before the provider call, one transaction takes the lock below,
   checks the budget, and inserts a `reserved` row whose `cost_usd` is the
   caller's upper-bound estimate. A `BudgetExceededError` rolls the transaction
   back, so a rejected call leaves no row.
2. **Settle.** After the provider call succeeds, the row moves `reserved →
settled` and its `cost_usd` is replaced by the real cost, with the real
   usage columns filled in.
3. **Fail.** When the provider call rejects, the row moves `reserved → failed`
   at `cost_usd = 0`. This write is auto-committed on the `Pool` per
   [[2026-09-27-auto-committed-writes-for-records-that-must-survive-a-failure]].

Each transition is a conditional `UPDATE ... WHERE status = 'reserved'` with an
affected-row check: a row is settled or failed at most once and never leaves a
terminal state.

**Every row counts at its `cost_usd`.** Budget and usage queries sum
`cost_usd` without a status filter: a `reserved` row counts at its estimate, a
`settled` row at its real cost, a `failed` row at 0. Counting in-flight
reservations at their estimate is what lets the next caller's check see calls
that have not finished yet; without it concurrent calls jointly overshoot the
cap exactly as before.

**The lock.** The reserve transaction takes
`pg_advisory_xact_lock(hashtext('ai_gateway_budget'))` before it reads spend.
It is one global key — the caps are global, so the check-and-insert must be
serialized globally. Any operation that reads spend to decide whether to insert
a new reservation (a second gateway entry point, another service, a sweep that
creates rows) must take the same key in the same transaction as its insert.
Settling and failing a row do not take the lock: they only lower or replace a
row already counted, which never lets a concurrent check pass that should have
failed beyond the caller's own estimate error.

The lock is transaction-scoped, not session-scoped: it is released at COMMIT
of the reservation, before the provider is called, so concurrent calls
serialize only on the check-and-insert and never on the provider round trip,
and a pooled connection can never return to the pool still holding it.

**A settle that fails leaves the row `reserved` at its estimate.** The provider
has already been paid; recording the call as `failed` at 0 would under-report
real spend and let later calls exceed the cap. The estimate is the caller's
upper bound, so the stuck row errs on the side of the cap, and it stops
counting once `at` leaves the budget window.

## Consequences

- Concurrent gateway calls can no longer jointly overshoot a cap by more than
  the gap between their estimates and their real costs.
- Every call pays one short serialized transaction before the provider call.
  Its critical section is two indexed reads and one insert, so throughput is
  bounded by that transaction, not by provider latency.
- Callers must supply an estimate. An estimate far above the real cost blocks
  calls early while in flight; one below it lets the cap be exceeded by the
  difference.
- A row whose settle failed (the process died, or the database was
  unreachable after the provider answered) stays `reserved` at its estimate
  until it ages out of the budget window. Reclaiming such rows earlier would
  need a sweep, which this decision does not add.
- The previous release inserts rows without the lock and with the column
  default `settled`; during a rolling deploy its calls are accounted as before
  and are not serialized against the new release's reservations.
