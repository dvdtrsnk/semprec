---
status: accepted
date: 2026-11-10
area: [backend]
supersedes: []
superseded-by: null
---

# Resolved guidance notifications use a writer savepoint

## Context

The notification writer deduplicates a transition, but the project used to enrich a first insert can later be trashed. A replay must retain the original notification without requiring that project to remain live.

## Decision

The existing data notification writer arbitrates resolved-guidance transitions through its unique upsert inside a savepoint. It enriches and enqueues only a newly inserted row. Failure before release rolls the savepoint back. If savepoint cleanup cannot establish rollback, or a failure follows release, the writer marks a managed transaction rollback-only when applicable and attempts a full transaction rollback. The caller owns the connection and must discard it when the reported cleanup outcome is unsafe.

## Consequences

Concurrent duplicate calls share the existing unique-key arbitration and only a first insert schedules fanout. A caller that catches a locally recovered failure may still commit earlier unrelated work. A terminal rollback also rolls back that earlier work; cleanup errors retain the original failure as their cause.
