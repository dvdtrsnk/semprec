---
status: accepted
date: 2026-11-14
area: [backend]
supersedes: []
superseded-by: null
---

# A source split locks the card, then the source, then the card's source edge

## Context

[[2026-10-25-thread-may-split-an-inbox-source]] has `splitInboxSourceWithClient` revise the source's primary card and
create sibling cards linked to the same source by `sourceInbox` edges. A sibling edge write runs the Inbox source-edge
write hook, which locks the source row `FOR UPDATE`, waiting
([[2026-11-06-inbox-thread-sends-reserve-current-proposals]]: `sourceInbox` is a system-owned relation, so the
nonblocking value-link admission does not apply). The split therefore needs the source, which
[[2026-11-13-an-item-thread-tool-proves-its-card-with-a-shared-lock-on-its-source-edge]] says a thread tool never
locks; that record sends a tool that locks the source, or changes the association, to its own decision. This is it.

The thread tool proves its card with the card's `sourceInbox` edge held `FOR SHARE` until commit. If the split took the
source only afterwards, in the sibling link, it would wait for the source while it holds the edge. A removal of the
association takes the source and then deletes the edge, which waits for the edge lock, so the two would wait for each
other and Postgres would abort one of them with `40P01`.

## Decision

A split takes its locks in this order and never waits for the source while it holds the edge:

1. the primary card, `FOR UPDATE` (`lockLiveProposal`), as revise, confirm and reject do;
2. the source Inbox item, `FOR UPDATE`, waiting (`lockInboxSource`): the order of confirm, which takes the card and then
   needs the source, so no writer that exists already waits for a card while holding the source
   ([[2026-11-01-inbox-fingerprint-inputs-locked-through-proposal-write]]);
3. the card's `sourceInbox` edge to that source, `FOR SHARE`, to prove the association, as in
   [[2026-11-13-an-item-thread-tool-proves-its-card-with-a-shared-lock-on-its-source-edge]].

`splitInboxSourceWithClient` takes step 2 itself before the proof of step 3, so the action is safe for any caller. The
`inbox.proposal.split` tool needs the thread's source to prove the card, so it reads the association without a lock,
locks that source, and then reads the association again with the edge `FOR SHARE`; a card whose association went away
meanwhile is answered as a missing card. The sibling edge writes then find the source already held.

The order cannot cycle with the writers that exist:

- An association insert or removal takes the source and then writes the edge, and takes no card lock. It waits for a
  split only for the source, which the split takes before any edge lock, so it never waits for an edge the split holds
  while the split waits for it. A removal that committed before the split took the source is seen by the edge proof.
- Confirm holds the card and then waits for the source, as the split does; two of them serialize on the card first.
- A send admission, a type-edge mutation and the tick hold the source and reserve cards `NOWAIT`, so they get
  `version_conflict` from a card the split holds and never wait for it.
- Revise and the other thread tools hold a card and its edge `FOR SHARE` and take nothing else; a split waits for the
  card they hold before it takes the source.

The thread tool `inbox.proposal.revise` keeps the order of the 2026-11-13 record and does not lock the source.

The split tool also takes the `ifVersion` argument that the revise tool takes, beyond the arguments the issue lists:
the first entry replaces the whole envelope of the card, and a thread revision makes the revised value of a manual key
the user's value, so a split composed from a card the user edited since would overwrite that edit. The reason and the
refusal (`version_conflict`) are those of the 2026-11-13 record, which makes the version mandatory for a model-driven
revision of a card; the action keeps it optional, as the revise action does.

## Consequences

The protection holds for the supported writers, not for arbitrary SQL, and no global deadlock freedom is claimed, as in
the records above. A split waits for an open removal of the association, for a concurrent confirm of the card and for any
writer that holds the source, and a removal waits for an open split. Evidence: the split tool tests that hold the
source and a removal open while the call runs, observing the lock wait in `pg_stat_activity`, and the removal of the
edge that proceeds while a split waits for the source.
