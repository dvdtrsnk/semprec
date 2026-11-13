---
status: accepted
date: 2026-11-13
area: [backend]
supersedes: []
superseded-by: null
---

# A sleep change enqueues one debounced resync job per tenant in its write transaction

## Context

The iPhone schedules the alarm and the bedtime reminder itself, so it has to learn that sleep data changed on
another device, on the web or through an agent (#1838). The backend can send it a silent background push
(`sendApnsBackgroundPush`, #1445). Sleep data is the settings item, the plans and the night exceptions of the
three sleep databases (#1776), and the System settings time zone, which decides the instant of every night.
Several edits usually come together (a drag in the calendar, an agent that changes five nights), and the device
needs one push after them, not one per edit. The decisions below each had an alternative.

## Decision

1. **One job per tenant, replaced on every change.** `enqueueSleepResync(client, tenantId)`
   (`backend/packages/data/src/sleep/sleepResync.ts`) enqueues the task `sleep.resync` with the key
   `sleep-resync:<tenantId>`, `jobKeyMode: "replace"` and a run time 30 seconds after the call. A pending job is
   replaced and its run time moves, so any number of changes inside 30 seconds leave one pending job, and the
   push goes out 30 seconds after the last of them. A job that is already running is not replaced: the change
   queues a second job.
2. **In the write's transaction, from the choke point's hooks.** The create, update, delete and restore hooks of
   `sleepWriteHooks.ts` (registered in `domainWriteHooks.ts`) enqueue on the write's own client, for items of the
   three sleep databases, and for an update of the System settings item whose patch names `timezone`. The job
   commits or rolls back with the write: a write the sleep rules refuse enqueues nothing, and a committed write
   cannot lose its resync. The hooks are registered after the validation and plan hooks of the same database so
   that a refused write throws before it enqueues. The tenant is the one `app_tenant_default()` names for the
   transaction.
3. **Concurrent sleep writes of one tenant commit one after another.** Two transactions that enqueue under the
   same key meet in `graphile_worker.add_job`: the second one waits until the first ends, whether the first
   inserted the job or replaced it. This is the price of the debounce and of keeping the enqueue in the write's
   transaction, and it is accepted: sleep edits are rare, one user's, and short. In the order of a write the enqueue
   comes after the night advisory lock `sleepNight:<tenant>:<night>` and the plan row locks that the validation and
   plan hooks take. One statement can still wait for a plan row while the transaction holds the job key: the plan
   day hook of #1799 repeats its `FOR UPDATE` select after a nested plan update has enqueued, and a deadlock on that
   select ends with the `40P01` to 409 mapping the hook already has. The existing tests that held a sleep write open and expected a write of
   another night or plan not to wait now expect that one wait, on the enqueue, and no other.
4. **The envelope names the tenant, not the payload.** The payload is `{ tenantId }` and nothing else. The queue
   runs the handler in the tenant that `enqueueJob` stamped on the job's envelope. The handler sends nothing when
   the payload names another tenant, and it finds the user through `users.tenant_id` of that scope
   ([[2026-10-03-tenant-isolation-through-row-level-security]]).
5. **Delivery.** The handler sends `{ kind: "sleepResync" }` as a silent push to each active APNs registration on
   platform `ios` (an iPad is one), and to no macOS, Web Push or revoked registration. It writes no
   `notifications` and no `push_deliveries` row. `permanent-failure` revokes that registration, `not-configured`
   neither revokes nor retries, and a `transient-failure` is thrown after every registration was tried so the
   queue retries the job with its default attempts. A repeated push is harmless. APNs does not guarantee that a
   background push arrives; the contract for the iOS client (not built here) refreshes at launch and on a
   realtime invalidation as well.
6. **A module task.** The task is declared in `sleepModuleManifest.ts` (`taskNames`, `queueAffinity: "api"`) and
   runs on the clients of the queue worker's pool through `helpers.withPgClient`. No connection is held across a
   network call.

## Alternatives rejected

- **Enqueue after the commit.** Rejected: a failure between the commit and the enqueue loses the resync for good,
  and `runAfterCommit` reports no failure to the writer.
- **A heartbeat on item events.** Rejected: it needs an action id, a handler and a seeded row, does not fire on
  restore, and has no debounce.
- **A job per write with the sleep data read at run time.** Rejected: ten edits would send ten pushes.
- **`preserve_run_at` or `unsafe_dedupe`.** Rejected: both keep the first run time, so a long series of edits
  would push at the end of the first 30 seconds and leave the device with data from the middle of the series.

## Consequences

- Any later write path to sleep data that does not go through the choke point (and so bypasses the hooks) would
  send no push; none exists, and the rule that all writes use the choke point covers it.
- The device may receive a push before a later write of the same series has been enqueued; that write queues a
  new job and the device is told again.
- Pruning, a visible bedtime reminder and holding other pushes inside the sleep window are separate decisions
  (#1794 and the issue's Out of scope).
