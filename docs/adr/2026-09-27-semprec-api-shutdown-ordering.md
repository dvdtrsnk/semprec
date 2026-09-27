---
status: accepted
date: 2026-09-27
area: [backend]
supersedes: []
superseded-by: null
---

# semprec-api graceful shutdown: sync server first, then HTTP drain, queue stop, pool end

## Context

[[2026-09-17-shutdown-ordering-with-late-heartbeat-stop]] fixed the shutdown ordering for
`semprec-ai-gateway` and, in its rejected-alternative note, deliberately left `semprec-api`'s
ordering to be decided separately instead of extracting a shared helper. That ordering was never
recorded.

`semprec-api`'s topology differs from the gateway's in two ways that shape the ordering:

- It hosts the `WS /api/sync` endpoint (`@semprec/realtime`'s `createSyncServer`) on the same
  `http.Server` that serves the REST API. Upgraded WebSocket sockets are long-lived and never
  become idle HTTP connections, so `server.close()`'s callback does not fire while any of them is
  open, and `closeIdleConnections()` does not touch them. Each sync server also holds a dedicated
  pooled `LISTEN` client.
- It hosts a graphile-worker queue runtime in the same process, whose jobs use the same `pg` pool.

With the HTTP drain first, every connected sync client kept the drain waiting until
`SHUTDOWN_DRAIN_TIMEOUT_MS` (60 s) elapsed on every deploy, after which
`closeAllConnections()` dropped them without a close frame — so clients never learned the
disconnect was a restart.

## Decision

`backend/services/semprec-api/src/shutdown.ts`'s `createGracefulShutdown` runs these steps in this
fixed order on `SIGTERM` or `SIGINT`:

1. `syncServer.close()` — sends every `/api/sync` client close code 1012 ("Service Restart"),
   detaches and releases its `LISTEN` client, and closes the `noServer` WebSocket server. It runs
   first because until those sockets are gone, step 2 cannot settle before its bound.
2. `server.close()` plus the `closeIdleConnections()` poll, bounded by `SHUTDOWN_DRAIN_TIMEOUT_MS`,
   with `closeAllConnections()` on the timeout path only — the same drain mechanics as the
   gateway's.
3. `queueRuntime.stop()`, awaiting the runner's own stop so in-flight jobs finish. It runs after
   the HTTP drain so the queue keeps processing while in-flight requests finish, and before the
   pool ends because running jobs still need it.
4. `pool.end()`, bounded by `POOL_END_TIMEOUT_MS` (5 s), for the same reason as in the gateway's
   ADR.

A failure in any step is logged and shutdown proceeds to the next step; `shutdown()` is
idempotent and never rejects, and `registerShutdownSignals` uses `on`, not `once`, matching the
gateway's contract.

### Rejected alternative: close the sync server after the HTTP drain

Draining HTTP first would give REST requests priority, but the drain cannot complete while any
sync socket is open, so it would always run to its 60 s bound whenever a client is connected and
then hard-drop those sockets without a 1012 frame. Closing the sync server first costs nothing
for REST requests (they still drain fully in step 2) and lets clients reconnect promptly.

### Rejected alternative: reuse the gateway's helper

Still rejected for the reason [[2026-09-17-shutdown-ordering-with-late-heartbeat-stop]] gives:
the two services' steps differ (sync server and queue runtime here, heartbeat there), so a shared
helper would have to be parameterized over steps with a single caller each.

## Consequences

- A deploy no longer waits the full drain bound because a sync client is connected; connected
  clients receive 1012 and reconnect to the new process.
- A sync client that reconnects during the drain window is rejected by the closed sync server and
  retries against the next process, which is the behavior 1012 asks for.
- Any future long-lived upgraded protocol added to `semprec-api`'s `http.Server` must likewise be
  closed before the HTTP drain, or it reintroduces the drain-to-timeout behavior this ordering
  removes.
- `semprec-api` still starts a process heartbeat without stopping it on shutdown; that is outside
  this decision and unchanged by it.
