---
status: accepted
date: 2026-11-11
area: [backend]
supersedes: []
superseded-by: null
---

# A delete hook refuses a user's or an agent's trash of a Mailboxes item, the mailbox removal passes it as the system writer, and a delete approval guard refuses an agent run's request before it is queued

## Context

[[2026-11-10-mailbox-removal-is-one-transaction-that-also-writes-sync-status]] removes a mailbox through
`DELETE /api/mail/mailboxes/:id`: one transaction trashes the Mailboxes item and deletes its credential, its
sync state and its server settings, and
[[2026-11-11-a-removed-mailbox-is-cleaned-up-at-the-provider-from-memory-after-the-commit]] cleans up outside
the database afterwards. The generic `DELETE /api/items/:id` reached the same trash cascade without any of
that: the mailbox went to the trash with its stored secret, its sync rows and its hosted lifecycle's
credential in place. Issue gh-2031 closes that path.

[[2026-11-07-item-delete-and-restore-domain-hooks]] lets a domain refuse a trash through a delete hook, which
runs inside the cascade's transaction for every row it trashes, whichever caller started it. The hook's
context carries `writerKind`, which `chokePoint/itemTrash.ts` takes from the `writer` option of the trash
entry points and sets to `system` for a caller that passes none.

The issue text asks that the removal proceed past the hook "by its own system path (a marker the removal
passes in the hook context), which no generic route, agent tool or `/mcp` operation can set". Two markers were
possible:

- **The writer kind.** The removal already trashes the item as the system writer. The generic paths derive
  their writer from the authenticated caller and never read it from a request: `writerIdentityOf`
  (`packages/application/src/genericApplicationService.ts`) answers `user` for a REST session and `agent`
  for an agent run and for an MCP client, and the approved-operation executor
  (`replayApprovedGenericOperation`) writes as `agent`.
- **A field of its own.** A new option of `itemDeleteWithClient`, passed on in the hook context, would tell the
  removal apart from every other system writer. It adds a field to the choke point's trash entry point and
  to every delete hook's context for one consumer.

A guard in the routes instead of the cascade would have to be repeated on REST, on `/mcp`, in the agent tools
and in the approved executor, and a new path would miss it.

An agent run's `item.delete` does not reach the cascade when it is requested.
[[2026-09-18-exactly-once-execution-of-approved-destructive-operations]] stores it as an approval request
after a projection of the item (`computeDestructiveResourceProjection`) that repeats the refusals the trash
makes before it writes, so that a request the trash can only refuse is not queued. The executor of an
approved request runs the same projection again and ends a request it refuses as a `conflict`; an error of
the mutation itself escapes, the transaction rolls back and the queue retries the job. A delete hook runs
inside the cascade, after the soft delete, so the projection cannot run it. With the hook alone, an agent
run's delete of a mailbox was therefore queued, shown for approval, and refused by the executor's mutation
on every attempt: the request stayed `approved` and `queued` and the run was never told. The delete hooks
registered before this one enqueue or detach and do not refuse by rule, so the projection had no hook
refusal to mirror.

## Decision

1. **A delete hook refuses the trash.** `mailboxDeleteHook` (`backend/packages/data/src/mail/mailboxDeleteHook.ts`),
   registered in `domainWriteHooks.ts`, rejects with `ForbiddenError` (status 403, code `forbidden`, no
   details) when the cascade trashes a row of the tenant's Mailboxes database and the writer kind is
   `user` or `agent`. The Mailboxes database is the system database whose owner module is `mailboxes`,
   which is how the removal finds it (`getDatabaseByModuleId`). The rejection rolls the cascade back, so
   the item, its credential and its sync rows stay as they were and no invalidation is sent.
2. **The system writer is the marker.** A row trashed with writer kind `system` passes. `removeMailbox`
   passes `SYSTEM_WRITER` to `itemDeleteWithClient`. No field is added to the hook context.
3. **A row of any other database passes**, whoever trashes it, the Folders and Emails of a mailbox included.
   A database that carries the module id `mailboxes` and is not a system database is another database:
   the removal does not find its items, so the hook does not refuse their trash.
4. **The approval projection of `item.delete` asks the owning module's delete approval guard.**
   `chokePoint/hooks.ts` gains a registry keyed by module id, next to the item patch approval contribution:
   `registerItemDeleteApprovalGuard(moduleId, guard)` and `getItemDeleteApprovalGuard(moduleId)`. A module
   registers one guard, a second registration for the same module throws, and `clearHooksForTests` clears
   the registry. A guard receives `{ client, database, item }` for the live item the request names and
   returns the message of the refusal, or `null`. The `item.delete` case of
   `computeDestructiveResourceProjection` calls the guard of the database's owner module after its own
   checks, which is where the hooks come in the cascade, and for a message throws `ForbiddenError` (status
   403, code `forbidden`) with the projection as `currentResource`.

   `mailboxDeleteApprovalGuard` is registered for the `mailboxes` module in `domainWriteHooks.ts`, next to
   the hook. Both apply one function, `mailboxDeleteRefusal`, the guard with the writer kind `agent`: only
   an agent run reaches the projection, and the executor writes as `agent`.

   This extends two records, which stay as they are. The projection of
   [[2026-09-18-exactly-once-execution-of-approved-destructive-operations]] now also mirrors a refusal that
   a delete hook makes by rule. And a delete hook of
   [[2026-11-07-item-delete-and-restore-domain-hooks]] that refuses an agent's trash by a rule, and not by
   the state of one attempt, registers a guard with the same rule.

## Consequences

- `DELETE /api/items/:id` on a live Mailboxes item answers 403 `forbidden`. An MCP client's `item.delete`
  is refused with the same error, as a JSON-RPC error.
- A trash of a Mailboxes item that is already in the trash answers as before, whoever the writer is: the
  cascade returns the trashed row, writes nothing and runs no hook
  ([[2026-11-07-item-delete-and-restore-domain-hooks]]).
- An agent run's `item.delete` of a Mailboxes item answers 403 `forbidden` when it is requested, with the
  hook's message. No approval request and no `approval_pending` notification is created.
- An approval request for such a delete that was stored before the guard existed ends as a `conflict` with
  the reason `forbidden` when it is executed: the executor's projection refuses it before the mutation
  runs. The job succeeds, and the run's thread, when it has one, receives the conflict outcome.
- The guard is asked about the item the request names. The Mailboxes database is a top-level system
  database, so no trash cascade that starts at another item reaches one of its rows.
- Nothing checks that a refusing delete hook has a guard. A hook that refuses by rule without one is met
  only by the executor's mutation, and its approved request then fails on every attempt, as described in
  the Context. A new hook of that kind adds its guard and a test of the projection.
- Code inside the backend that calls the trash cascade for a Mailboxes item as the system writer, or
  without a writer, passes the hook and skips what the removal does. `removeMailbox` is the only production
  caller that does. Tests trash a mailbox that way to build a trashed mailbox. A new caller that needs a
  mailbox gone calls `removeMailbox`.
- Another tenant's Mailboxes item is not reached: row-level security hides it from the lookup that precedes
  the cascade, so its id answers like an unknown id, as before.
- A mailbox that the generic delete trashed before this change keeps its credential and sync rows until it
  is restored and removed, or purged: the mail purge hook deletes them
  ([[2026-11-11-mail-purge-hook-takes-the-thread-guard-after-the-purge-locks]]). Restoring a mailbox is
  issue gh-2032; this hook does not act on a restore.
