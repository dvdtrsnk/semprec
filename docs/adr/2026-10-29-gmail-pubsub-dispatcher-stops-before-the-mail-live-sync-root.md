---
status: accepted
date: 2026-10-29
area: [backend]
supersedes: []
superseded-by: null
---

# semprec-api shutdown: the Gmail Pub/Sub dispatcher stops after the HTTP drain and before the mail live-sync root

## Context

[[2026-09-27-semprec-api-shutdown-ordering]] fixed the step order of `createGracefulShutdown`
(`backend/services/semprec-api/src/shutdown.ts`): sync server close, HTTP drain, queue runtime
stop, pool end. Two steps joined that order later without changing the record: the mail live-sync
root stops between the drain and the queue runtime (issue #650 — a hosted lifecycle's `start()`
enqueues a `mailAccountSync` job, so the root stops before the runner that would run it), and the
tenant deactivation listener closes first
([[2026-10-17-tenant-deactivation-tears-down-in-process-state]]). The sequence on the integration
tip is: listener close, sync server close, HTTP drain, mail live-sync root stop, queue runtime
stop, pool end.

Issue #1739 hosts the Gmail watch lifecycles and starts one `createGmailPubSubDispatcher`
(`backend/packages/data/src/mail/gmailWatchLifecycle.ts`) per process. The dispatcher is a
long-lived loop outside the `http.Server`: it pulls the deployment's shared Pub/Sub subscription
over outbound `fetch` (`mail/gmailPubSubClient.ts`), routes each notification's address through
the router function `route_gmail_address` in its own transaction
([[2026-10-07-cross-tenant-router-functions]]), hands the notification off with
`enqueueMailAccountSync` inside each target tenant, and acknowledges it only once every target was
handed off. It uses the pool and the queue, so it needs a place in the fixed order. The accepted
ADR's body is never edited (`docs/adr/README.md`, `review-rules/rules.md`), so this record narrows
it by adding one step.

## Decision

`createGracefulShutdown` takes the dispatcher as an optional option and stops it as one ordered
step: **after the HTTP drain and immediately before `mailLiveSync.stop()`**. The resulting order
is:

1. tenant deactivation listener close (bounded by `LISTENER_CLOSE_TIMEOUT_MS`)
2. `syncServer.close()`
3. HTTP drain (bounded by `SHUTDOWN_DRAIN_TIMEOUT_MS`)
4. `gmailPubSubDispatcher.stop()` — skipped when the process started no dispatcher
5. `mailLiveSync.stop()`
6. `queueRuntime.stop()`
7. `pool.end()` (bounded by `POOL_END_TIMEOUT_MS`)

- **After the drain.** The dispatcher is not an upgraded protocol on the `http.Server`, so it does
  not hold the drain open; the 2026-09-27 consequence for sync sockets does not apply to it. Its
  only effect is a durable, idempotent enqueue (one `jobKey` per mailbox), so pulling during the
  drain costs nothing and keeps push latency until the process stops serving. Stopping it earlier
  would only make every shutdown wait for an in-flight pull before the drain starts.
- **Before the mail live-sync root.** The dispatcher's hand-off is an enqueue and its routing is a
  pool transaction, so it precedes the queue runtime and the pool for the same reason the root
  does. It also precedes the root because the root's stop takes down the Gmail watch lifecycles
  the notifications belong to: intake stops before hosting, hosting before the runner, the runner
  before the pool.
- **What stop means.** `stop()` sets the dispatcher's stopped flag, releases the backoff wait and
  awaits the loop. After that the loop starts no pull and dispatches no further notification: a
  pull in flight returns at the latest at the transport's 30 s request timeout and its
  notifications are left unacknowledged; a dispatch in flight finishes its one notification's
  routing and enqueues. Every notification not acknowledged is redelivered by Pub/Sub after its
  acknowledgement deadline, and a redelivery for a mailbox already enqueued is absorbed by the job
  key. The process never acknowledges a notification it has not handed off.
- **No extra bound.** Unlike the listener's close, the step can only wait on one outbound request
  (bounded by the transport's 30 s request timeout) or one notification's database work (each
  statement bounded by the pool's `statement_timeout`, `STATEMENT_TIMEOUT_MS` in
  `backend/packages/data/src/db/pool.ts`), the same exposure `mailLiveSync.stop()` and
  `queueRuntime.stop()` already have. `shutdown.ts` adds no timer of its own for it.
- **Test.** `backend/services/semprec-api/src/__tests__/shutdown.test.ts` asserts that the
  dispatcher's stop is awaited before `mailLiveSync.stop()` and before the pool ends, and that a
  pulled but undispatched notification is not acknowledged.

### Rejected alternative: stop the dispatcher first, before the HTTP drain

It buys nothing — the dispatcher holds no inbound connection — and makes the drain wait for an
in-flight pull on every shutdown.

### Rejected alternative: stop it after the mail root, or together with the queue runtime

An enqueue could then race the runner's stop, which is exactly why the root already precedes the
runner.

### Rejected alternative: request the stop before the drain and await it after

It would overlap one pull's wait with the drain, saving at most the request timeout. The drain is
bounded at 60 s and the root's and runner's stops are unbounded, so a two-phase step is not worth
its own contract.

## Consequences

- `CreateGracefulShutdownOptions` gains an optional dispatcher handle; `serve.ts` passes the
  dispatcher it started, or nothing when the Pub/Sub configuration or the Gmail OAuth client is
  missing and the process runs without one.
- A shutdown can take up to one pull's wait (the transport's 30 s request timeout) longer than
  before when a pull is in flight.
- A Microsoft Graph subscription lifecycle (#1745) adds no step: it is hosted by the mail
  live-sync root and stops with it. A future long-lived outbound loop that enqueues work takes the
  same position — after the drain, before the components whose stop it would otherwise race.
- `docs/adr/2026-09-27-semprec-api-shutdown-ordering.md` stays as written; its step list is read
  together with this record and the listener step of
  [[2026-10-17-tenant-deactivation-tears-down-in-process-state]].
