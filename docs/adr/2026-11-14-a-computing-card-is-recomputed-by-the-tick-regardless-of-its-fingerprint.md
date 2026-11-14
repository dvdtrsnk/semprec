---
status: accepted
date: 2026-11-14
area: [backend]
supersedes: []
superseded-by: null
---

# A computing card is recomputed by the tick regardless of its fingerprint

## Context

The Inbox tick stops early when the fingerprint stored on a Processing proposals card still matches the source: the
emoji, the text, the attachments and the type have not changed, so a second model call would answer the same question.
A user choice that does not change the fingerprint, such as choosing again the type the item already has or any later
"compute again" request, still wants a new computation. Gh-1947 adds the first writer of that request,
`PUT /api/inbox/items/:id/type`; a route that recomputes without changing the type is announced for a later issue.
Without a recorded contract that route, or a change of the gate, would have to infer it from code comments.

The route is also a new writer of the Inbox `type` edge. [[2026-11-09-inbox-type-edges-reserve-current-cards-without-waiting]]
fixes the order source, then cards for the writers that coordinate with a decided card, and
[[2026-11-01-inbox-fingerprint-inputs-locked-through-proposal-write]] makes the tick's write phase hold the source, then
the item's type, through the card write.

## Decision

The status `computing` on a Processing proposals card means "the user asked for a new computation". Only a writer that
acts on a user request sets it, in the same transaction that queues the tick for the item
(`triggerOnItemEventHeartbeats`), so the request and the tick that serves it commit together. The writer does not compute
the proposal and does not touch `proposal` or `aiProposal`.

The tick's read phase (`readTickSnapshot`) skips the fingerprint gate for a card whose status is `computing`, and for no
other status; a `confirmed` or `rejected` card still ends the tick before the gate. The tick's write phase then stores
the new proposal and fingerprint and leaves `computing`. The bypass costs one model call per request, which is the
point of the request.

The type-change route takes its locks in the order of the tick's write phase: the Inbox source `FOR UPDATE`, the chosen
type `FOR SHARE NOWAIT` (a busy type is a 409 instead of a wait, the way `tryLockInboxType` treats it in the tick), then
the item's cards `FOR UPDATE NOWAIT` in stable id order (`reserveInboxTypeCards`). A later writer of `computing` that
also changes the type edge takes the same order.

## Consequences

Until the tick writes its result the card stays `computing`. A computation that fails or is skipped as stale does not
yet move the card out of `computing`; recording that failure on the card is a separate issue and must be done in the
tick's write phase, not by the requesting route. The route can be called again for a `computing` card, which only sends
it back to the tick. An item without a card has nothing to mark: the queued tick creates the card.

The lock order is a convention among the writers that coordinate through the source lock; it does not claim global
deadlock freedom, and arbitrary SQL is outside it. Tests cover the busy type and the busy card as 409 and the bypass in
both directions (a `computing` card is computed at an unchanged fingerprint, a `proposed` one is not).
