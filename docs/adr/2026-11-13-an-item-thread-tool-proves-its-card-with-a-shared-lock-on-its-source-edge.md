---
status: accepted
date: 2026-11-13
area: [backend]
supersedes: []
superseded-by: null
---

# An item thread tool proves its card with a shared lock on the card's source edge

## Context

An agent tool of an Inbox item thread writes only the card of that thread's own item (gh-1906 `inbox.proposal.revise`
is the first). The stored `subject_proposal_id` of the thread is a hint, so the tool proves
the association from the current Processing proposals `sourceInbox` edge, as
[[2026-11-06-inbox-thread-sends-reserve-current-proposals]] requires of a send. That record fixes the order of the
writers of the association and of message admission: source first, then the cards without waiting (`FOR UPDATE
NOWAIT`), then the thread; [[2026-11-09-inbox-type-edges-reserve-current-cards-without-waiting]] applies the same order
to type edges. Confirm and revise are older and take the card first, and confirm can then need the source, which is
why those records never wait for a card while holding the source
([[2026-11-01-inbox-fingerprint-inputs-locked-through-proposal-write]]).

A tool call revises a card and must not commit after the association it relied on was removed. The source-first
protocol does not fit a tool: the tool has no business with the source row, and reserving the source would make every
revision wait for, or be refused by, the other source writers (attachments, type edges, sends) for nothing.

## Decision

The tool locks the card `FOR UPDATE`, exactly as revise, confirm and reject do, and only then reads the card's
`sourceInbox` edge to the thread's source `FOR SHARE OF edge`. A removal of the edge that is still open is waited for,
and one that committed is seen, so the call is answered as for a missing card. The tool never locks the source row
and never waits for another card. The edge is read in the same statement that resolves the run, the thread and the
source, and `reviseProposalFromThreadWithClient` reads it again under the same lock before it writes.

This order cannot cycle with the writers that exist:

- An association insert or removal takes the source (blocking, or `NOWAIT` under a value-link admission) and then
  writes the edge. It takes no card lock, so it waits for the tool only for the edge row, and the tool, which holds
  the card and the shared edge lock and takes nothing else, commits and releases it.
- Confirm holds the card and then needs the source. The tool holds no source and takes the card first, so a tool that
  waits for the card holds neither the edge nor the source, and a removal that holds the source never waits for it.
- A send admission and a type-edge mutation hold the source and reserve cards `NOWAIT`. They get `version_conflict`
  from a card the tool holds, and never wait for it.

A later item thread tool that needs a stable association follows the same order: its card, then the edge `FOR SHARE`,
no source. A tool that must also change the association itself, or lock the source, follows
[[2026-11-06-inbox-thread-sends-reserve-current-proposals]] instead and is decided in its own record.

A revision is also refused when the card changed after the assistant read it. The assistant composes the whole
revised envelope from the card as the turn started, and a thread revision makes the revised value of every manual key
the user's value, so a manual edit made during the turn would be overwritten with the stale one. The tool requires the
`ifVersion` that the card context and `inbox.proposal.get` show (the card's `updatedAt`), and `version_conflict`
tells the model to read the card again. This is the optimistic check of the revise route, made mandatory because the
caller is a model that cannot be trusted to have read the latest card.

## Consequences

The protection holds for the supported writers, not for arbitrary SQL, and no global deadlock freedom is claimed, as in
the records above. A tool call waits for an open association removal and for a concurrent confirm of its card, as a
revise route does. Evidence: the tool test that holds a removal open while the call runs, observing the lock wait in
`pg_stat_activity`, and the tests of a stale `ifVersion` after a user edit.
