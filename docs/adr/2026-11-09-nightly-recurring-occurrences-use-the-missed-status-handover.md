---
status: accepted
date: 2026-11-09
area: [backend]
supersedes: []
superseded-by: null
---

# Nightly recurring occurrences use the missed-status handover

## Context

[[2026-11-08-nightly-task-rollover-writes-user-owned-schedule]] confines the nightly handover to one-off schedule fields. Gh-1677 extends that action to close recurring occurrences without moving their dates.

## Decision

The recurring step may use a typed status-only variant of the same handover to write `missed`. The candidate item is locked and rechecked before its series row. If an existing latest occurrence is found after the series lock, reserve it only with `FOR UPDATE NOWAIT` and recheck its liveness, series and date. SQLSTATE 55P03 propagates and rolls back the current batch; the existing queue retry handles a later attempt. The original one-off handover is unchanged.

## Consequences

This is a narrow ownership extension, not permission for other system writers to update user status. The protocol does not claim global deadlock freedom. The action preserves terminal and future occurrences and runs in bounded batches.
