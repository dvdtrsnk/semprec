---
status: accepted
date: 2026-11-09
area: [backend]
supersedes: []
superseded-by: null
---

# Inbox type edges reserve current cards without waiting

## Context

[[2026-11-01-inbox-fingerprint-inputs-locked-through-proposal-write]] reserves the Inbox source before type-edge mutations. Confirmation can hold the proposal first and then need that source. [[2026-11-06-inbox-thread-sends-reserve-current-proposals]] uses nonblocking card reservations to avoid that cycle. Gh-1669 extends the same coordination to decided-card type protection.

## Decision

After reserving the source, resolve its current sourceInbox edges and reserve candidate cards in stable ID order with `FOR UPDATE NOWAIT`. Judge liveness and status only after each reservation, including for trashed cards, so a concurrent restore cannot escape the check. A live confirmed or rejected card refuses the type change with `proposal_locked`. A busy card refuses with `version_conflict`; map only SQLSTATE 55P03 after rollback and release of the reservation savepoint. Other errors propagate, and cleanup failures retain the original error. There is no automatic retry.

Type deletion reserves sources in stable ID order and applies the same fresh card check before clearing each edge. Decided sources retain their edges. A busy card aborts the transaction, including any earlier changes in that deletion.

## Consequences

Type mutations and sourceInbox association changes share the existing source reservation. This coordinates supported writers, not arbitrary SQL, and does not claim global deadlock freedom. Tests exercise finite concurrent schedules and transaction rollback.
