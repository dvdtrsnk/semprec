---
status: accepted
date: 2026-11-10
area: [backend]
supersedes: []
superseded-by: null
---

# Manual guidance notification writes have no realtime callback

## Context

[[2026-11-10-resolved-guidance-notifications-use-a-writer-savepoint]] allows the data writer to operate in caller-owned transactions. The existing after-commit owner drains callbacks only for managed transactions; a manual transaction cannot signal its commit or rollback to that owner.

## Decision

For `agent_guidance_drift_resolved`, register the realtime notification callback only when the supplied client belongs to the active managed transaction. An unmanaged caller may still write the notification and enqueue its fanout in its own transaction, but receives no realtime callback from this writer. Other notification kinds retain their existing behavior.

## Consequences

Notification and fanout commit or roll back together in either caller transaction. Managed commits deliver the existing realtime callback after commit; managed rollbacks do not. Manual commits do not deliver that callback, and a manual rollback cannot leave this writer's callback parked on the client for a later transaction.
