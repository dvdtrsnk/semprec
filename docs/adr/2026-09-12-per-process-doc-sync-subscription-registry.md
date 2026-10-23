---
status: accepted
date: 2026-09-12
area: [backend]
supersedes: []
superseded-by: null
---

# Per-process doc-sync subscription registry

## Context

Issue #162 adds a second, structurally different fan-out path onto `WS
/api/sync` alongside the one [[2026-09-12-thin-user-scoped-realtime-invalidations]]
already governs. `docSync.ts`'s `createDocSyncRegistry` diverges from that
ADR's decision on three points, which is worth recording explicitly rather
than leaving a reader to wonder whether the divergence was noticed:

**Fan-out scope is per-document-subscription, not per-user.** The existing
`invalidate`/`notification` frames are scoped to "the acting user's own
sockets" (`sendToUser`). A Yjs document has no single "acting user" to scope
by — any number of users may have the same document open concurrently, and
the whole point of `doc:open`/`doc:close` is to track exactly that set per
socket. `subscribersByDoc` (a `Map<docId, Set<WebSocket>>`) and
`openDocsByClient` (a `WeakMap<WebSocket, Set<docId>>`) are this registry's
per-process subscription state, rebuilt from scratch as sockets open/close —
there is nothing to persist across a process restart, since a reconnecting
client always re-sends `doc:open`.

**The payload is full Yjs bytes, not a thin reference.** Every other
outbound frame on this channel carries an identifier the client resolves by
refetching the durable row over REST. A Yjs update cannot be "refetched" that
way — the update itself *is* the content a CRDT merges, and there is no
REST endpoint that hands back an arbitrary state-vector-relative diff. So
`fanOutDocUpdate` sends the actual update bytes (fetched by primary key via
`getDocUpdateById`), and `handleOpen`/the SyncStep1 branch of
`handleBinaryFrame` send full `Y.encodeStateAsUpdate` diffs. This is a
deliberate exception to the "thin payload" rule, scoped to this one message
kind, for the same reason `notification_created` already is.

**A missing `doc_updates` row triggers resync, not silence.** The existing
ADR's reconnect protocol is explicit that the server never buffers or
replays a missed frame — a reconnecting client heals by REST refetch instead.
Doc sync cannot use that escape hatch: `doc_updates` is not a REST-readable
resource a client can independently refetch, and issue #86's compaction can
delete a referenced row out from under an in-flight NOTIFY (`fanOutDocUpdate`
racing a `compact()` call for the same document). `getDocUpdateById`
returning `null` therefore falls back to a full `writeSyncStep2` resync from
`loadYDoc` (`doc_snapshots` merged with any still-pending `doc_updates`)
rather than dropping the frame — `doc_snapshots` retains everything the
deleted row contributed, so this is recovery, not replay: no state is
reconstructed from a buffer the server held onto, only from what is still
durably present.

**No new authorization boundary.** `handleOpen` checks only that a `docs`
row exists (`getDocById`), the same "any authenticated socket may act on any
existing resource" surface [[2026-09-12-thin-user-scoped-realtime-invalidations]]
already documents for `items`/`databases`/`properties`/`views`: there is no
ownership/membership column on `docs` (or the `items`/`databases` a doc
belongs to) to check against, and every REST read of the same content is
already unscoped the same way. This registry does not introduce a new gap —
it is consistent with, not a regression from, the existing surface. Adding
real per-document access control would mean introducing an ownership or
`resource_grants`-style model across `items`/`databases`/`docs` first, which
neither this issue nor the ADR it extends calls for.

## Decision

- `createDocSyncRegistry` owns its own per-process subscription state
  (`subscribersByDoc`/`openDocsByClient`), separate from and orthogonal to
  `syncServer.ts`'s `identityByClient` — subscription is per-socket-per-doc,
  not per-user.
- `doc:open`/`doc:close`/binary sync-protocol frames on `WS /api/sync` carry
  full Yjs bytes (state vectors, encoded updates), not thin identifiers —
  a second deliberate exception to the thin-payload rule, alongside
  `notification`.
- A `fanOutDocUpdate` call whose referenced `doc_updates` row is already gone
  falls back to a full `SyncStep2` resync from `doc_snapshots`, rather than
  dropping the frame — recovery from durably retained state, not a replay
  buffer.
- `handleOpen`'s only precondition is that the named `docs` row exists.
  Per-document access control is out of scope until an ownership/membership
  model exists to check against.
- A per-socket rate limit (`MAX_UPDATES_PER_WINDOW` accepted Update/SyncStep2
  frames per `RATE_LIMIT_WINDOW_MS`) bounds how much of this process's
  Postgres connection pool one socket's `mutateYDoc` transactions can consume,
  independent of the 1 MiB per-frame cap `MAX_INBOUND_FRAME_BYTES` already
  enforces.

## Consequences

- A doc-sync frame is heavier than an invalidation frame and is delivered to
  every socket with that document open, not just the writer's own — this is
  necessary for real-time collaborative editing and is not a leak, since
  every recipient already had that document open (the same "already has read
  access" precondition the rest of this surface relies on).
- Any authenticated user who can reach `WS /api/sync` can open, read, and
  write any existing document by id — identical to today's REST surface for
  `items`/`databases`, and unchanged by this issue. Narrowing this later
  requires a real ownership/membership model, not a one-off check here.
- A burst of updates from one socket beyond the rate limit is dropped rather
  than persisted or queued; the client's own document state is unaffected,
  and its next accepted update still carries the full accumulated diff.
