---
status: accepted
date: 2026-11-12
area: [backend]
supersedes: []
superseded-by: null
---

# A push inside the user's sleep window is held by a deferred fan-out job

## Context

Until #1794 the `notificationFanout` job (`backend/packages/data/src/notifications/notificationFanoutJob.ts`)
sent every push as soon as it ran. `writeNotification` enqueues one job per notification under the key
`notification-fanout:<notificationId>`, and `push_deliveries` holds one row per notification and
registration, which keeps a retried job from sending to the same registration twice.

The sleep module (#1776) stores whether the user wants Semp to stay quiet while asleep
(`enabled` and `muteSemp` of the `sleepSettings` item), and `resolveSleepNights` (#1792) turns the plans
and night exceptions into nights with a bedtime and a wake time in the tenant's time zone. #1794 makes
the fan-out job respect that window. Every later push kind, and the APNs work that follows in the same
job (#1829, #1831, #1826), meets what is decided here, and each point below had an alternative.

## Decision

1. **Hold, not a quiet variant.** A push inside the window is not sent. It is sent at the wake time. The
   notification row and its realtime event are written as before, so an open app shows the notification
   at once.
2. **What is held.** Every notification that passes the preference filter of #1443, except those whose
   kind has the category `approvals` in `NOTIFICATION_KIND_POLICY`. A new kind is held unless its
   category is `approvals`. There is no second list of kinds.
3. **The window.** `findSleepMuteUntil(client, now)` in `backend/packages/data/src/sleep/sleepMuteWindow.ts`
   reads the tenant's settings, plans and night exceptions and returns the latest wake time among the
   nights whose window contains `now`, when `enabled` and `muteSemp` are both true. A window runs from
   the bedtime, inclusive, to the wake time, exclusive. The time zone is the tenant's.
4. **The mechanism.** The job that finds the push inside the window enqueues the same task
   `notificationFanout` with the payload `{ notificationId }`, the key
   `notification-fanout-deferred:<notificationId>:<wake time>`, the key mode `preserve_run_at`, ten
   attempts and the wake time as its run time. It then returns before it loads registrations or claims a
   `push_deliveries` row. `<wake time>` is the instant as `Date.prototype.toISOString` renders it: UTC
   with milliseconds, for example `2026-10-17T06:30:00.000Z`. The enqueue runs in the tenant scope of
   the job that holds the push, so the deferred job's envelope carries the same tenant
   ([[2026-10-05-tenant-scope-propagation]]). No deferral is stored anywhere else.
5. **The same check at the wake time.** The deferred job is the same handler and makes the same check.
   A wake time that was moved later in the meantime holds the push again under a new key. Otherwise the
   push goes through the existing claim and send path. Nothing reschedules a queued deferred job, so a
   wake time that was moved earlier does not send the push earlier.
6. **A failed check sends.** If reading or resolving the sleep data throws, the job logs the
   notification id and the error's name and sends as if no window applied. The enqueue of the deferred
   job is outside that rule: if it fails, the job fails and the queue retries it.
7. **The clock.** The check reads the clock of the process that runs the job. The handler takes an
   optional `now` function, which tests pass.

## Alternatives rejected

- **A quiet push (`interruption-level: passive`) instead of a hold.** Rejected: web push has no
  equivalent, so the two channels would behave differently.
- **A constant listing the kinds that are never held.** Rejected: the category map of #1440 already
  says which kinds are approvals.
- **Storing the deferral in a table.** Rejected with the feature it would serve: sending a held push
  earlier when the night is edited was decided not to be done. The job key and the queue's run time
  carry the state.
- **Failing or dropping the push when the sleep data cannot be read.** Rejected: a broken sleep read
  must not cost a notification, and a push at night is the smaller harm.
- **No check in the deferred job.** Rejected: a wake time moved later after the hold would be ignored.

## Consequences

- A notification can have two jobs in the queue: the one written with it and a deferred one. The first
  completes right after it enqueued the second, so they do not normally run at the same time. They can
  when a worker dies between that enqueue and the completion of the first job and the queue runs the
  first job again at the wake time. No lock excludes that overlap: `claimPushDeliveryTargets` and the
  read of the delivery statuses are separate statements, so both jobs can then send to a registration.
- A held push is not released early. Neither an earlier wake time nor switching `enabled` or `muteSemp`
  off sends it before the wake time it was held for.
- The check and the enqueue are separate transactions, and no lock is taken on the sleep data. A change
  that commits between them is seen by the deferred job, not by the job that held.
- A run of the first job that repeats inside the window enqueues under the same key. With
  `preserve_run_at` that collapses onto the queued job, which keeps its run time.
- The queue starts the deferred job by the database clock, and the check reads the process clock. A
  process clock that is behind finds the push still inside the window and enqueues under the key of the
  job that is running. graphile-worker then adds a new job with that key and the same run time, so the
  push is checked again until the process clock reaches the wake time.
- A job that fails transiently after the wake time is retried by the queue with its backoff. A retry
  that falls into the next night's window is held until that night's wake time.
- A tenant without the sleep module, or with `enabled` or `muteSemp` off, costs the job one or two
  short reads and is never held.
- The default plans of a seeded tenant hold a push at night, so a test that runs the fan-out job for
  such a tenant on the real clock would depend on the hour. `sempProblemNotification.test.ts` passes a
  clock and `tenantIsolationJobs.test.ts` switches `muteSemp` off.
