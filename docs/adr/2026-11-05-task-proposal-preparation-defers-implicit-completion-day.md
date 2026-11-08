---
status: accepted
date: 2026-11-05
area: [backend]
supersedes: []
superseded-by: null
---

# Defer an implicit Tasks completion day during proposal preparation

## Context

[[2026-10-31-confirmed-proposal-update-preconditions]] separates client-free,
read-only preparation from the actual managed write and permits implicit
user-key allocation to be deferred. Tasks completion and first-planned-day
rules need the tenant time zone and current instant. The existing Tasks
preparation has neither a database client nor those transactional inputs.
Guessing them while forming a proposal could present a different day from the
one eventually written. Failing preparation for every Tasks status update
would prevent the required completion behavior from composing with proposals.

This extends the existing preparation mechanism for gh-1544 and gh-1602. It
preserves the historical ADR bodies, transform ownership checks and
[[2026-11-01-value-link-handoff-covers-transformed-user-properties]].

## Decision

Tasks preparation continues sharing deterministic schedule validation and
normalization without reading settings, allocating, running hooks or writing.
The actual Tasks transform obtains the tenant time zone and current instant
in the existing managed write and applies the resulting-state completion and
first-planned-day rules there. It introduces no new transaction or lock.

Only when entering done without caller-supplied completedOn, preparation
marks the user-owned completedOn as deferred and omits its predicted value.
An update proposal supplies the current before value and no after value for
that implicit field, using the existing deferred-key enforcement. Confirmation
repeats preparation under the existing item lock and the real write computes
the day once. Explicit completedOn remains an ordinary caller value with
normal before/after coverage and write-time future-day validation. Automatic
clearing on a transition to notDone or wontDo is deterministic and also retains
ordinary coverage. Repeated done preserves the existing completion values.

System-derived completedAt, since and sinceTime are computed by the real
module transform and are not declared deferred: deferredKeys accepts user
properties only. Preparation does not fabricate their values. A client still
cannot supply those system properties. The existing value-link handoff must
cover any resulting user-owned completion field, just like other transformed
user properties; this decision grants no additional writer permission.

## Consequences

An implicit completion proposal can commit on a later local day than when it
was prepared; its contract intentionally does not promise a predicted day.
Explicit caller dates and deterministic clears keep the normal precondition
contract. Real proposal tests must prove missing-before and predicted-after
refusal, valid confirmation, ordinary explicit/clear coverage and unchanged
state after refusal. Time-zone and clock rules remain tested on the actual
Tasks write path. Generic preparation, proposal envelope, recurrence behavior
and other module registrations remain unchanged.
