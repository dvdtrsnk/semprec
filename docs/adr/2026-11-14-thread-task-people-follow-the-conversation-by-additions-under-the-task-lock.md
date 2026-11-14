---
status: accepted
date: 2026-11-14
area: [backend]
supersedes: []
superseded-by: null
---

# The people of a thread task follow the conversation by additions, written by a job under the task's lock

## Context

[[2026-11-14-a-task-made-from-a-mail-thread-inherits-its-project-and-people]] gives a task made from a mail thread an
`on` value link for `Tasks.people`, rule key `mailThreadTaskPeople`, with the thread's Threads item as its source, and
the people of the conversation at that time. It leaves the people who join the conversation later to the job of issue
gh-1923. The edges `Emails.senderPeople` and `Emails.recipientsPeople` appear after a message arrived (the heartbeat
action `mail.linkPeopleByEmail`) and for sent mail at its finalization, so a person joins a thread at a different
moment than the message does.

The task's people are `owner: user`; the `valueLinks` process writes them while the link is `on`
([[2026-09-10-single-writer-ownership-model]]). A user's change of the people ends the link
([[2026-11-12-an-agent-write-that-ends-a-value-link-requires-approval]], issue #1516), and that change and the job can
run at the same moment.

## Decision

**A hook queues, a job writes.** A relation edge changed hook ([[2026-09-30-choke-point-domain-hooks-through-a-per-process-registry]])
registered in `domainWriteHooks.ts` reacts to a `create` of an edge of `Emails.senderPeople` or `Emails.recipientsPeople`.
It reads which end is the message and which is the person, finds the Threads item of the message's thread and queues
`mailSyncThreadTaskPeople` with `{ threadItemId, personId }` in the transaction of the edge write, so the job exists
exactly when the edge does. An update or a delete of an edge, an edge of any other relation and a message with no thread
queue nothing. The job is a module task of the mail manifest (`taskNames`, affinity `api`); it opens its transactions on
the pool its composition root binds
([[2026-11-12-module-queue-tasks-read-their-composition-root-dependencies-from-a-binding]]).

**The job key names the tenant, the thread and the person.** `mailSyncThreadTaskPeople:<tenantId>:<threadItemId>:<personId>`,
the tenant read from the producer's scope and never from a payload
([[2026-11-05-value-link-job-keys-include-the-trusted-tenant]]). A key per thread alone would let a second person who
joins the same thread replace the payload of the first one's queued job; a key per person queues one job per person and
collapses only a repeat for the same person. That is the single flight of this job.

**Only additions, and only people of the conversation.** The job adds the person to each task of the thread (through
`Threads.tasks`, in item id order) and never removes anyone: removing an edge, trashing a message or a person leaves the
tasks' people as they are. It adds the person only if they are still one of the people of the thread's conversation as
`createThreadTask` defines them, which leaves out a person in the Trash and a person for whom one of the tenant's own
mailbox addresses is indexed. It adds a person to a task only when the task's `people` link is `on`, has the rule key
`mailThreadTaskPeople` and names this thread's Threads item as a source; a task whose people were changed by hand, a task
with the link of another rule and a task in the Trash are left alone.

**The task is locked, then the link is read under the lock.** For each task the job takes the item row `FOR UPDATE` and then
the link row `FOR UPDATE`, the order of the value-link engine (`linkPropagation.ts`), and decides on the link it read after
both locks. A manual change that has already committed has ended the link and the job sees it. A manual change that is open
holds the item row or the link row, so the job waits for it and then sees the ended link. The job writes the edge as the
`valueLinks` process, which the handoff of the earlier decision requires an `on` link for, and announces one item
invalidation per changed task after the commit.

## Alternatives rejected

- **One job key per thread.** It loses a person when two join before the job runs.
- **Adding the person in the hook's own transaction.** The hook runs inside the write of an edge of the `emails` process,
  inside the mail ingest, and would take the task locks there, so a manual edit of a task could block ingest.
- **Reading the link state in the hook.** The link can end before the job runs; only a read under the task's lock is a
  guard.

## Consequences

- A person is added to a task about one job later than the edge; a failed job is attempted at most three times.
- A repeated write of an existing edge queues the same job again, which finds the person present and writes nothing.
- A task whose `Threads.tasks` edge was moved to another thread is no longer followed: its people link names the thread it was made from, and the job for the new thread leaves it alone.
- The mail module has a queue task, so the API composition root binds its pool (`setThreadTaskPeopleDelivery`).
