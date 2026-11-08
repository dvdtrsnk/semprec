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
  the session's user instead (`COALESCE(u.tenant_id, app_sole_tenant())`, the same binding the socket
  gets), because sessions are global rows revoked from scopes that are not the owner's tenant. An
  unknown session id yields a `null` tenant, so that revocation is dropped and heartbeat revalidation
  is the only path that closes the socket.
- **Tenant-only delivery.** A socket carries the tenant of its authenticated identity. Delivery goes
  to `sendToTenant(tenantId, frame, userId?)`: only sockets of the envelope's tenant, with `userId`
  as an optional narrowing inside it. There is no broadcast. `session_revoked` closes only sockets
  matching both session and tenant. Agent-stream deltas are the exception until #1027: they still
  reach a run's authorized watchers by run id, and the envelope's tenant only sets their scope.
- **Drop and log.** An envelope without a valid uuid `tenantId`, or with an invalid inner message,
  is dropped with one `realtime_message_without_tenant` warning naming channel and type (only when
  the type is one of the catalog's own literals), never content.
- **Scopes.** The LISTEN connection is opened under `runAsSystem`; each parsed envelope is handled
  under `runInTenant(envelope.tenantId)`, so row reads run under the message's tenant. Upgrade
  authentication and heartbeat revalidation read global identity tables under `runAsSystem`.
- **Per-registry checks (decided here, implemented by #1026 and #1027).** `doc:open`, doc writes and
  `agent:watch` are to resolve inside the socket's tenant, and watchers are to be checked against
  the message's tenant. This change does not do that yet: the inbound frame handlers and the
  registries are still tenant-unaware. Once #1026 lands it narrows the "no new authorization
  boundary" statement of [[2026-09-12-per-process-doc-sync-subscription-registry]] without
  superseding it. [[2026-09-12-per-process-agent-run-watch-registry]] already records the
  setup-account owner check as a deliberate authorization boundary; #1027 adds the tenant check
  alongside that owner check rather than replacing it.

## Consequences

- A background invalidation reaches only the publisher's tenant's sockets.
- A publisher with no tenant (`null`) produces a message every listener drops; that is a bug
  surfaced by the warning, not a silent broadcast.
- A tampered payload can at worst be dropped or delivered inside the tenant it names; the
  ownership re-check and row-level security still apply inside that tenant. Until #1027, an
  agent-stream delta is the exception: it reaches the run's watchers whatever tenant it names.
