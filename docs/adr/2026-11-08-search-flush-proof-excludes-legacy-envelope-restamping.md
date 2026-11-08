---
status: accepted
date: 2026-11-08
area: [backend]
supersedes: []
superseded-by: null
---

# Search flush proof excludes legacy envelope restamping

## Context

[[2026-11-08-search-lane-enqueues-flush-in-order-under-a-tenant-lock-before-commit]] bases its finite claim on premise P2: "Only flushes enqueue the three tasks or use lane queues and lane keys." The current code has a second producer of those jobs, so P2 is not true as written.

**What the restamp does.** `runLegacyJobEnvelopeStampMigration` (`backend/packages/data/src/tenancy/legacyJobEnvelopeStampMigration.ts`) runs in one system-scoped managed transaction, under the transaction advisory lock `hashtext('legacyJobEnvelopeStamp')`. In that transaction it:

- selects every queued tenant-task job whose envelope has a `traceId` but no string `tenantId` and that is not permanently failed, in id order;
- removes each through graphile-worker's public `complete_jobs`;
- re-enqueues it inline with `enqueueJob`, inside `runInTenant(soleTenantId)` and the job's own trace, with its original task, key, queue, `run_at` and `max_attempts`.

**How that departs from the flush.**

- The three search tasks are tenant tasks, and the selection does not exclude them.
- A search job queued in a system scope carries a `null` tenant, so it is selected as well.
- These re-enqueues neither register for the pre-commit flush nor take the tenant flush lock.

**When it runs.** `backend/packages/data/src/db/runMigrationsCli.ts` runs the restamp last:

1. the queue bootstrap (`ensureQueueSchema`, `grantQueueSchemaPrivileges`);
2. the tenant cutovers;
3. the item search backfill cutover;
4. the mail enqueues;
5. the heartbeat queue split;
6. the restamp.

`deploy/deploy.sh` runs the migrations (`run_migrations`) before `run_seed`, `verify_tenancy`, promotion and activation. While they run, the previous release's services, and their workers, keep serving.

## Decision

**P2 is narrowed.** Only flushes, and the deploy-time legacy envelope restamp, enqueue the three tasks or use lane queues and lane keys.

**The restamp is outside the claim.**

- The restamp is a current-code exception to the only-flush premise.
- The finite claim covers routine initialized flushes. It says nothing about any wait in which the restamp transaction takes part.
- No same-version cycle on a supported path, and no runtime deadlock, has been shown involving the restamp. Their absence has not been proved either.

**Coordination, not exemption.**

- The restamp's correctness rests on deployment coordination: it runs once per deploy, inside the migration step, before the new release activates, while old-release services may still serve.
- Being outside the claim does not exempt it from correctness. Any later change to its transaction, to its job selection or to the deploy order is a separate decision.

**Nothing else changes.**

- This decision changes no code: no restamp, deploy, queue, pool or producer behaviour.
- No accepted ADR body is edited; the earlier decision stands, corrected by this reference.
- The other limits of that decision stay as they are: old-release inline enqueues during a deploy, concurrent graphile-worker metadata GC, body-phase locks and inline non-search enqueues, and the batched `runOnce` release with queue-less system-scope jobs.
- There is no general safety, readiness or deadlock-freedom theorem.

## Consequences

- The search-flush claim reads with P2 as narrowed here. Evidence that cites P2 names the restamp as an excluded producer.
- Whoever changes the restamp, or deploy ordering around it, has to decide explicitly how its search-lane re-enqueues relate to the flush. Routing them through registration and excluding the search tasks are both possible, and neither is decided here.
- A deploy that restamps legacy search jobs while old-release workers or new flushes run concurrently is coordinated operationally, not covered by the finite claim.
