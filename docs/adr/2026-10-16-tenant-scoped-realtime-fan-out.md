---
status: accepted
date: 2026-10-16
area: [backend]
supersedes: [2026-09-12-thin-user-scoped-realtime-invalidations]
superseded-by: null
---

# Tenant-scoped realtime fan-out

## Context

[[2026-09-12-thin-user-scoped-realtime-invalidations]] let an invalidation with no acting
user (a rollup recompute, a mail-sync job) fall back to every connected socket. With more than one
tenant that sends one tenant's item ids to every other tenant's sockets. NOTIFY payloads also carried
no tenant at all, so a listener could not tell whose message it was handling.

## Decision

- **Kept from the superseded decision:** payloads stay thin (identifiers, never a durable row),
  except the full-row `notification` frame; `forwardNotification` still re-checks the fetched row's
  `userId` against the payload; nothing is buffered or replayed, and a reconnecting client heals by
  REST refetch.
- **Postgres-computed tenant envelope.** Both channels carry `{ "tenantId": <uuid|null>, "message": ... }`.
  The tenant is computed in the publishing statement from the publisher's own scope
  (`app_tenant_default()`), never taken from the message body. `session_revoked` takes the tenant of
  the session's user instead, because sessions are global rows revoked from scopes that are not the
  owner's tenant.
- **Tenant-only delivery.** A socket carries the tenant of its authenticated identity. Delivery goes
  to `sendToTenant(tenantId, frame, userId?)`: only sockets of the envelope's tenant, with `userId`
  as an optional narrowing inside it. There is no broadcast. `session_revoked` closes only sockets
  matching both session and tenant.
- **Drop and log.** An envelope without a valid uuid `tenantId`, or with an invalid inner message,
  is dropped with one `realtime_message_without_tenant` warning naming channel and type, never content.
- **Scopes.** The LISTEN connection is opened under `runAsSystem`; each parsed envelope is handled
  under `runInTenant(envelope.tenantId)`, so row reads run under the message's tenant. Upgrade
  authentication and heartbeat revalidation read global identity tables under `runAsSystem`.
- **Per-registry checks.** `doc:open`, doc writes and `agent:watch` resolve inside the socket's
  tenant. This narrows the "no authorization boundary" statements of
  [[2026-09-12-per-process-doc-sync-subscription-registry]] and
  [[2026-09-12-per-process-agent-run-watch-registry]] without superseding them.

## Consequences

- A background invalidation reaches only the publisher's tenant's sockets.
- A publisher with no tenant (`null`) produces a message every listener drops; that is a bug
  surfaced by the warning, not a silent broadcast.
- A tampered payload can at worst be dropped or delivered inside the tenant it names; the
  ownership re-check and row-level security still apply inside that tenant.
