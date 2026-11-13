---
status: accepted
date: 2026-11-12
area: [backend]
supersedes: []
superseded-by: null
---

# A module queue task reads its composition-root dependencies from a binding the runtime sets

## Context

[[2026-09-19-task-queue-affinity-routing]] lets a module declare a queue task in `taskNames`. The module registry
resolves `handlerExport` to a function exported by the manifest module, and `mergeModuleTaskListForAffinity`
(`packages/data/src/moduleTasks.ts`) calls it as `handler(parsedPayload, helpers)`, where `helpers` are the
graphile-worker job helpers. The handler gets no database pool and nothing else the composition root owns.

[[2026-10-29-custom-route-composition-root-dependencies]] solved the same problem for custom routes, which are
factories called once per mount with the pool and a typed dependency container. A task handler is not a factory and
the registry calls it directly, so that mechanism does not reach it.

No module task needed a dependency until the calendar's `calendarSendEventInvitation` (issue #1774). It sends mail
through a `MailTransportFactory` that needs the pool and the Gmail and Microsoft OAuth client keys, and it reads and
writes the tenant's rows through the pool. Issue #1953 will add a second task with the same needs.

## Decision

A module that has a task with composition-root dependencies exports a binding next to the handler:

- The module keeps one module-scoped variable of its dependency type, initially `null`, and exports
  `set<Name>Delivery(next | null)`, re-exported from `@semprec/data`. The calendar's is
  `setEventInvitationDelivery` in `packages/data/src/calendar/eventInvitationJob.ts`, with `{ pool, transports }`.
- The handler reads the variable when the job runs. With none bound it throws a plain `Error`, so the queue retries the
  job; it does not choose a default.
- The runtime that hosts the task's affinity binds the dependencies before it starts its runner and unbinds them with
  `null` when its runner stops or fails to start. `createApiQueueRuntime` does this for `queueAffinity: "api"`.
- The variable is per process, like the hook registries of
  [[2026-09-30-choke-point-domain-hooks-through-a-per-process-registry]]. A process that runs two queue runtimes of the
  same affinity shares one binding: the last one bound wins, and the first one to stop clears it for both. Production
  runs one API queue runtime per process. Tests that call the handler bind what they need and unbind it after.

The tenant does not travel through the binding. The job runs in the tenant scope of its envelope
([[2026-10-05-tenant-scope-propagation]]) and every query the handler makes through the bound pool runs in that scope.

## Consequences

- A manifest task handler can use the pool and the runtime's adapters without a change to `moduleTasks.ts` or to the
  registry.
- A deployment whose runtime does not bind the dependencies fails each such job with a retried plain error, visible in
  the failed-jobs count, and does not lose it.
- The binding is mutable process state. It is set once at startup and cleared at shutdown; a task handler must not set
  it.
- A later change may give task handlers a dependency container like [[2026-10-29-custom-route-composition-root-dependencies]]
  gave routes. That would replace the binding of each module that uses one, by a new decision.
