---
status: accepted
date: 2026-10-28
area: [backend]
supersedes: []
superseded-by: null
---

# Semp thread turns run on a per-tenant chat lane

## Context

Every message a user sends in a Semp chat must get its own reply. There is no "busy" rejection, a user
may write in another thread while one is still being answered, and automatic ticks must not block chat.

Facts about the queue today:

- `backend/packages/queue/src/index.ts` closes the agents runtime's task catalog in `AGENT_TASK_NAMES`
  (`heartbeatFireAgent`, `agentRun`, `delegatedAgentRun`). `EnqueueJobOptions` has `jobKey`,
  `jobKeyMode`, `maxAttempts`, `runAt` and `queueName`, and no priority.
- A worker process runs 4 jobs at once (`QUEUE_CONCURRENCY`).
- [[2026-10-08-per-tenant-queue-lanes]] serializes work on a `<lane>:<tenantId>` queue named by
  `tenantLane()` (`backend/packages/data/src/tenancy/tenantLane.ts`). Heartbeat agent fires already run
  on their own `agent-run:<tenantId>` lane (`resolveAgentRunLane` in
  `backend/packages/data/src/scheduler/actions.ts`).
- A process that stops without a graceful stop leaves a queue's lock held until graphile-worker treats
  it as stale (4 hours). The number of queues a design creates therefore also decides how much recovery
  work a crash can leave behind.

The `sempMessage` task (#1727) runs one thread turn and needs to know which queue it is enqueued on.

This ADR does not supersede [[2026-10-08-per-tenant-queue-lanes]]. It adds one lane to the lanes that
ADR describes; that ADR stays as written, and `supersedes` is therefore empty.

## Decision

Semp thread turns are serialized per tenant on one lane, `tenantLane('semp-chat')`.

- A `sempMessage` job is enqueued with `queueName = tenantLane('semp-chat')`. The queue is FIFO per
  tenant: within a tenant the order of the queue is the order of the sent messages.
- Tick lanes (including `agent-run:<tenantId>`) are untouched, so a long tick never holds back chat and
  chat never holds back ticks.
- Outside a tenant scope no `sempMessage` job can be enqueued. `tenantLane` returns `undefined` there,
  and the producer throws instead of falling back to an unnamed queue, because an unnamed queue would run
  turns of one tenant in parallel and break ordering.

### Retry policy

A `sempMessage` job is enqueued with `maxAttempts: 1` and `jobKeyMode: 'unsafe_dedupe'`, keyed per
assistant message. A repeated attempt would repeat tool writes, and a replacing re-enqueue would start a
second run beside a running one. Retrying a failed reply is a manual user action, not a queue retry.

### User-visible consequence

Threads of one tenant answer in sending order, one after the other. Different tenants, and ticks, do not
wait on each other.

## Consequences

- Two threads of the same tenant never answer in parallel. This is the accepted cost of the choice.
- No new queue per thread, no per-tenant cap and no cleanup of empty queues are needed, and several
  threads of one tenant cannot fill every slot of a process.
- The lane lock left by a killed process (4 hours) is handled by the recovery issue #1732.
- Reserving worker capacity for chat is handled by #1755.
- The turn task itself is #1727.

## Rejected alternatives

- **One queue per thread (`semp-thread:<threadId>`).** It gives one tenant more parallelism, but needs a
  per-tenant cap mechanism, cleanup of empty graphile_worker queues and a larger crash-recovery surface
  (one stale lock per thread). It can be adopted later by a superseding ADR that narrows this one.
- **No queue name.** Turns of one tenant would run in parallel without bound and replies would be
  unordered.
- **The tick lane.** A long tick would block chat.
