---
status: accepted
date: 2026-10-29
area: [backend]
supersedes: []
superseded-by: null
---

# Agent page-write policy: insertion is direct, replacement and deletion need approval

## Context

Semp (the assistant) reads and edits pages through the page operation family of
[[2026-10-28-page-operation-family]]. [[2026-09-10-agent-writes-are-proposals-not-direct-writes]]
requires agent changes to go through the approval queue, and
[[2026-09-18-non-destructive-generic-operations-bypass-agent-approval]] lets
operations that are easy to reverse with another catalog write skip approval.
`docs/docStore.ts` already admits the `ai_agent` origin directly as a documented
exception "until an approval queue exists for CRDT docs"; today only a
user-confirmed `pageContent` proposal (`inbox/proposalActions.ts`) writes a page
document. Page history is kept for 30 days (`openDocVersionAt` in
`docs/docHistory.ts`), but no operation restores a version yet (#1617 adds it).
The issues that implement this policy (#1844, #1680) need one stable reference.

## Decision

1. **Inserting blocks is a direct write.** `page.insert` does not require
   approval. Its blocks are authored `ai_agent`, so Semp's changes can be
   listed and traced.
2. **Replacing a page and deleting blocks or pages require approval.**
   `page.replace` is a destructive operation that goes through the approval
   queue. `page.replace` keeps requiring approval after version restore
   (#1617) exists, because it is a large destructive change; restorability does
   not downgrade it.
3. **Permission follows the owner's database grant.** Whether Semp may write a
   page is decided by the grant on the database of the page's owning item
   (per-database grants). Sensitive databases are denied by default and need an
   explicit grant. The capability and grant checks are implemented in #1844.
4. **`created_by` means what Semp wrote on its own.** Blocks written by a
   proposal the user confirmed are authored `user`, because confirming makes
   them the user's decision; that Semp proposed them is recorded on the Inbox
   card (per-step block ids, #1648). A listing filtered on `ai_agent`
   (#1680) therefore shows only Semp's own direct writes, never confirmed
   proposals.

## Why the exception is acceptable

Insertion is additive: it destroys no existing content. It is attributable,
because every block carries `created_by` `ai_agent`. Within 30 days a mistaken
insertion can be undone by restoring an earlier version (#1617, once it
exists). Replacement and deletion lack these properties, so they stay behind
approval. This is an exception to
[[2026-09-10-agent-writes-are-proposals-not-direct-writes]] in the same
direction as [[2026-09-18-non-destructive-generic-operations-bypass-agent-approval]],
and the `ai_agent` origin exception in `docs/docStore.ts` remains the mechanism
that admits the write.

## What would change this decision

An approval queue for CRDT documents. Once pages can be proposed and confirmed
like catalog writes, direct insertion should be reconsidered in a new ADR that
supersedes this one.

## Consequences

- #1844 sets `page.insert` to no approval and `page.replace` to approval with
  `riskClass: "destructive"`, and checks the owner's database grant, denying
  sensitive databases by default.
- #1680 lists Semp's changes by `created_by` `ai_agent`.
- The journal proposals work (#1681, #1981) switches user-confirmed proposal
  writes to author `user`; until then a confirmed proposal's author differs
  from this policy.
- Until #1617 ships, the 30-day reversibility argument rests on page history
  that cannot yet be restored through an operation.
