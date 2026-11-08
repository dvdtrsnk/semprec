---
status: accepted
date: 2026-09-17
area: [backend]
supersedes: []
superseded-by: null
---

# Graceful shutdown: drain before heartbeat stop, heartbeat stop before pool end

## Context

`semprec-ai-gateway` had no shutdown path: `serve.ts` registered no `SIGTERM`/`SIGINT`
handler, so an ordinary deploy or `systemctl restart` killed the process where it stood.
`withTokenAccounting` in `@semprec/ai-gateway` budget-checks, awaits the provider call, then
writes the `ai_gateway_calls` row that `getGatewaySpend` reads back to enforce the daily and
monthly caps. A process killed between the provider returning and that `INSERT` loses a call
that was already paid for, silently under-counting spend against the cap on every restart.

This is the repository's first process to install a signal handler; no ADR and no rule in
`backend/review-rules/` covered process lifecycle before this one.

## Decision

`backend/services/semprec-ai-gateway/src/shutdown.ts` exports `createGracefulShutdown`, which
runs these steps in this fixed order on `SIGTERM` or `SIGINT`:

1. `server.close()` to stop accepting new connections.
2. Poll `server.closeIdleConnections()` every `DRAIN_POLL_INTERVAL_MS` until the `close()`
   callback fires or `SHUTDOWN_DRAIN_TIMEOUT_MS` (60 s, matching the caller's own
   `REQUEST_TIMEOUT_MS` in `httpAiGatewayClient.ts`) elapses, whichever comes first. The caller
   uses keep-alive `fetch`, so a socket whose response just completed becomes an idle connection
   that a single `close()`/`closeIdleConnections()` pair does not revisit; only the poll collapses
   the drain to the in-flight request's own duration instead of the keep-alive timeout.
3. On the timeout path only, `server.closeAllConnections()` so a request still hanging on a slow
   provider cannot hold the process open.
4. Stop the process heartbeat (`heartbeat.stop()`) — **after** the drain, not before it.
5. `await pool.end()`, bounded by `POOL_END_TIMEOUT_MS` (5 s) against a hung or unreachable
   database, since nothing in this repository sets `statement_timeout` or `connectionTimeoutMillis`
   and an unbounded `pool.end()` would otherwise leave `registerShutdownSignals` never reaching
   `process.exit(0)`, so systemd escalates to `SIGKILL` and reintroduces the failure this shutdown
   exists to prevent.

The heartbeat stops immediately before the pool ends rather than immediately when shutdown
begins. During the drain the process is genuinely alive and still serving; stopping the
heartbeat at step 1 would let its `process_heartbeats` row go stale while `checkProcessHeartbeats`
still expects it to beat, since `PROCESS_HEARTBEAT_STALE_AFTER_MS` (60 s) is the same order as
the drain's own bound. Stopping it late still cancels every future tick before the pool ends; it
does not cancel a tick already in flight, which is why `pool.end()` carries its own timeout
rather than assuming the heartbeat is fully quiesced.

`shutdown()` is idempotent (repeated calls return the same in-flight promise) and never rejects:
a teardown step that throws, including a `pool.end()` that rejects after its own bound already
won the race, is logged via `logger.error` and resolved past rather than surfaced as an
unhandled rejection — a shutdown path that throws is a shutdown path that hangs the unit.
`registerShutdownSignals` registers both signals with `on`, not `once`, so a repeated signal
during a long drain does not fall through to Node's default (immediately fatal) action.

### Rejected alternative: a shared shutdown helper in `@semprec/shared`

A shutdown helper shared with `semprec-api` and `semprec-agents` was rejected. Those two
services' own shutdown work (tracked separately) specifies an ordering built around their
graphile-worker queue runners, and that ordering names no heartbeat step — though `semprec-api`
does start a heartbeat and discard its handle exactly as this service did before this change.
Unifying the two before either has more than one real caller would be generality ahead of a
second concrete case; a shared helper can be extracted later if the orderings turn out to
coincide once both exist.

## Consequences

- An in-flight `/internal/complete` request whose provider call already returned survives an
  ordinary restart with its `ai_gateway_calls` row intact, closing the budget-undercount window.
- A future process type that needs its own signal handling makes its own ordering decision,
  informed by this one, rather than inheriting a shared helper whose steps may not fit it.
- `semprec-ai-gateway`'s shutdown can still be killed by `SIGKILL` if `pool.end()` and its own
  5 s bound both hang past systemd's `DefaultTimeoutStopSec` (90 s) — considered acceptable
  since that combination requires the database bound itself to be unreachable for that entire
  window.
