---
status: accepted
date: 2026-11-05
area: [backend]
supersedes: []
superseded-by: null
---

# Voice transport oversize closes before application errors

## Context

[[2026-10-28-live-voice-chains-speech-to-text-agent-turn-and-text-to-speech]]
requires a voice error frame before closing oversized, malformed or unknown
frames. [[2026-11-04-single-owner-voice-channel-admission]] retains its size
limits for the API-owned channel. The WebSocket receiver rejects messages
exceeding its 16 KiB maximum before delivering them to application code. An
application cannot reliably send its own error frame after that transport
has started its protocol close. Raising that maximum solely to emit JSON
would weaken the resource bound.

## Decision

Keep the receiver maximum at 16 KiB. When its transport size guard rejects an
oversized incoming message, close with WebSocket code 1009; no preceding
application error frame is guaranteed or required. This exception covers
only rejection before application delivery and does not authorize buffering,
truncation, forwarding or persistence of rejected content.

For delivered frames, preserve application validation and the 4 KiB text
limit: malformed or unknown control messages, or text exceeding 4 KiB within
the transport bound, receive a sanitized stable error before close when the
connection is writable. Do not log frame/audio content or raw library error
text. The handler port must not receive a rejected frame. All other numeric
limits, admission, identity, shutdown, outgoing backpressure and protocol
vocabulary remain as decided. This addendum narrows only the original
error-before-close requirement; neither earlier accepted ADR body is edited.

## Consequences

A real oversized WebSocket message test checks code 1009, no handler call and
owned connection settlement without requiring a JSON error. Separate bounded
application-invalid and oversized-text tests check sanitized error-before-close.
These are distinct transport and application outcomes, not a claim that every
protocol failure can send an application response or that ignored data was
successfully processed.
