---
status: accepted
date: 2026-11-14
area: [backend]
supersedes: []
superseded-by: null
---

# A task made from a mail thread inherits the thread's project by a link rule and gets the conversation's people as an inherited value

## Context

A user creates a task from a mail thread (`POST /api/mail/threads/:threadId/tasks`, issue gh-1900). The task is
connected to the thread by the relation `Threads.tasks`. It should take over the thread's project, follow it until a
user or Semp changes it, and start with the people of the conversation, which a manual change must also end following.
Semp creates such a task through a proposal that the same transactional function writes when it is confirmed
(issues #2035 and #2034), so the creation is one function and not a property of the route.

`Tasks.project` and `Tasks.people` are `owner: user`. [[2026-09-10-single-writer-ownership-model]] requires an
explicit ownership handoff before a second process writes a field.
[[2026-11-11-action-item-tasks-inherit-project-and-people-by-link-rules]] made that handoff for two rules whose source
is an Event, and names those rules. [[2026-11-10-transcript-values-are-inherited-by-link-rules-whichever-process-writes-the-edge]]
made it for three Transcripts relations. Neither covers a rule whose source is a Threads item.

The people of a conversation are not a property of the Threads item. They are the people of the thread's messages, which
`Emails.senderPeople` and `Emails.recipientsPeople` hold, and those edges appear at different times after the
messages arrive, so no link rule over a Threads property can compute them.

A task without a name is named by a model, which cannot run inside the database transaction that writes the task.
[[2026-09-10-bracket-non-transactional-calls-with-staleness-checked-transactions]] decides that shape for a non-transactional
call; it does not say what the check is for a mail thread, whose messages other writers add and trash.

## Decision

**The project is a link rule.** The mail module's manifest declares `taskProjectFromThread`: `Threads.project` to
`Tasks.project`, via `Threads.tasks`. It runs in the transaction that writes the `Threads.tasks` edge
(`valueLinks/linkRuleEdgeHook.ts`), so the task is created with the thread's project and a later change of the thread's
project reaches the task through the `valueLinksPropagate` job. The link is written also while the thread has no
project, so that a project it gets later is inherited. Ownership handoff: `Tasks.project` stays `owner: user`, and the
`valueLinks` process writes it only while the task's link for that property is `on`.

**The people are an inherited value without a rule.** `createThreadTask` (`mail/threadTasks.ts`) inserts the `on` link of
`Tasks.people` with the thread's Threads item as its source and the rule key `mailThreadTaskPeople`, and then writes
one edge to each person of the conversation as the `valueLinks` process. No link rule has that key, so the engine
recomputes nothing for it: the job of issue #1923 adds people who join the conversation later, for a task whose people
link is still `on`. The link is written also when the conversation has no person, for the same reason as the project's.
The source property `people` does not exist on Threads, so the link records provenance only. A user's unlink ends it as
for any link. A relink of it is refused with the 409 `value_link_conflict` (`changeValueLinkWithClient` computes nothing
from a source property that is missing, for every link), and the task's people stay as they are; without that refusal the
relink would read the missing property as an empty value and delete every person of the task.
The people are the live People items that the live messages link through `senderPeople` or `recipientsPeople`, without a
person for whom one of the tenant's own mailbox addresses is indexed. Ownership handoff as above, for `Tasks.people`.

**The write is one function.** `createThreadTask` takes the thread's Threads item, the name, the optional date and the
writer, and writes the Tasks item, the `Threads.tasks` edge and the two links in the caller's transaction. A user's or
Semp's later change of the task's project or people ends that property's link ([[2026-11-12-an-agent-write-that-ends-a-value-link-requires-approval]]
and issue #1516 apply as for any link).

**The name is bracketed.** Without a `name` the route reads the thread's snapshot (the Emails items of its live messages
and their text) in a REPEATABLE READ transaction, asks the gateway outside any transaction, and writes in a READ COMMITTED
transaction that first takes the mail thread guard ([[2026-11-13-mail-thread-actions-take-the-thread-guard-before-their-item-locks]])
and locks the Emails items of the live messages `FOR SHARE`, in item id order. The write answers 409 `conflict` when the
thread, or the set of those items, differs from the snapshot. The guard keeps out every writer that adds a message to a
thread ([[2026-11-01-mail-thread-mutations-use-a-tenant-transaction-guard]]); the row locks keep a trash of one of the
messages, which takes no guard, out until the write commits. A message's text that changes without a message arriving or
being trashed is not detected: the name is made from the text the snapshot saw.

**The gateway operation** is `mail_thread_task_name`, with no project, registered in `semprec-ai-gateway`'s
`completeHandler.ts`. The route has the gateway client from the composition root's `CustomRouteDependencies.aiGateway`
([[2026-10-29-custom-route-composition-root-dependencies]]). The gateway's budget refusal is a 403 `budget_exceeded`,
the code the gateway's own route and the speech route answer; any other `AiGatewayFailedError` is a 502
`upstream_unavailable` that names only its reason. No task exists after either.

## Alternatives rejected

- **A custom route that copies the project and the people.** The copy follows nothing, so a later change of the thread's
  project would not reach the task and the user's change would not end anything.
- **A link rule for the people.** No Threads property holds them, and a rule over `Emails.senderPeople` cannot name the
  task through one `via` relation.
- **One transaction around the model call.** It would hold the thread guard, which every reconcile pass of the tenant
  waits for, and its row locks for the model's latency.
- **A check by the thread's `updatedAt` or a count.** The Threads item changes for reasons unrelated to its messages,
  and a count misses a delete paired with an arrival.

## Consequences

- A thread task whose thread has a project is created with that project as a value; the project's link is `on`. A
  thread holds at most one project (`threadValueEdgeWriteHook` refuses a second one for every writer), so the task's
  project is the thread's until a user or Semp changes it.
- The people link of a thread task can be unlinked but not relinked: a relink answers `value_link_conflict` and keeps the
  task's people.
- `Tasks.project` can have a link of another rule (`taskProjectFromEvent`) or of this one, never both: the engine skips
  an edge whose property already has a link of another rule.
- A request waits behind a running reconcile pass of its tenant, as every thread action does, for the transaction that
  checks and writes, not for the model.
- A task is not idempotent: a repeated request creates another task.
- Nothing is backfilled: tasks that were linked to a thread before this rule got no link.
- The route needs `AI_GATEWAY_INTERNAL_TOKEN` as the queue runtime of the same process does; a mount without
  `aiGateway` fails a nameless request with a configuration error and still creates named tasks.
