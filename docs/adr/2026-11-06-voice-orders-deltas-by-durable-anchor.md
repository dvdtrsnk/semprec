---
status: accepted
date: 2026-11-06
area: [backend]
supersedes: []
superseded-by: null
---

# Order bounded voice deltas by their durable event anchor

## Context

[[2026-11-06-voice-delivery-correlates-individual-semp-turns]] prevents cross-Semp-turn delivery but multiple model messages/tool cycles share one Semp assistant id. A later message's delta may overtake an earlier durable message fetch. [[2026-11-06-voice-speech-bounds-pending-text-per-request]] requires a contiguous streamed prefix for deduplication; silently ignoring a chunk and then consuming later text breaks that premise.

The existing publisher serializes one delta to UTF-8 JSON, base64-encodes the whole value, and slices that encoded string into 7000-character fragments. Those are not independently parseable JSON values. This decision adds internal ordering metadata and a bounded voice-only decoder/drain, without a new public socket protocol, persisted event kind, table, lock, provider or retry mechanism.

## Producer metadata

Within each runAgentTurn invocation, retain the id of the last event actually persisted through recordPersistentEvent. Advance it after that insert resolves; reset a deltaSequence counter to zero on each such advance. Every logical message_update publication increments that counter, including non-text updates and failed publication attempts. A Semp-tagged delta carries the immutable sempMessageId plus afterEventId (that preceding durable id) and positive safe-integer deltaSequence. All fragments of one logical delta carry the same pair and identity.

Extend the existing optional publisher arguments internally, not the delta body. Validate a supplied Semp tag/anchor/ordinal before SQL: UUID, canonical positive PostgreSQL-bigint event id and positive safe integer respectively. Do not mint anchor 0 or infer one from a notification. Actual Semp turns persist their first user event before model prompting; a malformed Semp stream with no persisted anchor cannot publish attributed voice deltas. Preserve generic untagged publishing and current best-effort failure observation. Receiver parsing may accept historical unanchored envelopes for ordinary sockets, but voice never speaks their unorderable live content. Malformed supplied metadata fails closed. Existing deltaFrame still emits exactly the old public agent:delta fields/chunks.

## Serialized voice delivery

Keep tenant/actor/thread/run/assistant authorization and same-statement row boundaries. All voice replay, live durable references and live deltas enter one bounded, observed drain owned by agentRunWatch; forwardDelta no longer directly calls the voice sink while a durable read is pending. Queue live traffic during registration/replay too, within the same limits. Ordinary socket delivery remains unchanged.

Before a pending delta can speak, deliver the scoped durable events up to its afterEventId in ascending order. Extend only listAgentRunEventsAfter's existing voice scope with optional throughEventId, validated as a canonical bigint id and applied as an additional SQL upper bound alongside the assistant interval, cursor and 257-row limit. All voice durable catch-up uses that ordered owner read, rather than jumping past earlier events by emitting a single later thin reference. No data-to-realtime import or generic query port is introduced. A delta anchor which cannot be resolved inside the authorized assistant interval is unavailable; a thin reference from another turn is simply excluded by the existing interval.

Once the durable watermark equals an anchor, emit only its contiguous logical deltas starting at ordinal 1. Deliver all already queued contiguous deltas there before advancing past that anchor. A durable message resets the existing text-prefix state before a later model-cycle delta can be emitted. If a durable event advances beyond an old anchor, discard that anchor's residual live state; later stale deltas/chunks cannot repeat its recovered text. This order does not rely on notification-channel arrival order. Events for later Semp turns remain excluded by id/tenant filters and scoped SQL.

A missing ordinal, a first observed ordinal above 1, a well-formed out-of-order/interleaved chunk sequence, or an incomplete/gated-live deadline switches that anchor to durable-only recovery. Discard its incomplete live state and suppress all later live deltas there, even if missing pieces arrive late. Preserve only the already emitted contiguous prefix. The actual correlated durable message then feeds the unspoken suffix through existing hash/length comparison and speech bounds. Do not stitch across a hole, restart live emission for a recovered anchor, replay the whole answer, request retransmission or call the model again. A durable message may supersede an incomplete assembly immediately. Missing ephemeral data can therefore delay speech until durable content; this is best effort, not an unconditional first-sentence streaming guarantee.

