---
status: accepted
date: 2026-11-10
area: [backend]
supersedes: []
superseded-by: null
---

# Guidance write transaction compatibility and fresh callbacks

## Context

[[2026-09-29-withtransaction-is-the-sole-transaction-opener]] establishes managed transactions as the normal production boundary. The resolved-guidance writer also has existing callers supplying their own transaction. [[2026-11-10-resolved-guidance-notifications-use-a-writer-savepoint]] and [[2026-11-10-manual-guidance-writes-have-no-realtime-callback]] describe its savepoint and callback behavior.

## Decision

Only `agent_guidance_drift_resolved` retains compatibility with an already supplied caller-owned transaction. Its notification and fanout remain atomic in that transaction, and the caller owns the borrowed connection lifecycle. Normal production composition continues to use `withTransaction`; this exception authorizes no new manual production transaction opener, other notification kind, callback API, or generic transaction owner.

A fresh resolved-guidance insert in an active managed transaction registers its realtime callback for successful commit. A deduplicated managed replay registers no callback, and an unmanaged resolved-guidance write registers none.

## Consequences

A rollback cannot deliver this writer's resolved-guidance callback. A manual commit persists the SQL notification and fanout but does not emit that callback. Existing transaction and callback behavior outside this narrow compatibility exception is unchanged.
