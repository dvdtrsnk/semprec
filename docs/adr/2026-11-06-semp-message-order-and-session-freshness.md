---
status: accepted
date: 2026-11-06
area: [backend]
supersedes: []
superseded-by: null
---

# Order Semp message inserts before checking session freshness

## Context

Migration0087 uses transaction now() for created_at and random UUIDs for message IDs. A user and its queued assistant inserted in one transaction can tie; an older transaction can also acquire a thread reservation after a newer one. Therefore neither UUID order nor transaction start time identifies a preceding turn.

Gh1727 needs ordered replies and must not reuse a session that missed an intervening stored message. This extends the existing thread reservation used by send admission and [[2026-11-06-inbox-thread-sends-reserve-current-proposals]], while retaining the tenant lane in [[2026-10-28-semp-thread-turns-run-on-a-per-tenant-chat-lane]].

## Decision

Add one internal data-owner timestamp allocator used by all three existing message inserters: HTTP user/queued-assistant pairs, approval outcome system messages, and tick-run assistant messages. In the same managed READ COMMITTED transaction, reserve the existing thread row before choosing an insertion timestamp. After acquiring it, use a fresh statement to choose the greater of clock_timestamp() and the latest existing created_at plus one microsecond. Insert with that explicit timestamp; each member of a user/assistant pair allocates in order. Keep the row reservation through commit and the existing activity/invalidation semantics.

The private allocator requires the stated managed isolation rather than pretending an earlier repeatable-read snapshot refreshes after waiting. Reject an unsupported isolation before insertion, and propagate real transaction failures; no automatic retry of model/tool work is added. Item sends still take source and nonblocking card reservations before the thread; nothing waits for a card while holding source.

This is insertion/admission order, not a claim about client wall-clock send time. Queue FIFO follows the actual serialized enqueue transaction under that reservation. No new sequence column, counter table, client clock, no-op item write or rewriting of old history is introduced. Existing historical timestamp ties keep the read endpoint's deterministic UUID tiebreak; newly coordinated inserts are strictly later than the existing maximum. All current producers must use the allocator; direct SQL fixtures do not establish production compliance.

Before each queued turn, inspect the current thread's latest stored message excluding exactly that turn's paired source message and queued/running assistant. Exclude no other system/tick or later queued message to manufacture freshness. Reuse a live entry only when this frontier identifies the assistant reply the entry actually completed, with matching relevant stored content/state, not just a timestamp. Track the cached reply only after its successful final write commits; never adopt a newly observed unrelated frontier as if the session processed it.

A mismatch, intervening system/tick message or uncertain frontier conservatively drops the idle session and uses real stored reconstruction. Later queued pairs may cause extra wakes; they do not authorize a false freshness claim. No thread lock spans the model call. This is an admission-time check: a later concurrent message is considered by the next check, not a promise that memory stays globally current during the provider call. Failed turns never mark their input as successfully cached. Existing tenant/thread keys, TTL and cancellation ownership stay intact.

Use the narrow existing conversation owner to invalidate/reuse an idle entry; do not clear other tenants or introduce another session registry. [[2026-11-06-semp-wake-replays-bounded-complete-history]] supplies the actual wake path. The reply pair remains identified by reply_to_message_id; it is not inferred from timestamps.

## Evidence

Use actual runtime-role producers and message/session owners: same-transaction pair order; older-start/later-reservation transaction; concurrent sends; system and tick inserts between turns; queued future pairs; rollback; different tenant/thread controls; actual same-session reuse when fresh and actual reconstructed wake when stale. Preserve exact database microseconds in ordering assertions. A test-side sleep or UUID ordering assumption is not evidence of this protocol.
