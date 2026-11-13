---
status: accepted
date: 2026-11-13
area: [backend]
supersedes: []
superseded-by: null
---

# The gateway announces a tenant's first budget refusal of a window

## Context

[[2026-11-10-semp-status-problems-derived-at-read-time]] derives two Semp status problems from the tenant's
budget: `aiBudgetMissing` and `aiBudgetExhausted:<resetsAt>`. Nothing is stored, so nothing tells a connected
client when one appears or ends, and it said that gh-2023 and gh-2024 would publish a status invalidation (the
id-less `sempStatus` realtime scope of gh-1868) at the first refusal of a window and at the reset instant. The refusals are decided by the AI gateway under the budget lock
([[2026-10-16-per-tenant-ai-budgets-with-a-global-safety-cap]]): it rolls the reservation back and throws one
constant `BudgetExceededError` for every cause.

This record fixes what the gateway announces, when, how often, and who may enqueue the job that announces the
reset. Each point had an alternative.

## Decision

1. **Which refusals.** Only a refusal caused by the tenant's own state: no `tenant_ai_budgets` row
   (`noTenantBudget`), the tenant's daily cap (`tenantDaily`) or its monthly cap (`tenantMonthly`). A refusal by
   the operator-wide caps (`globalDaily`, `globalMonthly`) announces nothing, because it is not the tenant's state
   and the tenant must not learn of it. The refusal itself, its message and its reservation lifecycle do not
   change, and the error the caller receives is a new plain `BudgetExceededError`, carrying nothing about the
   window.
2. **When.** After the refused reservation's transaction has rolled back, never inside the budget lock. `reserve`
   catches the refusal that the transaction threw, awaits `announceTenantRefusal`, and then throws the plain
   error. The announcement never rejects.
3. **What.** One `sempStatus` invalidation of the tenant (`publishSempStatusInvalidationAndWait`), and, for an
   exhausted cap window only, one `aiBudgetReset` job. The job is a tenant task of the `api` affinity set with
   the payload `{}`, the run time `resetsAt`, the key mode `preserve_run_at` and the key
   `aiBudgetReset:<tenantId>:<resetsAt>`, where `resetsAt` is `Date.prototype.toISOString` of the instant and
   `<tenantId>` is the tenant of the active scope. Its handler publishes the same invalidation in the envelope's
   tenant and reads and writes no budget data. A tenant without a budget row has no reset instant and gets no job.
4. **Which window.** The exhausted window as the budget summary of gh-1456 names it, so `monthly` wins when both
   caps are reached, although the log then names the daily cap, which the gateway checks first. A tenant without a
   budget row is in the window `noBudget`, which lasts to the end of its current day in its timezone.
5. **How often.** Once per tenant and window, remembered in the gateway process only. The ledger key is
   `<tenantId>|<window>|<timezone>` and the entry holds the instant the window ends. An entry is dropped by the first
   announcement call that finds it past that instant, so the ledger holds at most one entry per tenant, kind of
   window and timezone, and an entry of an ended window stays only until the next call. The claim of a window is one synchronous step after the window's
   end has been looked up, so refusals that race to it have one winner. Nothing is persisted: a restart forgets
   every entry and the announcement then repeats once, which is harmless because the invalidation is idempotent and
   the job key makes the second enqueue a repeat of the first.
6. **Failure.** A failing step is logged with the tenant id and the error's name, never with the error itself, an
   amount or a limit, and is swallowed. The publish and the enqueue are separate steps, so one failing does not skip
   the other. A window whose announcement had a failing step is released, so the next refusal of that window
   announces again. The invalidation is published through an awaited publisher of the data layer
   (`publishInvalidation`, installed by `wireRealtimeHooks` beside the fire-and-forget hook), not through that hook:
   the hook ends in a log line and returns nothing, so a failed NOTIFY would never reach the gateway, would be logged
   by the realtime layer with the whole error, and would leave the window claimed. The awaited publisher rejects
   with the failure and logs nothing, so the gateway's own log line is the only one.
7. **Whose tenant.** The tenant of the active scope of the refused call, a trusted source. A refused call that ran
   with no tenant scope announces nothing.
8. **Who enqueues.** The gateway process. Its runtime role `semprec_side` holds the graphile-worker privileges that
   `grantQueueSchemaPrivileges` grants, and `enqueueJob` stamps the tenant of the scope into the envelope, so the
   API runtime's worker runs the job in that tenant. The gateway process wires the data layer's realtime hooks over
   its own pool when it composes its server (`createGatewayServer`, which `serve.ts` calls before it listens) so that
   the invalidation reaches the realtime channel from there.
   This is the first job the gateway process enqueues.

## Alternatives rejected

- **Raising a stored problem row at the refusal and resolving it at the reset.** Already rejected by
  [[2026-11-10-semp-status-problems-derived-at-read-time]]; this record only adds the signal.
- **Announcing every refusal.** A tenant that keeps calling a closed budget would send one frame per call to all of
  its sockets, and each client would re-read the status for it.
- **Keeping the ledger in a table.** A second copy of a state that the budget tables already determine, with a write
  from a refused call and its own cleanup, for a signal that is safe to repeat.
- **Announcing operator-wide refusals.** It would tell a tenant that a cap shared with other tenants was reached.
- **Relaying the signal to the API process, which would enqueue.** The gateway already has the privilege, and the
  relay would need a channel and a failure path of its own.

## Consequences

- A tenant that raises its cap and exhausts it again within the same window is not announced a second time. Its
  next status read is correct; a connected client sees the change only when it re-reads.
- A tenant refused at the monthly cap while the daily cap was reached first gets its job at the end of the month,
  not at midnight, because that is the window the status reports. When the daily cap alone is later what refuses,
  its first refusal announces the daily window.
- Repeated refusals of a tenant at a cap cost no query after the first one in a window. Repeated refusals of a
  tenant without a budget row read the timezone each time before the ledger is consulted.
- The ledger expires an entry by the clock of the gateway process, and the reset instant comes from the database
  clock. A process clock that runs ahead can announce the last seconds of a window again; one that runs behind can
  suppress the first seconds of the next.
- An announcement that fails and is released is repeated by the next refusal of the window, so a failing queue is
  attempted at most once per refused call. If the process never sees another refusal in that window, the reset
  invalidation of that window is never queued, and the client re-reads the status on its own.
- The job runs in the API runtime and fires at the database's clock for `run_at`; a worker that is down at the reset
  instant runs it when it returns.
