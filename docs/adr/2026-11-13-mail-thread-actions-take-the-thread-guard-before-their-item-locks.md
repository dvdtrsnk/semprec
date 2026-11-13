---
status: accepted
date: 2026-11-13
area: [backend]
supersedes: []
superseded-by: null
---

# A mail thread action takes the mail-thread guard before it resolves the thread and before it locks any copy

## Context

[[2026-11-01-mail-thread-mutations-use-a-tenant-transaction-guard]] makes the writers that decide on
mail thread membership take the tenant's advisory guard first, and says that a new writer or a new lock
acquisition order needs an explicit compatible contract. The IMAP, Gmail and Graph reconcilers and ingest
take the guard at entry (`imapReconcile.ts`, `gmailReconcile.ts`, `graphReconcile.ts`, `ingest.ts`) and
hold it for their whole transaction. Inside it, `applyObservedMailMessageFlags` locks one Emails item
after another with `FOR UPDATE`, in the order the provider lists the messages.

`POST /api/mail/threads/:threadId/read` (gh-1865) is the first writer that holds several Emails items in
one transaction: it locks every copy it may write, in item id order, and writes each through
`updateItemWithClient`. Item id order is the same for two calls of the route, and says nothing about the
provider order of a reconcile pass. A thread with copies A and B in one mailbox, A < B by item id and B
before A in provider order, gives a cycle when the route and a pass run together: the route holds A and
waits for B, the pass holds B and waits for A. PostgreSQL ends one of them with 40P01, which no layer
answers as a domain error: the user gets a 500, or the pass rolls back. A single-item `PATCH
/api/items/:id` holds one item and cannot close such a cycle. The follow-up thread actions (flag, archive,
trash) write several copies the same way.

## Decision

`resolveMailThreadForAction` (`mail/mailThreadActions.ts`), which every thread action calls as its first
step, calls `lockMailThreadMutation` before it resolves the thread id. The guard is therefore the first
statement of the action's transaction, before the thread resolution, the listing of the copies and the
first item lock, and a thread action runs in the tenant's READ COMMITTED transaction the helper requires.
A thread action and a reconcile pass of the same tenant then serialize on the guard instead of
interleaving their item locks, and two thread actions serialize with each other. A new thread action calls
`resolveMailThreadForAction` first and does not take item locks before it.

The guard is not a rule for item writes in general. Only a writer that holds several Emails items in one
transaction takes it; a writer that holds one item at a time (the generic item PATCH, a draft write) keeps
taking no guard, because it cannot form a cycle with the item locks of a reconcile pass.

## Alternatives rejected

- Lock the copies in item id order only. That is the order between two calls of the route and does not
  constrain the reconcilers, which lock in provider order.
- Make the reconcilers lock in item id order. Their order follows the provider listing and the
  provider calls between messages; sorting would change every reconciler.
- Retry or map the 40P01 error. A request that did nothing wrong would fail or repeat a half-done write,
  and a rolled-back pass loses its provider progress.

## Consequences

- A thread action waits behind a running reconcile pass of its tenant, for the pass's whole transaction,
  including its provider calls. That is the cost the guard decision already accepts for sends, and it is
  bounded by the pass, not by the request.
- A thread action holds the guard for its transaction only, which contains no provider call: the
  provider write-back is queued by the Emails flag hook and runs later.
- The thread actions of different tenants have different guard keys and do not wait for each other; an
  ordinary hash collision can still serialize them, as the guard decision notes.
