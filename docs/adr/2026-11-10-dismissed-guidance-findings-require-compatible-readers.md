---
status: accepted
date: 2026-11-10
area: [backend]
supersedes: []
superseded-by: null
---

# Dismissed guidance findings require compatible readers

## Context

A dismissed guidance finding has its own persisted status. Older readers that accept only active and resolved cannot decode that status.

## Decision

Deploy readers and rollback artifacts that accept dismissed before enabling a writer that persists it. The database constraint expansion alone does not make an old reader compatible. Until all serving API and worker readers and rollback artifacts are compatible, deployment of the new writer remains blocked.

## Consequences

Local migration and application tests cannot establish the fleet compatibility gate. A rollout must maintain compatible readers when rolling back after dismissed rows have been written.
