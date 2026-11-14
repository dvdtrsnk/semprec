---
status: accepted
date: 2026-11-14
area: [backend]
supersedes: []
superseded-by: null
---

# A reminders change enqueues one debounced resync job per tenant in its write transaction

## Context

The iPhone schedules the reminders of Events and Tasks itself from `GET /api/calendar/reminders` (#1858). When a write
on the web, through an agent or from another device changes what that feed would answer, the phone learns about it only
when the app opens again. [[2026-11-13-a-sleep-change-enqueues-one-debounced-resync-job-per-tenant-in-its-write-transaction]]
decided the same thing for sleep data: one debounced job per tenant, enqueued in the write's own transaction, that sends a
silent push. This decision applies that mechanism to the writes that can change a fire time (#1879) and records what is
different: the writes are those of the most written databases of the system, and one of the paths is a cascade.

## Decision

1. **The sleep mechanism, for reminders.** `enqueueRemindersResync(client, tenantId)`
   (`backend/packages/data/src/calendar/remindersResync.ts`) enqueues the core task `remindersResync` with the key
   `reminders-resync:<tenantId>`, `jobKeyMode: "replace"` and a run time 30 seconds after the call, so any number of
   changes inside 30 seconds leave one pending job and one push goes out after the last of them. The payload is
   `{ tenantId }`, and the handler runs in the tenant of the job's envelope, checks that the payload names it and sends
   `{ kind: "remindersResync" }` as a silent background push to each active iOS APNs registration of the tenant's user,
   with the delivery rules of decision 5 of the sleep decision. The task is a core task of the API runtime
   (`CORE_TASK_NAMES.REMINDERS_RESYNC`, tenancy `tenant`) and its handler is registered in `worker.ts`.
2. **Which writes.** Hooks registered in `domainWriteHooks.ts` (`calendar/remindersResyncHooks.ts`) enqueue in the write's
   transaction for: the create of an Event or a Task that carries a value for `date`, `endDate`, `timeFrom`,
   `alertMinutes`, `travelMinutes`, `notifications` or `status`; the update of an Event or a Task that changes the value
   of one of them; the update of a calendar that changes `notify`; the update of the System settings item that changes
   `timezone`; and the trash and the restore of an Event, a Task or a calendar. A create is judged as a change from
   nothing: a key that the create only filled in from its default (a Task's `status` is `notDone`) or that a pre-write
   transform set to `null` (a Task without a date gets `timeFrom: null`) is not a value, so a Task created with only a name
   enqueues nothing. An update is judged by value: the hook context carries the values the patch replaced (`previous`, one
   generic field of every update hook's context that `itemWrites.ts` already holds), so a rename, and a patch that names
   one of these keys with the value the item already stores, enqueue nothing.
3. **Hooks, not edits of the choke point.** The trash and the restore are item delete and restore hooks
   ([[2026-11-07-item-delete-and-restore-domain-hooks]]) and the time zone is an update hook, so `itemTrash.ts` and
   `itemWrites.ts` gain no import of the calendar module, which the `chokepoint-knows-no-domain` rule forbids. Every row
   of a cascade runs the hook: the trash of a calendar with its Events and of a task series each enqueue once per row and
   leave one pending job.
4. **Registered last.** The hooks are registered after the hooks that validate, refuse or derive these writes, so a write
   they refuse throws before it enqueues. Writes of one tenant that enqueue under the one job key meet in
   `graphile_worker.add_job`, as the sleep decision records: the second waits until the first ends. Here that is every
   Event, Task and calendar write of a tenant that names a fire time key. A cascade that locks more rows after one of its
   hooks has enqueued can wait for a row another writer holds while it holds the job key, and that writer then waits for
   the key: Postgres ends such a deadlock with `40P01` for one of the two, the residual the sleep decision accepts for its
   plan days. The cascade of a task series takes the locks of all its rows before its first hook runs
   ([[2026-11-14-a-recurring-task-series-is-trashed-and-restored-as-one-cascade]]); no other cascade is claimed to.

## Alternatives rejected

- **A change of `itemWrites.ts` and `itemTrash.ts`, as the issue's file list names.** Rejected for the boundary rule in
  decision 3; the hooks run in the same transactions at the same points.
- **A visible server-side reminder, a reminders table or a minute sweep.** Out of the scope of the issue: the phone owns
  the reminders and the push only triggers a resync.
- **Judging a write by the keys it names.** Rejected: a patch or a whole-item write that repeats a stored value, and a
  create whose only fire-time key is a default, would cost the device a push for a feed that answers the same.

## Consequences

- A write of an Event's calendar edge, which can move the Event into a muted calendar, is not an item write and enqueues
  nothing; the phone learns it at the next launch or the next change.
- The device can receive a push before a later write of the same series is enqueued; that write queues a new job and the
  device is told again. APNs does not guarantee delivery of a background push.
