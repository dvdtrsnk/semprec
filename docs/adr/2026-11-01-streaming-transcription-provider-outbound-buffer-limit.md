---
status: accepted
date: 2026-11-01
area: [backend]
supersedes: []
superseded-by: null
---

# Bound the streaming transcription provider's outbound buffer

## Context

Gh-1396 bounds incoming caller frames and its gateway queue, but those limits do
not bound a separate provider WebSocket's outbound `bufferedAmount`. Audio writes
can otherwise continue queuing base64 JSON while the provider stops reading.
[[2026-09-16-realtime-outage-and-backpressure-close-rather-than-buffer]] records
close-on-backpressure for thin realtime invalidations; its refetch recovery and
4 MB threshold do not specify this audio-content transport. The live voice ADR's
caller-facing buffer is a different boundary too.

## Decision

The OpenAI streaming transcription adapter uses one outbound gate for every
provider JSON event: session configuration, audio append and final commit. Its
limit is 256 KiB (262144 bytes). Encode the complete event once and count its UTF-8
bytes, including JSON and base64 overhead. Send only when the socket is open and
`bufferedAmount + encodedFrameBytes <= 262144`; equality is allowed. An individual
oversized frame or projected overflow fails the provider session before sending
that frame. Do not coalesce, silently drop, wait without a bound, or add another
application queue. This is a transport-buffer bound, not a bound on total process
memory or proof of network delivery.

Use the existing typed provider failure path with a fixed content-free diagnostic
and terminate the provider socket with existing cleanup. Settle or fail the active
accounting chunk through the gateway's existing provider-error path; no reservation
may remain because of this failure. A failed configuration send before successful
session open rejects `open()` rather than returning a usable session. A later
failure reports once through the session events. Pending-open abort, timers,
listeners, already-stopped writes and error precedence retain bounded settlement.
No audio, transcript, credential, provider body or raw exception is added to logs.

## Consequences

A slow provider visibly fails the stream with `provider_error`; it cannot resume
from dropped audio. This is accepted instead of accumulating audio indefinitely.
The 256 KiB constant is independent of the caller-facing voice-channel threshold
and is not made configurable without a concrete requirement. Local controlled
socket tests must exercise below/equal/over limits, a single oversized event,
configuration/audio/commit paths and no extra sends after failure. Real gateway
composition must prove error delivery and accounting cleanup with an owned fake
provider. No live provider or comparative listening evidence is implied.