## Chunk and retained-state bounds

The new internal realtime voiceRunDeltaBuffer.ts is a pure voice-specific buffer/codec, not a public barrel export or data port. It has no runtime Postgres import. Types may be imported type-only; actual authorization, SQL, timers and lifecycle stay with agentRunWatch. Its unit test is voiceRunDeltaBuffer.unit.test.ts.

After exact tenant/run/Semp filtering, retain at most one chunk assembly at a time. Require a UUID chunk id, safe integer index/total, total 1..50, index 0..total-1, encoding base64json, fragments at most 7000 encoded ASCII bytes, and consistent identity/anchor/ordinal/id/total/encoding. Retain at most 349528 encoded characters for one value and decode at most 262144 UTF-8 JSON bytes. Concatenate the fragments in the admitted sequence before decoding; validate canonical base64 by bounded decode/re-encode equality, and use fatal UTF-8 decoding followed by JSON.parse into unknown. Do not use an unbounded nested-repeat regex or decode fragments separately.

An identical duplicate fragment can be ignored; conflicting duplicate content/metadata or malformed base64/UTF-8/JSON is unavailable. A sequence/index gap or well-formed competing logical sequence is a loss/reordering observation: recover that anchor durably rather than produce partial text. Ignore duplicates of already consumed ordinals and stale anchors. Bound metadata before allocating an array from total. No partial chunk value reaches the voice handler. A complete value is delivered as one normal, unchunked AgentStreamMessage after the ordering gate; handler text narrowing remains in force.

Retain at most 256 pending logical deltas and 512 KiB total pending encoded/serialized content per voice watch, including an active assembly; existing 256 pending durable-id and SQL replay limits remain. These are retained-content bounds, not an exact JavaScript heap limit. Bounded decode/JSON parsing can temporarily allocate their capped output. A limit violation uses overloaded, not a truncated success. A 5-second absolute deadline starts with the oldest incomplete assembly or gated live value and is not extended by more fragments. Check expiry before admitting/releasing data as well as in the timer callback; expired live state recovers durably. Expiry does not abandon a database query or imply it settled. Reuse one bounded deadline/timer per watch; no unbounded per-id timer/history registry.

The existing onFailure callback may receive a second optional closed wire-cause argument overloaded or unavailable, default unavailable, while preserving the original error. This avoids string matching or a new public error-class catalog. The API voice owner maps it through the existing channel failure/cleanup path. Disposal/deactivation/abort clears timers and retained state, forbids late sink calls and observes owned drain/query settlement through existing lifecycle handling; no Promise.race abandonment or silent cleanup failure.

## Evidence and limits

Pure buffer tests cover codec roundtrip with non-ASCII/split bytes, exact/over byte/chunk/count limits, canonical-invalid encodings, duplicate/conflict, out-of-order/interleaving, ordinal gap recovery, stale/late suppression, reset and disposal. Controlled timestamps are labeled state-machine evidence, not real deadline/IO proof.

Existing lifecycle/Semp tests cover persisted anchors and per-anchor ordinals, generic unchanged publishing and chunk metadata/cap. Existing data tests prove through-event SQL boundaries alongside exact assistant interval, cursor/order, overflow and tenant controls. Existing syncServer tests exercise actual publisher/parser/LISTEN and delayed reads in both directions: next model-cycle delta before prior durable completion; durable catch-up superseding a partial chunk; gap then later text with durable suffix recovery; disposal during a held read; unchanged ordinary socket frames. Use only bounded strictly delegating query barriers, never mocked owners/results. A newly named 5-second expiry integration case may have a finite 15-second test budget; do not change existing timeouts or global settings to pass it.

API voice/text component cases stay distinct from the actual model path, which remains failed/unexplained where previously observed. No new model diagnostic, fake answer/session, provider call, review/final-gate retry or acceptance is authorized. Existing source Tasks/AC and all other buffer/lifecycle restrictions remain.
