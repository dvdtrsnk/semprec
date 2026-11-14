---
status: accepted
date: 2026-11-14
area: [backend]
supersedes: []
superseded-by: null
---

# A regenerated Semp reply is hidden from the model by the event range of its turn

## Context

A user can ask Semp for a reply again from the latest finished answer (issue gh-1930). The conversation of a thread is rebuilt for a wake from `agent_run_events` by `walkStoredEntries`, and a live session in the `SempConversation` registry holds the same history in memory ([[2026-11-06-semp-wake-replays-bounded-complete-history]], [[2026-11-06-semp-message-order-and-session-freshness]]). A replaced answer that stayed in either would be shown to the model on every later turn. Deleting the events is not possible: the answer stays readable in the stored messages with its steps, and event rows are shared by the other turns of the same run, which one wake run holds for many turns. A retry of a failed reply (issue gh-1926) is a different case: its failed attempt stays in the history on purpose, because its tool results tell the agent which changes were made.

## Decision

Regeneration replaces, it does not keep versions. `regenerateSempReply` runs in one transaction under the row lock of the thread, which every insert of a message of the thread takes, and under the row lock of the message. Under them it checks, in this order, that the message is the latest message of the thread and a `done` assistant message that answers a message and has a run and an event range (`regenerate_not_latest`); that its stored `changes` are an empty list, no stored step carries an approval request and no approval request of its run belongs to a tool call of the reply (`regenerate_after_writes`); and that no `compaction` event of the thread's conversation has an id above its `event_to_id` (`regenerate_after_compaction`). A reply stored without `changes` (before issue #1885) is not known to have made none and is refused as a write. An approval request stored without a tool call id belongs to no reply, as in the reply-scoped run detail. It then inserts the next attempt in the initial status, sets `replaced_by_message_id` of the old message to it and enqueues the turn, all in that transaction.

A replaced reply is hidden from the model by its run and event range, never by deleting rows. The reader of a thread's conversation (`listSessionAgentRunEventsFromLastCompaction`) leaves out every event whose run is the `agent_run_id` of a message with `replaced_by_message_id` set and whose id lies from its `event_from_id` through its `event_to_id`. The range is the whole turn, so the reader returns a turn whole or not at all; a range that cut a tool call from its result would still fail the protocol check that both reconstructions run, and would not reach the model as half a call. The events are left out before the replay bounds are applied, so a replaced answer counts toward no bound. A failed attempt that a retry followed has no replacement and stays in the history.

A live session that holds the replaced answer is not dropped by a call into the process that owns it: the API process has no access to that registry. The turn handler drops it through the freshness check of the second ADR above. The replaced message is the latest message the new turn sees besides its own source and reply, its token (`getSempMessageToken`) includes `replacedBy`, and `SempConversation.ensureFresh` finds a session that cached the earlier token stale and pauses it, so the turn wakes a new session from the reconstructed history. The same check is why the drop happens when the turn runs and not when the route answers.

## Consequences

- The replaced answer, its steps and its range of events stay stored and readable by message; only a thread's conversation reader skips the range. A reader that scopes events by message range is unaffected.
- The unique index `semp_messages_reply_attempt_uq` of issue gh-1926 and the thread lock make a second regeneration of the same reply fail as `regenerate_not_latest`, because the new attempt is by then the latest message.
- A regeneration is refused once a checkpoint follows the reply, because a checkpoint payload already holds the answer and cannot be edited. A checkpoint written after a regeneration was built from the reconstruction, which left the replaced range out.
- A new reader of a thread's conversation that does not use `listSessionAgentRunEventsFromLastCompaction` must apply the same skip.

## Evidence

The data package proves each check and their order, the whole-turn skip of the reader with and without bounds, and the tenant foreign key; the agent runtime proves the reconstructed entries and the failure of a cut range; the agents service proves, through the real turn handler, that the next turn's model input lacks the replaced answer, that the cached session is dropped, and that a thread with no replacement keeps it; the API proves the route, the codes, concurrency under a held thread lock and tenant isolation.
