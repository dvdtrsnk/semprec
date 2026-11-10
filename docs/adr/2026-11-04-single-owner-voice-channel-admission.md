---
status: accepted
date: 2026-11-04
area: [backend]
supersedes: []
superseded-by: null
---

# Single-owner voice channel admission

## Context

[[2026-10-28-live-voice-chains-speech-to-text-agent-turn-and-text-to-speech]]
specifies one concurrent voice session per user and fixed frames and limits.
Gh-1546 delivers only the authenticated channel and handler port. The current
API composition has one upgrade owner, tenant deactivation listener and
shutdown owner; there is no separate voice module lifecycle or distributed
voice admission store. A process-local map cannot establish admission across
multiple API processes.

## Decision

The supported initial deployment has one voice-owning API process. Construct
one channel handle in serve.ts alongside the sync server, with upgrade,
closeTenant and bounded idempotent close operations. Reserve at most one
connection per authenticated user in that handle, including authentication
completion races, and release on every failure/close path. The one-session
guarantee is scoped to this single-owner deployment. Multiple voice-owning
processes are unsupported until a separately approved distributed admission
owner exists; no cluster-wide guarantee is claimed or simulated here. This
is an explicit initial deployment restriction, not a hidden distributed lease
or a claim of production readiness. Record it in the delivery handover.

Reuse the existing tenant deactivation listener to close voice as well as
sync; do not add a second listener or invent module-deactivation wiring.
Revalidate the session periodically using the existing auth owner. Close a
late authenticated upgrade if global shutdown or tenant deactivation occurred
during authentication. Shutdown stops the existing listener, closes both
channels before HTTP drain and pool shutdown, attempts later teardown after a
channel failure, and retains current mail/queue ordering. Voice close bounds
its own work and is idempotent; no unbounded pending session survives it.

Use the original voice vocabulary exactly: client start with language and an
optional thread id, stop and end; server ready, transcript, speaking, error
and end. There is no mute, unmute or closed control in this delivery. Preserve
the original binary directions, stable errors and numeric limits. Stop is
forwarded through the port, not implemented as agent cancellation here.
Gh-1734 owns speech/thread/turn integration; gh-1396 and gh-1399 retain provider
work. Audio is never persisted or logged. Schema validation and bounded
resource handling stay in the channel owner.

## Consequences

Real WebSocket tests cover authentication/origin before handshake, runtime
tenant/user identity, concurrent admission and release, pending-auth shutdown
and deactivation races, only the revoked session closing, limits, binary
direction, backpressure, missing handler and actual shutdown. These are
single-owner tests, not proof of distributed admission. Production requiring
multiple owners remains outside this supported configuration and cannot be
cleared by local acceptance or gh-1086 exceptions. The original voice ADR body
and listening qualification remain unchanged.
