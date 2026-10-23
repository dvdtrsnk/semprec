---
status: accepted
date: 2026-09-28
area: [backend]
supersedes: []
superseded-by: null
---

# Client disconnect propagation in the AI gateway

## Context

[[2026-09-10-ai-gateway-monopoly-on-provider-calls]] routes every provider call
through `semprec-ai-gateway`. Its callers give up on a request after a fixed
timeout (60 s for `POST /internal/complete`, 600 s for the audio routes) and
drop the connection. Until issue #624 the gateway kept the provider call
running regardless: a pyannoteAI diarization kept polling for minutes, a
completion kept waiting for Anthropic, and the handler then wrote a response
into a socket nobody was reading. The work was paid for and thrown away, and
the in-flight call also held the shutdown drain open for as long as it ran.

The alternatives considered:

- Relying on each provider's own timeout (`AbortSignal.timeout(...)`). It
  bounds a single fetch, not the caller's patience, and a polling loop such as
  pyannoteAI's re-arms it on every attempt.
- Listening on `req`'s `close` or `aborted` event. On current Node versions a
  request's `close` fires as soon as its body has been fully read, so it would
  abort every call before the provider is reached.
- Racing the provider promise against the disconnect in the handler without
  telling the provider. It stops the handler from writing, but the provider
  request and any polling loop keep running and keep costing money.

## Decision

**Deriving the signal.** Each gateway route handler derives one
`AbortSignal` per request from its `ServerResponse`, after the body has been
read and validated and before the provider call starts:

```ts
const abort = new AbortController();
res.on("close", () => {
  if (!res.writableFinished) abort.abort();
});
if (res.destroyed) abort.abort();
```

- `close` on a `ServerResponse` fires both after a normal `end()` and on a
  premature connection loss. `writableFinished` is true only for the former,
  so gating on it keeps a completed response from aborting anything.
- The `res.destroyed` pre-check covers a connection that dropped while the
  body was being read or validated: `close` has already fired by then and
  would never reach a listener attached afterwards.

**The provider contract.** Every provider request interface
(`StructuredCompletionRequest`, `DiarizationRequest`, `TranscriptionRequest`)
carries an optional `signal`. A provider passes it to every outbound `fetch`
— combined with its own per-request timeout via `AbortSignal.any` where it has
one — and checks `signal.aborted` between steps it controls itself, such as
each iteration of a polling loop. It stays optional so that direct callers and
tests without an HTTP response do not need one.

**The error path.** When the provider call rejects, the handler checks
`signal.aborted` before any other error mapping. If it is set, the failure is
the client's disconnect, not a provider or budget failure: the handler logs it
at `info` with provider, model and path, and returns without writing any HTTP
response, because there is no socket left to answer on. It does not map the
error to a status code and does not log it as a provider error.

**The reservation.** A disconnected call's `ai_gateway_calls` row follows the
ordinary fail transition of
[[2026-09-27-ai-budget-reservations-under-a-global-advisory-lock]]: the gateway
function (`complete()`, `diarize()`, `transcribe()`) sees the provider reject
and moves the row `reserved → failed`. The handler does not roll it back or
delete it — the row stays as the record that the call was attempted and
abandoned.

## Consequences

- A caller that gives up stops the paid provider work within one fetch or one
  poll interval, and a shutdown drain no longer waits on work whose caller is
  already gone.
- Every new gateway route must repeat the same four parts: derive the signal
  from `res` with the `writableFinished` gate and the `res.destroyed`
  pre-check, pass it into the provider request, have the provider honour it,
  and check `signal.aborted` first in its error handler. A route that skips
  any of them silently reintroduces the wasted call or writes to a dead
  socket.
- A disconnected call is recorded as `failed` at `cost_usd = 0`, even if the
  provider already billed part of the work before the abort reached it. The
  budget undercounts by that partial amount; this is the same trade-off every
  other failed provider call already makes.
- Disconnects are logged at `info`, not `error`: a caller timing out is an
  expected event on the audio routes and must not page anyone.
