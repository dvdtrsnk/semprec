---
status: accepted
date: 2026-11-06
area: [backend]
supersedes: []
superseded-by: null
---

# Share authorized run-watch delivery with voice turns

## Context

Gh-1734 joins the existing voice channel to queued Semp turns under [[2026-10-28-live-voice-chains-speech-to-text-agent-turn-and-text-to-speech]]. The existing run watcher is WebSocket-specific, the STT client has partial/final callbacks but no VAD onset event, and the voice wire's closed error schema already spells budget exhaustion budgetExceeded. This decision provides the narrow production composition without inventing an STT protocol or feeding fake sockets to a watcher.

## Decision

Retain the existing voice wire spelling budgetExceeded; snake-case budget_exceeded remains the gateway/internal error value and is mapped at this boundary. Gh-1734's Context, Task and AC use budgetExceeded for this wire outcome after reconciliation. Existing other wire codes, authentication, limits and close behavior remain unchanged.

The supported barge-in signal is the first nonempty STT partial, or a final when no partial precedes it, received while output is playing. Abort synthesis, discard pending speech for that interrupted answer and send speaking stopped; do not cancel its agent run. This is recognition-time interruption, not exact acoustic/VAD onset, and an interval without a partial/final provides no onset observation. No gateway STT protocol, client callback or provider-VAD change is authorized.

Extend the existing realtime agentRunWatch owner with a typed callback subscription used only by voice. It reuses the same run authorization (trusted tenant plus actor user), durable cursor replay/live registration ordering and tenant-routed event/delta delivery as socket watches. Keep the WebSocket interface and wire output compatible. Expose the callback subscription through the existing SyncServer/syncHandler composition to the voice handler in serve.ts, rather than building a second LISTEN consumer, fake WebSocket, poller over deltas or global unscoped callback bus. The actual syncServer notifier remains the event source; no direct service SQL or provider transport shortcut is added.

The callback receives only its authorized run's existing typed events/deltas, with bounded pending delivery and backpressure/failure handling. It returns an idempotent disposer. Socket end/error, tenant deactivation and server shutdown dispose subscriptions and cancel pending registration/replay; no continuation after disposal may deliver speech. An authorization failure, closed sink, unavailable listener or overflow fails closed and releases the voice session's resources. A failed replacement must not silently delete a working watch. Existing socket registration/replay tests remain valid.

After enqueue, discover only that assistant message's run via a typed data-owned tenant/thread/message read, bounded by the voice session's lifecycle. Do not subscribe to an arbitrary client-selected run or identify a run from uncorrelated global notifications. If the run exists before registration, durable replay covers its completed message; ephemeral deltas remain best effort. Buffer/sentence caps prevent unbounded speech backlog. Barge-in suppresses remaining speech from the interrupted answer without changing thread queue order or approval behavior.

## Consequences and evidence

Test actual callback and socket authorization with owner/foreign/random runs, durable replay/live overlap and disposal during pending authorization. Prove actual voice composition gets a correlated run's partial answer before completion, a final-only STT barge-in control, queued next question, budget mapping and complete disconnect/deactivation cleanup. Synthetic registry identity is not an authenticated HTTP/WS proof. No new agent grant, run cancellation contract (#2019), speech attribution (#2020), VAD promise or client implementation is included.
