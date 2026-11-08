---
status: accepted
date: 2026-10-25
area: [backend]
supersedes: []
superseded-by: null
---

# A thread may split an Inbox source into several proposal cards through a module action

## Context

In an item thread the user can say "split this into several items". One Inbox source then needs
several Processing proposals cards. The relation `Processing proposals.sourceInbox` is already
many-to-many, but the Inbox tick (`findExistingProposal` in
`backend/packages/data/src/inbox/inboxTickAction.ts`) works with the first live card of a source
only.

[[2026-09-23-processing-proposals-card-creation-owned-per-kind]] makes `semprec.tick` the only
producer of `kind: inbox` cards and says a new producer or a new place of production is a new
decision. It is superseded by [[2026-09-23-speaker-mappings-are-edges-proposed-on-transcript-cards]],
which keeps that rule for `kind: inbox`. [[2026-09-10-agent-writes-are-proposals-not-direct-writes]]
adds that an agent never writes to a target database directly. This ADR decides who may create
the extra cards and how the tick treats them. The implementation is issue #1939.

## Decision

### Producer

- **The thread's agent tool does not create cards itself.** It calls an Inbox-module proposal
  action, `splitInboxSourceWithClient`, in the module that owns Processing proposals, in a
  user-context request on behalf of the thread. The write goes through the choke point inside
  the module's transaction, and every created card is a proposal, never a write to a target
  database.
- **This is a narrow, named exception** to "`semprec.tick` is the only producer of `kind: inbox`
  cards": the one additional producer is `splitInboxSourceWithClient`, and only for sibling cards
  of an existing primary card. The earlier ADRs are not edited or superseded; the tick stays the
  only producer of a source's primary card, and any other producer is still a new decision.

### Primary card and siblings

- The first card of a split stays the source's **primary card** and is the only one the tick
  recomputes. Its fingerprint keeps following the source.
- Every other card is a **sibling** and carries the system property `splitFromProposalId`, the
  primary card's id. `findExistingProposal` and the tick ignore any card with it set.
- A sibling is recomputed only on an explicit request (the recompute route or a thread
  revision), never by a source edit.
- Confirm, reject and the other card actions work per card.

### Limits

- At most one split action per primary card is in flight: the action row-locks the primary card
  (`FOR UPDATE`) for the whole transaction.
- A split is refused when the primary card is `confirmed` or `rejected`.
- A split yields at most **10** cards in total: the primary card plus at most 9 siblings.
- Every sibling is a normal proposal and passes the same envelope validation as any card.

## Alternatives rejected

- **The tick as the only producer, with the instruction persisted on a request card.** The split
  instruction exists only in the thread and the tick sees only the source. Persisting it on a
  card would add a new card shape, create the siblings asynchronously, and let the user see an
  edited primary card but no siblings for a while.
- **One card holding several steps.** The card envelope and the confirm flow handle one result
  per card; several steps in one card would prevent confirming or rejecting each part
  separately.

## Consequences

- The Inbox module gets a second producer path, `splitInboxSourceWithClient`, which a synchronous
  user-context request returns with all cards in one transaction and one realtime update.
- Processing proposals gets the system property `splitFromProposalId`, and the tick gains a
  filter that ignores siblings.
- Implementers must keep the limits above; code that creates `kind: inbox` cards anywhere else
  still needs its own decision.
