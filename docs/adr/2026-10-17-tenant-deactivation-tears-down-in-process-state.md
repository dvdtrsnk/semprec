---
status: accepted
date: 2026-10-17
area: [backend]
supersedes: []
superseded-by: null
---

# Tenant deactivation tears down in-process state

## Context

When a tenant leaves `active` (suspension today, deletion later), the database already ends its
access: its sessions are revoked, `verifySessionToken` refuses it, new queue jobs of a non-active
tenant complete as no-ops, and per-tenant sweeps visit active tenants only. What survives is state a
long-lived process keeps in memory per tenant: open sync-server sockets, hosted mail live-sync
lifecycles (until the next 60 s discovery pass), and Semp's per-tenant conversation with its TTL
timer. The status changes in whichever process runs the admin or account route, while that state
lives in other processes. They share only Postgres.

[[2026-09-10-side-effects-follow-the-commit]] registers every announcement of a write with
`runAfterCommit`. That works for announcements whose loss is harmless, but a deactivation signal lost
between the commit and the after-commit callback (a crash, a failed NOTIFY) would leave a deactivated
tenant's state running until the next restart or discovery pass.

## Decision

- **Channel and payload.** Deactivation travels as a Postgres NOTIFY on `semprec_tenant_status`
  (`TENANT_STATUS_CHANNEL` in `backend/packages/data/src/tenancy/tenantStatusSignal.ts`). The payload
  is the JSON text `{"tenantId":"<uuid>"}`, built by Postgres with
  `json_build_object('tenantId', $2::uuid)::text`. A listener validates it as exactly that shape and
  logs and drops anything else.
- **NOTIFY inside the status-changing transaction.** `publishTenantDeactivated(client, tenantId)`
  runs `pg_notify` on the caller's transaction client, in the same transaction as the status write.
  This is a deliberate exception to [[2026-09-10-side-effects-follow-the-commit]], which otherwise
  stands: Postgres itself queues a NOTIFY issued inside a transaction until `COMMIT` and discards it on
  rollback, so the signal can neither arrive before the status is visible nor announce a rolled-back
  change, and no crash window exists between the commit and the publish. A writer that moves a
  tenant out of `active` publishes this way; `suspendAccount` does today, and deletion (#1049) is to
  call it from its own transaction. Reactivation publishes nothing.
- **Resync on (re)connect.** NOTIFY is not persisted, so a listener that was not connected misses it.
  `startTenantDeactivationListener` runs `LISTEN` on one dedicated client, then reads
  `SELECT id FROM tenants WHERE status IN ('suspended','deleting')` on that client, and calls its
  handler for each id. It does so on the first connect and on every reconnect after a connection
  error (capped exponential backoff, 200 ms to 5 s). The read follows `LISTEN`, so a deactivation
  committed in between reaches the handler through one path or the other, possibly both.
- **Idempotent consumers.** Because of the resync, a handler is called repeatedly for the same
  tenant. Every consumer treats a repeated call for a tenant it no longer holds state for as a no-op.
- **Scope.** The listener runs in a system scope (`tenantDeactivationListener`, its resync read in
  `tenantDeactivationResync`). A consumer that needs a tenant re-enters it explicitly with
  `runInTenant`.
- **Any per-process registry keyed by tenant must subscribe.** A future in-memory registry that holds
  per-tenant state beyond a request (a socket set, a hosted lifecycle, a cached session, a timer)
  adds an idempotent teardown method and is wired to the listener of the process that composes it.
  Today `semprec-api` wires `SyncServer.closeTenant` and `MailLiveSyncRoot.stopTenant`.
  `SempConversation.dropTenant` exists but is wired by whichever issue first composes a
  `SempConversation` into a process, and `semprec-agents` subscribes for in-flight agent runs in
  #1050.
- **Shutdown.** A process closes its listener before the components its handler calls into, so no
  handler runs against a closing sync server or mail root. `close()` waits for handler calls already
  in flight and starts none afterwards. That wait is as long as the slowest consumer teardown, which
  for a mailbox lifecycle includes a discovery pass and its lifecycle's `start()`, so the shutdown
  sequence bounds it: `semprec-api` waits at most `LISTENER_CLOSE_TIMEOUT_MS` (5 s) and then moves on,
  accepting that a handler still running past the bound races the components' own close. Each
  consumer's teardown is idempotent against that close.

## Consequences

- A suspended tenant's sockets close with 4401 (`account deactivated`) and its mailbox lifecycles stop
  in `semprec-api` when the NOTIFY arrives, instead of on the next heartbeat or discovery pass. An
  upgrade that authenticated against the session before the suspension committed is closed the same
  way once it attaches. A handler call that fails is logged and not retried: the tenant's state then
  stops on the next reconnect's resync, discovery pass or heartbeat session check, as before this
  decision.
- A process that was disconnected when the tenant was deactivated catches up when it reconnects, at
  the cost of re-running every consumer for every non-active tenant on each reconnect.
- Consumers stop their in-memory state only. A later discovery pass or new connection is kept out by
  the tenant's status, not by the listener; a reactivated tenant is picked up again by the normal
  paths.
- A new status writer that forgets to publish leaves that state running until the next pass or
  restart. The tenant's database access still ends, so the omission degrades latency, not isolation.
