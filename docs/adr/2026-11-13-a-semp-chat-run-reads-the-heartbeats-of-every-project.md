---
status: accepted
date: 2026-11-13
area: [backend]
supersedes: []
superseded-by: null
---

# A Semp chat run reads the heartbeats of every project, minus those of a project with a sensitive grant it lacks

## Context

`heartbeat.list` and `heartbeat.history` derived their project only from the persisted `agent_runs.project_item_id` of
the calling run and took no project id, so a run could read the heartbeats of its own project alone
([[2026-11-04-owned-databases-admit-safe-module-agent-tools]]). [[2026-11-04-mcp-exposes-module-agent-tools]] left the
heartbeat visibility work of issue #2018 out of its bounded implementation. Chat is the general place for questions
("what does my weekly journal cleanup do?"), and a Semp chat run belongs to the system project Semprec, so under the
own-project rule it can never see the heartbeats of the project the user asks about.

The results of a heartbeat's runs can quote the data its project may read. [[2026-11-12-per-database-agent-grants]]
keeps a project's agent out of a sensitive database by checking each read of that database. A heartbeat history is not
such a read: it returns the text of another project's finished runs, so a widened scope needs its own rule or it leaks
what the grants close.

## Decision

**The read scope is derived from persisted rows, never from tool arguments.** `resolveHeartbeatReadScope`
(`heartbeatAgentTools.ts`) reads the calling run: when `agent_runs.thread_id` points at a Semp thread of kind `chat`,
the scope is `tenant`; every other run (no thread, an `item` or `tick` thread, a heartbeat run) keeps `project`, the
run's own project. A delegated run inherits the thread at creation, so it has the scope of its parent. A run without a
project reads nothing.

**In the `tenant` scope `heartbeat.list` returns every heartbeat of the tenant's projects**, each entry with
`projectItemId` and `projectName`, and `heartbeat.history` accepts the heartbeat id of any project in scope. Tenant
isolation is the row-level security of `project_heartbeats`, as for the own-project reads.

**A heartbeat is left out when its project holds a grant the caller's project lacks.** The condition is
`SENSITIVE_PROJECT_HEARTBEAT_EXCLUSION` in `schedulerStore.ts`, evaluated in the same statement as the read. It
compares projects, not one database against one project:

- only an `agent_database_grants` row of access `read` or `write` on a database flagged `sensitive` counts as a grant
  of the heartbeat's project; a grant on a database that is not sensitive does not exclude anything;
- a `none` row is a refusal, so it is no grant on either side: it neither excludes a heartbeat nor lets the caller
  through;
- the heartbeat stays visible when the calling project holds a `read` or `write` grant on every such database; a
  project is never excluded from itself;
- a heartbeat id outside the scope (unknown, of another tenant, excluded) gives the same `null`, from one statement,
  and the same not-found error, so the tool is no oracle for what exists.

**`heartbeat.trigger` stays limited to the run's own project** for every run, chat runs included: it starts work and
writes, and reading across projects does not make a chat run the owner of another project's automation.

## Consequences

- A tool that widens what a chat run reads beyond its project (journal, mail, other runs' results) does not inherit
  this rule by default. It decides whether to reuse the project-to-project exclusion above or the per-database check of
  [[2026-11-12-per-database-agent-grants]], and records that decision.
- The exclusion is coarser than the per-database check: a project with a sensitive grant hides all its heartbeats from a
  chat run that lacks the same grant, even a heartbeat that never touched the sensitive database. That is the safe
  direction, since the history text cannot be filtered by database.
- This delivers the gh-2018 item that [[2026-11-04-mcp-exposes-module-agent-tools]] marked as not included. The
  bodies of the earlier decisions stay as they were written.
