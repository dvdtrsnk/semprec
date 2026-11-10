---
status: accepted
date: 2026-10-25
area: [backend]
supersedes: []
superseded-by: null
---

# Undoing a confirmed proposal reverses its recorded writes

## Context

Confirmed and rejected Processing proposals are locked. The code treats `confirmed` and `rejected`
as final (`LOCKED_PROPOSAL_STATUSES` in `backend/packages/data/src/inbox/inboxTypesStore.ts`; the
Inbox tick, revise and reject honor it), and
[[2026-09-23-processing-proposals-card-creation-owned-per-kind]] lists confirm, reject and revise
as the post-creation actions of a card. A confirmed or rejected card therefore never changes again.

The Inbox needs an undo of the last decision. For a confirmed card that means reversing writes
that confirm made across several databases and, for a connected MCP server, a stored credential.
The repository has no precedent for reversing a multi-database confirmation. This ADR narrows the
"a confirmed or rejected card never changes again" rule: reopening a card through the routes this
ADR names is the only exit from `confirmed`. It does not edit the older ADR. Reopening a
`rejected` card is a separate decision (#1937) and is not covered here.

The real alternatives are listed under "Alternatives rejected". The implementation is #1943; the
cancellation of follow-up jobs is #1984.

## Decision

A confirmed card can be reopened in one transaction. The reopen is driven by the per-step results
and origin rows recorded at confirm, not by re-deriving what confirm would do. Each kind of write
is reversed as follows:

- **Items created by the confirmation** are soft-deleted. Their relation edges stay, so a restore
  from the trash brings the item back with its relations. The exception is the file below.
- **A Files item that received an Inbox attachment moved at confirm** stays in Files, because the
  move has no reverse operation. The undo result names that item explicitly so the user can move
  it to the trash.
- **Relation edges created between items that already existed** (link steps, a transcript card's
  event or speaker edge) are deleted for good. These edges have no item of their own to restore.
- **Items patched by the confirmation** get the values they had before the patch restored; the
  previous values are recorded in the card's results at confirm.
- **Page blocks inserted by the confirmation** are removed by the block ids derived from the
  proposal.
- **A credential stored for a connected MCP server** is deleted.
- **The card** returns to `proposed` with its original effective envelope, and its history gains a
  `reopened` entry.

### Precondition

Every item created or changed by the confirmation must still have the `updatedAt` stored in the
card's results. If any item has a different `updatedAt`, the undo is refused with 409
`version_conflict` carrying the changed item, and nothing is written. Undoing over a later edit
would destroy that edit. The refusal names the changed item so the client can explain why the undo
is unavailable.

### Follow-up processes

Queued jobs started by a confirmation are cancelled, and what they would have produced is removed:
a queued transcription and the transcript item it creates, and a queued MCP tool sync (#1984).

### Limits of the mechanism

- There is no time limit. A confirmed card can be reopened at any time while the precondition
  holds; the `updatedAt` check, not the clock, protects later edits.
- Approval requests, which are decided through the approvals route, are not undoable by this
  mechanism. [[2026-09-18-exactly-once-execution-of-approved-destructive-operations]] is not
  changed. An executed approved action is reverted by restoring from the trash or by a new change.

## Alternatives rejected

- **Forbid undo.** Keeps the lock simple, but a mistaken confirm then leaves created items, edges,
  patches and credentials that the user has to clean up by hand across several databases.
- **Undo only before follow-up jobs start.** The window is short and invisible to the user, and
  the cancellation of queued jobs is needed anyway for the cases that remain.
- **A time window.** It adds a clock the user cannot see and still has to handle later edits, which
  the `updatedAt` precondition already handles; a window protects nothing the precondition does not.

## Consequences

- Confirm must record, per step, the created item ids, the previous values of patched items, the
  inserted block ids, the stored credential and the `updatedAt` of every item it created or
  changed. #1943 implements both sides.
- A user edit to any item the confirmation touched makes the undo unavailable until that edit is
  accounted for; the client receives the changed item to explain it.
- A file moved into Files at confirm remains after an undo; the user is told which item it is.
- Any new confirm step must define its reversal and its recorded data, or the card cannot be
  reopened correctly.
