---
status: accepted
date: 2026-09-16
area: [backend]
supersedes: []
superseded-by: null
---

# Realtime outages and slow consumers close the socket rather than buffering

## Context

Issue #242 asked the sync server to survive two things it previously did not:
the dedicated `LISTEN` connection going away, and a client that stops reading.
Both are cases where the server holds state a client has not seen yet, and both
have an obvious-looking answer — keep it until the client can take it — that is
wrong here for the same underlying reason, so the answer is recorded once rather
than twice in two files' doc comments.

The reason is already established by
[[2026-09-12-thin-user-scoped-realtime-invalidations]]: a realtime frame on
`semprec_events` is thin. It carries identifiers, an `op` and an `updatedAt`,
never a durable row's content, and a client heals by refetching over REST on
connect. A frame is therefore not a durable message that must be delivered — it
is a hint that the client's copy of a row is stale. That makes "close the socket
and let the client refetch" a complete resume path, not data loss, and it is the
path every client already implements for its first connect.

**The `LISTEN` outage.** `NOTIFY` is not persisted by Postgres. When the
dedicated `LISTEN` connection errors, the events that arrive during the gap are
not queued anywhere the server could read later — there is nothing to replay
from, so a replay buffer is not an option that exists, only one that looks like
it does. The server also cannot tell which frames it missed, so it cannot tell a
client what to refetch either. A socket that *connected during the gap* is no
better off than one that was already open: it has no way to know it missed
anything, so distinguishing the two would be a distinction the server cannot
actually make correctly.

**The slow consumer.** Three independent stream types share one connection
(protocol-v1 text frames, agent event/delta frames, doc-sync binary frames).
Left to themselves each would have to choose between dropping a frame — silent,
and invisible to the client, which is the one outcome issue #242's Task rules
out — and letting `ws`'s outgoing buffer grow, which turns a single paused
reader into an unbounded memory cost on the server. A doc-sync update can be
megabytes; one paused socket is enough.

**Coalescing, and why it is not dropping.** A burst of writes to the same item
produces one thin invalidation per write, all saying the same thing: "this
`(databaseId, itemId)` is stale as of `updatedAt`." The newest one subsumes
every older one exactly. Collapsing them is therefore not a dropped frame, it is
the same information in one frame — but this holds *only* because the payload is
thin and idempotent. It would not hold for a stream whose frames carry content,
which is why the coalescer is typed to item-scope invalidations specifically
rather than to `OutboundFrame`.

`ws`'s `WebSocket` exposes no public `'drain'` event (only its internal inbound
`Receiver` has one), so a queued socket has to be polled for
`bufferedAmount === 0`; there is no event to wait on.

## Decision

- **A lost or restored `LISTEN` connection closes every connected socket with
  1012**, uniformly, including sockets that connected during the outage. The
  server never buffers or replays `NOTIFY` events across the gap.
- **Every outbound frame of every stream goes through one
  `sendWithBackpressure` gate.** No stream calls `ws.send` directly. When a
  socket's `bufferedAmount` is over `MAX_BUFFERED_BYTES` (4 MB) the gate closes
  it with 1013 instead of sending. It never drops a frame silently and never
  lets the queue grow without bound.
- **Item-scope invalidations for a socket that is behind are coalesced per
  `(databaseId, itemId)`, keeping the frame with the newest `updatedAt`**, and
  flushed when the socket drains. Coalescing is confined to that frame type; a
  stream whose frames carry content is not eligible for it.
- **A queued socket is drained by polling `bufferedAmount === 0`**, one timer
  per socket, cleared as soon as its queue empties or the socket closes.
- The client's resume path after 1012 or 1013 is the one that already exists:
  reconnect, then refetch current state over REST, per
  [[2026-09-12-thin-user-scoped-realtime-invalidations]].

## Consequences

- A client must treat 1012 and 1013 as "reconnect and refetch," not as an error
  to surface. They are the normal outcome of a deploy, a database blip, or a
  tab that stopped reading — not a fault.
- A `LISTEN` outage is a visible, uniform event: every socket is closed, so no
  client is left attached to a process that can no longer fan anything out to
  it. The cost is that a brief blip disconnects clients that missed nothing.
  That is accepted deliberately: the server cannot tell which ones those are.
- One slow consumer costs at most 4 MB of server buffer plus one coalesced
  frame per stale item, then loses its connection. It can never make the
  process's memory a function of how long it stays paused.
- A new outbound stream added later must send through `sendWithBackpressure`,
  or it reintroduces exactly the unbounded-queue path this decision removes.
  This is the mechanical rule a reviewer checks, the same way
  [[2026-09-12-thin-user-scoped-realtime-invalidations]] makes `actingUserId`
  the mechanical rule for a new REST-reachable write.
- Coalescing means a client observing frame counts cannot infer the number of
  writes that happened. Nothing depends on that today, and the thin-payload
  decision above is what makes it safe; a future frame type that carries
  content must not be routed through the coalescer.
