---
status: accepted
date: 2026-11-01
area: [backend]
supersedes: []
superseded-by: null
---

# Bound discarded upload data after completion body rejection

## Context

Gh-1381 requires an actual validation response for a 9 MiB completion request while
limiting retained request data to 8 MiB. Destroying the incoming stream when its
async iterator exits can reset the connection before the response is delivered.
A non-destroying iterator alone also produced a client EPIPE in a controlled upload.
Unbounded `req.resume()` avoids retaining the remainder but can keep consuming an
unlimited or stalled body. The implementation needs both a response attempt and a
bounded rejection lifetime.

[[2026-09-28-client-disconnect-propagation-in-the-ai-gateway]] covers cancellation
after validated input reaches provider work. This decision applies earlier, to
completion body rejection before any reservation or provider call. It does not
change that accepted record or the other gateway routes.

## Decision

Only the `POST /internal/complete` streaming 8 MiB body-cap rejection uses this
policy. Preserve the non-destroying iterator exit. Install one idempotent cleanup
for the rejection's timer and its own data/end/close/error listeners, then send
the fixed content-free JSON 413 response with `Connection: close` before resuming
the request. If the request/socket is already closed, clean up without attempting
a second response or replacing the primary failure.

Discard subsequent data without retaining chunks, parsing JSON, reserving budget
or calling the provider. Allow at most 2 MiB (2097152 bytes) of additional data and
2000 ms elapsed from rejection, whichever ends first. Destroy the request/socket
when the byte threshold is reached or the deadline expires. The counter includes
bytes delivered after rejection; the chunk that first crossed the original body
cap has already been read and is not accumulated. Stream delivery may cross a
threshold within one chunk; check it immediately and stop, without claiming an
exact bound on kernel, transport or process memory.

Request end, close, abort/error, explicit destruction and the byte/time limit
converge on cleanup. Remove only this policy's listeners, clear its timer and
settle once; do not leave a drain listener attached to a completed request. Do
not await an unbounded drain, replace the original rejection with a cleanup
exception, log body/error content, or add a queue, configurable limit, dependency
or reusable policy for unrelated routes. Existing body caps, image validation,
reservation ordering and provider cancellation semantics remain unchanged.

## Consequences

A normally completing 9 MiB owned upload must demonstrably receive HTTP 413, and
no provider call or accounting reservation may occur. This is not a guarantee
that every client sees a response after a transport failure or after exceeding
the rejection's byte/time bounds. Observed EPIPE/reset attempts remain diagnostic
failures, not substitute HTTP acceptance evidence.

The server may consume and discard bounded additional upload data to permit the
response to flush, then closes the connection rather than reusing an unread body.
Immediate destruction has lower lifetime cost but lost the required response in
observed schedules; unlimited draining avoids that cutoff but has no resource
bound. Controlled oversized, slow/stalled and aborted local uploads must prove
response and cleanup behavior with owned sockets and bounded settlement. No
client application, proxy configuration or other upload-handler lifecycle is
changed by this scoped decision.
