---
status: accepted
date: 2026-09-12
area: [backend]
supersedes: []
superseded-by: null
---

# Per-process agent-run watch registry

## Context

Issue #163 adds watched agent runs to `WS /api/sync`. This is intentionally
different from the ordinary realtime invalidations recorded in
[[2026-09-12-thin-user-scoped-realtime-invalidations]]. An invalidation tells a
client to refetch current REST-readable state and is safely disposable on a
reconnect. `agent_run_events` is instead an ordered, durable event log: a
watcher needs every event after its cursor to reconstruct a run's progress, and
there is no equivalent REST refetch that supplies that cursor-relative stream.

The same run has two materially different kinds of traffic. Completed
turn-level events are durable rows and can be recovered by cursor replay;
`message_update` typing deltas are transient animation data. Sending both over
the normal channel would either make the shared durable channel carry large
inline payloads or assign recovery obligations to token deltas that it cannot
meet.

Agent runs are single-tenant today. `agent_runs` has no owner column, so the
setup account returned by `getEarliestUserId` is the one authorized human owner
for a watch. This is a deliberate authorization boundary for this registry,
not an assumption that every authenticated socket may observe a run.

Finally, replay and live delivery overlap. A notification may arrive after the
watch is registered but before its cursor query has returned; registering only
after replay loses that event, while delivering it immediately can invert it
ahead of an earlier replay row.

## Decision

- `createAgentRunWatchRegistry` owns per-process, per-socket/per-run watch
  state. `agent:watch` first authorizes the setup-account owner and registers a
  replaying watcher before querying `agent_run_events` after the requested
  cursor. `agent:unwatch`, socket close, or a newer watch cancels an in-flight
  authorization intent so an older asynchronous watch cannot re-register it.
- Durable `agent_run_events` notifications remain thin `{ agentRunId, eventId
  }` references on `semprec_events`. The registry fetches the exact durable row
  by both identifiers before emitting an `agent:event` frame. Replaying
  watchers collect received event IDs, replay durable rows in ascending ID
  order, then repeatedly drain the collected IDs in that order before becoming
  live. This closes the replay/live handoff gap without a process-wide replay
  buffer.
- `message_update` is published only on `semprec_agent_stream` and forwarded
  as `agent:delta` only to authorized watchers whose replay is complete. It is
  neither persisted nor queued for replay; the completed durable `message`
  event is its recovery copy.
- The two Postgres channels remain separate: `semprec_events` carries only
  small durable references, while `semprec_agent_stream` carries bounded,
  chunked ephemeral delta payloads. They must not be merged merely because both
  ultimately fan out through the same WebSocket server.

## Consequences

- A reconnecting watcher supplies its last event ID and receives every durable
  event after it in order. It may miss typing animation while disconnected, but
  it will receive the completed message that makes the run state recoverable.
- A watcher never receives events or deltas until its run has passed the
  single-owner authorization check. Unknown and unauthorized runs remain
  indistinguishable to the socket.
- Registry state is process-local and discarded on disconnect or process
  restart. The durable event table, not an in-memory queue, is the source of
  truth for replay; queued IDs exist only for the short in-process handoff
  window.
- The ordinary realtime invalidation policy remains unchanged: its no-replay
  rule still applies to REST-refetchable invalidations and notifications, not
  to this ordered agent-run event log.
