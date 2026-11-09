---
status: accepted
date: 2026-11-09
area: [backend]
supersedes: []
superseded-by: null
---

# Confirmed page content derives its block ids from its proposal

## Context

A Markdown page-content proposal (the v2 `pageContent` envelope `{ markdown, placement, heading? }`, validated when the
card is computed) is written when its card is confirmed. The older single-block shape wrote one block
whose id is the proposal's own id, so a repeated write overwrote that block. Several blocks cannot share one id, and an
inserted heading needs an id too. [[2026-10-29-agent-page-write-policy]] decides that confirmed blocks are authored `user`.

## Decision

Confirm writes the content in the same transaction as the `proposed -> confirmed` transition, before the card is locked
`confirmed`. The blocks are inserted by one document write authored `user`.

- **Ids.** Block number `i` gets the version 5 UUID (RFC 4122) whose namespace is the proposal id and whose name is
  `block:<i>`. When the proposal has a `heading`, the heading block is number 0 and the Markdown blocks follow from 1;
  otherwise the first Markdown block is 0. The same proposal always names the same ids, and the card's result lists them.
- **Placement.** `start` and `end` map directly. `afterHeading: <id>` is resolved inside the document write, on the page as
  it stands, to the end of that heading's section: after the last block before the next heading of the same or a higher
  level, or the end of the page when there is none. A heading that is gone, or is no longer a heading block, is a
  `ConflictError` (409); the transaction rolls back and the card stays `proposed`, so the client can offer a new choice.
- **Heading level.** The optional heading is written one level below the section heading and never below `h3`; with no
  section it is `h2`.

A second confirm of the same card finds it `confirmed` under the proposal row lock (`lockItemById`, `FOR UPDATE`) and returns
the stored result without writing. The derived ids add a second line of defence: should a write for a proposal ever reach
a page that already holds its ids, it collides (a `ConflictError`) instead of adding a second copy.

## Consequences

- Block ids are a pure function of the proposal and the order of its blocks; a changed Markdown on revise changes the ids,
  which is correct because a revised card is a different write.
- Concurrent confirms of different cards into one page are ordered by the page document's row locks, not by this record.
- Other producers of confirmed page content (the Journal entry confirm) can adopt the same derivation.

## Alternatives considered

- Random ids: nothing recognises a block as written for a proposal, and a retry adds copies.
- The proposal id for the first block and random ids after: the first block would collide with the legacy shape's id.
