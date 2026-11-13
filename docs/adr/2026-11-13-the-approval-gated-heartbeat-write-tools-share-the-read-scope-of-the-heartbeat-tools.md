---
status: accepted
date: 2026-11-13
area: [backend]
supersedes: []
superseded-by: null
---

# The approval-gated heartbeat write tools share the read scope of the heartbeat tools

## Context

[[2026-11-13-a-semp-chat-run-reads-the-heartbeats-of-every-project]] lets a Semp chat run read the heartbeats of every
project of its tenant, minus those of a project with a sensitive grant the chat project lacks, and keeps
`heartbeat.trigger` limited to the run's own project because it "writes and reading across projects does not make a
chat run the owner of another project's automation". It also requires a tool that widens what a chat run reaches to
decide which exclusion it reuses, and to record that decision.

Issue gh-1846 adds `heartbeat.create`, `heartbeat.update` and `heartbeat.setEnabled`. They write, and the issue says
`projectItemId` "can be any project of the tenant (chat runs on the Semprec project)". Unlike `heartbeat.trigger`
([[2026-11-04-owned-databases-admit-safe-module-agent-tools]]), which fires an already configured automation at once,
each of them runs only after a person approved a `moduleTool` request
([[2026-11-12-module-agent-tools-that-require-approval-run-through-a-moduletool-request]]) and only if the automation
or project is unchanged since the request.

## Decision

1. **The three write tools use the scope of `heartbeat.list` and `heartbeat.history`.** The scope is derived from the
   persisted run (`resolveHeartbeatReadScope`), never from arguments: a run on a Semp thread of kind `chat` has the
   `tenant` scope, every other run the `project` scope. In the `project` scope a tool reaches only automations of the
   run's own project and creates only in it. In the `tenant` scope `heartbeat.update` and `heartbeat.setEnabled` reach
   exactly the automations `heartbeat.list` returns (`findHeartbeatInScope`).
2. **`heartbeat.create` applies the same sensitive-grant exclusion to the target project.** A chat run may create an
   automation only in a project whose heartbeats it could read: `isProjectReachableByChatRun` evaluates
   `SENSITIVE_PROJECT_HEARTBEAT_EXCLUSION` for the target project against the run's project
   (`requireProjectInRunScope`). A project the exclusion leaves out answers `Project <id> not found`, like a project
   that does not exist. Without this, a chat run that lacks a sensitive grant could direct an agent that holds it: the
   task text of the new automation runs with the target project's grants and its results land in a thread the chat run
   can no longer read.
3. **The rule is checked three times and the answer is the same each time**: when the snapshot is read (no request is
   created), when the description is built (no request is created for a caller that skipped the snapshot) and when the
   handler runs.
4. **`heartbeat.trigger` stays limited to the run's own project.** It is not approval-gated and acts at once, so
   the approval, the description the person reads and the snapshot comparison, which justify reaching another
   project's automations, do not exist for it. The reasoning of the 2026-11-13 record about the owner of another
   project's automation is narrowed here only for tools that cannot run without an approval; it still holds for a tool
   that writes without one.
5. **A system automation is out of reach of all three tools in every scope** (`origin = 'user'` is required), as the
   issue states.

## Consequences

- The next approval-gated write tool that widens a chat run's reach decides whether it reuses this scope and the
  exclusion, and records it, as 2026-11-13 requires. Absent a record, it keeps the own-project scope.
- A person who approves a request from a chat run sees the project name in the description
  ([[2026-11-13-a-heartbeat-write-tool-approval-shows-what-it-will-write]]), which is what makes the wider scope
  acceptable.
- The check at request time and the check at execution are not one atomic step: a grant added to the target project
  between them is not seen by the create handler. The snapshot compares the project's existence only. This is the
  window the `moduleTool` decision already names, and the next request of the chat run is refused.
- The bodies of 2026-11-13 and 2026-11-04 stay as written.
