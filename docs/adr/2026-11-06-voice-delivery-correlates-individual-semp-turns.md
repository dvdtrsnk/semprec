---
status: accepted
date: 2026-11-06
area: [backend]
supersedes: []
superseded-by: null
---

# Correlate voice delivery to an individual Semp assistant message

## Context

[[2026-11-06-voice-turns-share-authorized-run-watch-delivery]] reuses authorized run delivery for gh1734. SempConversation reuses an agent run across successive queued messages. Durable events and ephemeral deltas travel independently; observing another user_message or polling the previous assistant's completion cannot retroactively fence a next turn's already delivered delta. Run identity alone is therefore insufficient for voice answer correlation.

This decision extends internal notification metadata and existing read predicates. It preserves run reuse, queue ordering, tenant ownership and the public socket protocol. It adds no persisted turn marker, table, lock, liveness claim or grant.

## Immutable live correlation

The trusted Semp worker already passes its actual assistant message id as SempConversation.sendOptions.messageId. Capture this primitive once for each cold or continuing send, before awaits, and pass it as an optional final parameter to runAgentTurn. That invocation passes the same captured id to pushLiveDelta/publishAgentRunDelta. Do not read a mutable currentSempMessage pointer when publishing a late delta, derive identity from model text/context, or change generic invocation/delegation callers. Omitted identity retains their existing behavior.

The internal AgentStreamMessage gains optional sempMessageId, validated as a UUID by the publisher and boundary parser. It is an outer trusted argument, never copied from the delta body. Include it on every large-payload chunk and count its bytes in the existing NOTIFY cap. Invalid supplied metadata fails before publication; malformed received metadata is dropped. Untagged older messages remain valid for ordinary watchers. Keep deltaFrame's existing public agent:delta representation unchanged, without exposing a new field to socket clients.

VoiceRunWatchInput carries the trusted threadId and sempMessageId returned by the actual enqueue path, as well as runId/tenant/user. Existing run actor authorization remains mandatory; verify that the current tenant's actual assistant row binds that thread, message and run before admitting the callback. A run cannot be selected by model arguments or an unrelated client id. Filter live notifications by tenant, run AND exact sempMessageId before buffering, chunk assembly or emitting speech. Missing/mismatched tags never reach voice. They are not inferred from the current watcher, run status or notification order. This is best-effort live delivery: missing deltas may be recovered as durable message content, not guaranteed streaming across old untagged writers or a disconnected listener.

## Durable boundaries in the read statement

Extend only the existing data-owner listAgentRunEventsAfter with an optional fifth scope argument {threadId,sempMessageId}, and getAgentRunEventById with an optional fourth argument of that shape. Validate supplied UUIDs. Defaults preserve current generic/socket behavior and exports. No new public runtime export or generic query port is needed.

A scoped call uses one parameterized SQL statement joining the event to the actual assistant row by equal tenant and agent_run_id, exact message id, exact thread id and role assistant. Read only ids at or after its nonnull event_from_id. While that row is running, its end may remain open; for done/error require a nonnull event_to_id and include only ids at or before it. Queued, missing, wrong-thread/run/tenant and malformed/unavailable boundaries yield no events or the existing uniform unavailable subscription outcome. A completed/error row with no end is not an unbounded interval. Keep cursor and exact-event predicates, ascending order and the existing voice MAX+1 SQL row limit.

The row interval and events must be evaluated in the SAME SQL snapshot, not an end read followed by a run-only query or filtering already emitted events. Existing Semp completion commits the end before the next queued turn can start. Consequently a statement observing an open running interval cannot simultaneously observe a subsequent turn committed after that completion; a later statement sees the closed boundary. This is a guarantee for the existing Semp queue/write owners, not arbitrary database writers or a new cross-statement snapshot/isolation contract.

Use these scoped owner reads for initial replay, queued thin references and live durable event fetches delivered to voice. Ordinary socket watchers continue their generic reads. Preserve authorization, register-before-query, replay/live deduplication, bounded overflow rejection before delivery, cancellation and replacement/disposal behavior. A live thin reference is not itself proof that an event belongs to this assistant. Exact live delta tagging and statement-scoped durable boundaries are both required.

The voice handler continues using actual assistant done/error plus its correlated final event for whole-message settlement. An intermediate pi turn_end is not completion. Reset accumulated deltas per durable assistant message and never use text-prefix coincidence to determine turn ownership. Barge-in suppresses the interrupted answer's remaining audio without changing turn or queue identity.

## Evidence and limits

Existing lifecycleAdapter.test.ts and sempConversation.test.ts cover tagged cold/continued sends and immutable per-invocation identity despite later pointer changes, plus untagged generic behavior. Existing agentRunEventsStore.test.ts uses real runtime-role writes/reads to distinguish two successive assistant ranges on one run, exact cursor/end boundaries, missing terminal end, wrong thread/run/tenant, default generic reads and SQL-limited overflow. State-only fixtures are not model-execution proof.

Existing realtime syncServer.test.ts exercises actual publisher/parser/LISTEN and authorized callbacks: delayed previous durable delivery versus a next turn's live delta, next durable commits before a delayed replay query, wrong/missing tags, chunk tags/cap, unchanged ordinary socket frames, disposal and owner/foreign/random refusals. A bounded strictly delegating query observer may hold an actual read before executing its unchanged SQL to force the schedule; no owner/registry/result mock. Observe both relevant orderings and full settlement. API voice tests and the already granted actual worker fixture establish composed behavior if the model path reaches it; do not manufacture answers or grants to pass it.

No accepted ADR body, public socket schema, generic run reuse, lifecycle persistence payload or provider attribution contract is changed. Known model-path failures remain separate and unresolved. This decision is not a diagnostic retry, independent review, successful verify, acceptance, production clearance or claim that all live deltas are delivered.
