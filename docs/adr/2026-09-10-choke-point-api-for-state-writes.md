---
status: accepted
date: 2026-09-10
area: [backend, web]
supersedes: []
superseded-by: null
---

# All writes to item/database state go through one choke-point API

## Context

Semprec's data layer backs a Postgres schema engine, Yjs CRDT blocks/canvas,
realtime WebSocket sync, an audit/undo history, and an AI agent runtime that
reads and proposes changes to the same rows. Any of these — a REST endpoint,
a background worker, a heartbeat handler, the web frontend, an agent tool —
could in principle issue a direct `UPDATE`/`INSERT` against item tables.

The alternative to a single write path is letting each caller write directly
whenever it's convenient, trusting each one individually to remember
idempotency, versioning, and event emission.

## Decision

Every mutation of item/database state goes through the generic choke-point
API (`POST`/`PATCH /api/items`, the relation endpoint, `confirm`/`revise`) or
the single data-layer write function that backs it. No service, worker,
script, or the web frontend issues a direct write against item tables. The
one exception is an issue whose explicit task is to build or extend the
choke-point itself.

## Consequences

- Idempotency keys, `ifVersion` conflict checks, `owner`/`locked`
  enforcement, event emission (WS invalidations, `onItemEvent` heartbeat
  triggers), and audit history all live in exactly one place and are
  guaranteed to run on every write.
- A write that bypasses the choke-point is invisible to all of the above:
  clients don't refresh, heartbeats don't fire, edit history lies. This is
  why bypassing it is a critical/high-severity review finding
  (`review-rules/rules.md`, `review-rules/tasks/architecture.md`), not a
  style preference.
- New write paths cost slightly more up front (route through the
  choke-point instead of a direct query) in exchange for every consumer
  getting sync, history, and conflict handling for free.
