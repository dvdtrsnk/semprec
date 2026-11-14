---
status: accepted
date: 2026-11-14
area: [backend]
supersedes: []
superseded-by: null
---

# A queue task may write a user-owned relation edge as an agent with no run

## Context

[[2026-09-10-agent-writes-are-proposals-not-direct-writes]] makes agent-originated changes proposals. [[2026-09-18-non-destructive-generic-operations-bypass-agent-approval]] exempts the non-destructive operations of the generic-operation catalog, and ends with the rule that a write path outside that catalog needs its own decision record. [[2026-11-04-flagged-agent-writes-require-approval]] and [[2026-11-12-an-agent-write-that-ends-a-value-link-requires-approval]] defer a flagged write only for an agent with a run (`agentRunId`) and describe a run-less agent write only as an `/mcp` call with a human session.

The task `mailTriageThreadProject` (`mail/threadProjectTriage.ts`, issue gh-1872) is a fourth shape: a module queue task, not a gateway call, that asks the AI gateway which project an unlinked mail thread belongs to and writes the answer as the thread's own `Threads.project` edge. The property stays user-owned ([[2026-09-10-single-writer-ownership-model]]), so the write is not a system job that owns the property; it is made as `{ writerKind: "agent" }` with no `agentRunId`, no `agentProjectItemId` and no `onBehalfOfUserId`, through the relation write of the choke point. Nothing recorded whether that identity needs approval, what it may never carry, or how a later flagged case treats it.

## Decision

A queue task may write one relation edge of a user-owned property through the choke point as an agent writer with no run and no project, under these conditions:

- **The write is one reversible relation put.** It inserts one edge, deletes nothing and replaces nothing. The user removes or replaces the edge with an ordinary write, so the write is non-destructive in the sense of [[2026-09-18-non-destructive-generic-operations-bypass-agent-approval]], and a queue task that makes it is executed directly, without an approval request. This record, not the 2026-09-18 one, is the decision for that path; it does not extend to any other write of such an identity.
- **It never ends a value link.** The task writes only after it re-read, under the mail thread guard ([[2026-11-01-mail-thread-mutations-use-a-tenant-transaction-guard]]) and the lock of the item, that the thread holds no edge and no link row (of any state) for the property, and it drops the result otherwise ([[2026-09-10-bracket-non-transactional-calls-with-staleness-checked-transactions]]). With no link on the property there is no link to end. A write of this identity that could end a link is not covered by this record.
- **It never carries permission to send mail autonomously.** `emailSendAutonomous` and every other agent permission is a property of the agent's project; this identity has no project, so it holds none, and nothing in the task may give it one. The assignment of a project to a thread grants nothing else.
- **It carries no database grant.** The identity has no project, so the per-database grant check does not apply to it; the task is therefore confined in code to its one edge and must not be reused to write any other property.

How later flagged cases treat the identity: the deferral of [[2026-11-04-flagged-agent-writes-require-approval]] needs an `agentRunId`, so this identity is never deferred, and the link-ending case of [[2026-11-12-an-agent-write-that-ends-a-value-link-requires-approval]] would pass it and end the link with `broken_by` agent. That must not happen through this identity. A job that can write onto a linked property is not allowed to use it: it either runs as an agent with a run, so that its write is deferred, or it is refused. Another queue task (a calendar or a task triage) that wants the same treatment records, in its own ADR or by naming this one, that its write is one reversible edge or value put guarded by the same pre-check.

## Consequences

- `SEMP_WRITER` in `threadProjectTriage.ts` is the only anonymous agent identity in the module tasks, and its file header cites this record.
- The pre-check under the lock is part of the decision, not an optimisation: removing it, or writing without it, makes the identity able to end a link without anyone being asked.
- A future flagged write case is reviewed against this record for the identity: a case that a run-less agent can reach must either be unreachable from the task or be handled in the task before the write.
- Rejected: a system writer. The property is user-owned, so a system write would break the single-writer ownership model or need a second owner for the property. Rejected: an agent with a run for each triage. A run, a project and a credential exist to ask a person, and this task asks nobody; creating them only to satisfy the identity shape would record runs that never happened.
