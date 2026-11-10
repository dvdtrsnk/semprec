---
status: accepted
date: 2026-11-01
area: [backend]
supersedes: []
superseded-by: null
---

# Keep STT stream ownership until its accounting attempts finish

## Context

Gh-1396 serializes received frames through a per-stream promise queue. A reservation
can still be running before the stream assigns its chunk. Settlement clears the
chunk reference before awaiting database work and its retries. Cleanup that checks
only that reference can therefore release the stream while accounting is in flight.
`serve.ts` passes `closeAll()` to gateway shutdown, which can then end the pool before
a late reservation's fail or a settlement retry acquires a connection.

[[2026-09-17-shutdown-ordering-with-late-heartbeat-stop]] establishes waiting for
owned gateway work before pool closure. This decision specifies ownership inside
the STT stream; it does not replace the HTTP drain, heartbeat or pool timeout order.
The reserve/settle/fail semantics remain those of
[[2026-09-27-ai-budget-reservations-under-a-global-advisory-lock]].

## Decision

The existing serialized frame queue owns each started reservation, provider open,
chunk close and accounting retry. A chunk variable becoming null is not evidence
that its operation completed. On termination, synchronously mark the stream done,
stop accepting/enqueuing input, clear stream timers and abort provider work using
the existing bounded provider contract. No more audio is forwarded after done.

Retain the stream in the open registry and retain its concurrency slot until a
single idempotent cleanup promise has observed the final frame-queue tail, including
its in-flight reservation, late reservation fail, chunk settlement and retries,
and then closed any remaining chunk. After done, queued frames must not start new
work. Repeated disconnect/drop/closeAll calls observe the same cleanup ownership.
A finish invoked inside a queue callback initiates cleanup without awaiting its
own queue tail; the callback must return so that the tail can finish. Avoid both
self-await cycles and parallel final closeChunk calls.

Only after those operations finish may cleanup release the slot/remove the handle
and allow `closeAll()` to resolve. Existing gateway shutdown therefore reaches
`pool.end()` afterwards through its current closeStreams hook. Do not open another
worker, background retry, generic lifecycle abstraction or independent timeout that
reports accounting complete while its work continues. Existing provider deadlines,
connection/statement limits and finite accounting retry policy still apply; this
record does not promise an independent wall-clock bound for the whole process.

Preserve accounting/error semantics. A late successful reservation after disconnect
must run its existing fail before cleanup completes. Successfully accounted audio
settles to actual duration. Terminal settle failure deliberately retains the
reserved estimate and logs it for reconciliation under the existing budget policy;
terminal fail errors retain their existing logged outcome. Do not rewrite those
rows to zero cost or claim successful accounting after database failure. Local
stream-cleanup diagnostics contain fixed markers and checked name/code/identifiers,
not raw error content. They must not skip ownership release or mask the primary
failure.

## Consequences

A disconnect during accounting can take longer to release its stream slot. That
cost is accepted to prevent pool closure racing the operation. Waiting only for
the currently referenced chunk was rejected because the reference does not own
in-flight work. Awaiting cleanup from the active frame callback was rejected
because it can await itself indefinitely.

Owned runtime-role tests use the gateway's `semprec_side` role and force actual
reservation and settlement blocking with exact participant PIDs. Before release,
closeAll and composed pool closure must remain pending; afterwards healthy
accounting must finish with no reserved row. Cover retry and terminal-failure
outcomes, repeated finish/closeAll and finish invoked inside the queue, with bounded
settlement and owned cleanup. A permanent database outage, forced process kill or
external timeout is not a guarantee of fully settled accounting. No new production
shutdown/global timeout or provider lifecycle is introduced by this decision.
