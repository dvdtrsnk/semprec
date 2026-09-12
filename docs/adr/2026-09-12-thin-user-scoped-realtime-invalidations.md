---
status: accepted
date: 2026-09-12
area: [backend]
supersedes: []
superseded-by: null
---

# Thin, user-scoped realtime invalidations

## Context

`semprec_events` (issue #161) is the one Postgres NOTIFY channel every
realtime message rides. Two constraints on it are easy to get wrong by
accretion — a later caller adding "just one more field" to a payload, or a
later scope adding a new invalidation-firing write path that forgets to
attribute it — so they are recorded here rather than left implicit in
`pgNotifyPublisher.ts`'s doc comments alone.

**Thin payloads.** Postgres caps a NOTIFY payload at ~8000 bytes, and this
channel is shared by every subscriber process — a payload that carries a
durable row's content (rather than its identifier) both risks that cap on a
large row and forces every listener to deserialize data most of them will
discard. `RealtimeMessage`'s item/schema invalidation variants therefore
carry only `kind`/identifiers/`op`/`updatedAt`, never a row's properties; the
API refetches the referenced row over REST. The one deliberate exception is
`notification_created`/`notification_read_state`, which the realtime layer
resolves to a full `notifications` row before sending — a notification's
`title` is pre-rendered text with no second enforcement layer to fall back
on, so re-deriving it client-side is not an option the way refetching an item
is.

**User-scoped fan-out.** Issue #161's acceptance criteria require that
"cross-user delivery is impossible." `items`/`databases`/`properties`/`views`
carry no ownership column — Semprec's REST reads are not scoped by user
either — so "the owning user" here means the user whose write caused the
event, not a row-level ACL. `chokePoint.ts`'s ~13 REST-reachable write
methods (`createItem`, `updateItem`, `softDeleteItem`, `restoreItem`,
`createDatabase`, `renameDatabase`, `archiveDatabase`, `createProperty`,
`updateProperty`, `deleteProperty`, `createView`, `patchView`, `deleteView`)
take an optional `actingUserId`, sourced from the REST handler's
`ctx.identity.user.id`; `syncServer.ts` sends the resulting `invalidate`
frame only to that user's own connected sockets (`sendToUser`), the same
pattern `notification_created`/`notification_read_state` already used.

A write with no single acting user — a rollup recompute, a mail-sync job, an
IMAP/Gmail reconciler, any of the ~30 other internal callers of
`createItemWithClient`/`updateItemWithClient` outside chokePoint's public
REST-facing wrapper methods — has no user to attribute the event to.
Threading a real human "acting user" through every one of those background
paths (most of which run with no HTTP request in flight at all) is a much
larger, speculative change this issue does not call for. Those events keep
`userId` unset, and `syncServer.ts` falls back to broadcasting them to every
connected socket: there is no user to exclude, and the underlying data is not
scoped to one, so this is not the cross-user leak the acceptance criteria
are about — it is the same "any authenticated user can already read this
over REST" surface the rest of the system already accepts.

**Reconnect protocol (issue #161's AC on healing).** The server never buffers
or replays a frame missed while a socket was closed — a reconnecting client
heals two different kinds of state two different ways. Active views/open
items refetch their current row over the ordinary item/database/property/view
REST endpoints, which already return current state regardless of what was
missed. Unread notifications refetch through the `GET
/api/notifications/unread` endpoint issue #152 built on top of issue #36's
`notifications` table (`identity.user.id`-scoped, ordered deterministically so
a client can tell frames it already applied from ones it missed) — the same
endpoint issue #36 already specified a connecting client calls once on
connect, which a reconnect is just another instance of. Neither path is new
work introduced by this issue; this ADR only records that the WS layer
deliberately does not try to duplicate either of them with a replay buffer.

**Trusting a NOTIFY payload's `userId`.** A payload on `semprec_events` is
otherwise-untrusted input the moment it's off this process's own write path —
Postgres's `NOTIFY` has no per-channel ACL narrower than "can connect to this
database," so a compromised or buggy writer elsewhere in the system could, in
principle, emit a `notification_created` message with a `userId`/
`notificationId` pair that don't actually belong together. `forwardNotification`
therefore re-checks the fetched `notifications` row's own `userId` against the
payload's claimed `userId` before sending, rather than trusting the payload's
`userId` outright to pick a socket to send to.

## Decision

- Every `RealtimeMessage`/`InvalidationEvent` payload stays thin: identifiers
  plus enough to let a client skip a stale echo, never a durable row's
  content, except the notification-created/read-state pair's resolved full
  row.
- An item/schema invalidation carries an optional `userId` naming the acting
  user. `syncServer.ts` sends it only to that user's sockets when present,
  and broadcasts to every socket only when absent (a system/background
  write with no acting user).
- A new REST-reachable chokePoint write method that fires `notifyInvalidation`
  must accept and forward `actingUserId` the same way the existing ~13 do —
  this is the mechanical rule that keeps a future REST addition from silently
  becoming a broadcast-to-everyone regression.
- `forwardNotification` sends a notification frame only to `userId`'s sockets
  after confirming the fetched row's own `userId` matches — never on the
  strength of the NOTIFY payload's `userId` field alone.
- The server never buffers or replays a missed frame of either kind. A
  reconnecting client heals by REST refetch: active views/open items through
  their normal endpoints, unread notifications through `GET
/api/notifications/unread` (issue #36/#152).

## Consequences

- A REST-driven write is delivered only to sockets authenticated as the user
  who made it; a bystander user's sockets never see it.
- A system/background-triggered invalidation still reaches every connected
  socket, matching the current, already-unscoped REST read surface for that
  data — narrowing that surface (e.g. resolving ownership through
  `resource_grants`) is a separate, currently-unused authorization mechanism
  this issue does not introduce.
- A malformed or tampered NOTIFY payload can, at worst, cause a notification
  frame to be silently dropped (row/payload `userId` mismatch) — never
  cross-user delivery.
- Client-side convergence for a missed frame (a disconnected socket, or the
  broadcast-fallback path landing on a socket for data its user cannot
  actually see) always goes through the client's own REST refetch on
  connect/reconnect — the server never buffers or replays a missed
  invalidation or notification.
