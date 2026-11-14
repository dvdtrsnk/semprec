---
status: accepted
date: 2026-11-14
area: [backend]
supersedes: []
superseded-by: null
---

# A heartbeat agent run takes composition-root dependencies and may run in the project of its item

## Context

The `newEmail` heartbeat of issue gh-1941 prepares a reply draft when a known person writes and expects an answer. Its action
`core.agentRun` (`scheduler/actions.ts`) needs two things that no earlier heartbeat needed. It must ask the AI gateway whether
the message expects an answer, which is a model call that [[2026-09-10-ai-gateway-monopoly-on-provider-calls]] allows only
through the gateway client of the process, and it must start the run in the project of the message's thread, which only the
mail module can resolve. `coreAgentRunAction` cannot import the mail module: the choke point imports `scheduler/actions.ts`
for the action types, and the mail module imports the choke point, so an import would close the cycle that the rule
`no-choke-point-rollup-cycle` forbids.

[[2026-10-29-custom-route-composition-root-dependencies]] and
[[2026-11-12-module-queue-tasks-read-their-composition-root-dependencies-from-a-binding]] solve the same shape for custom routes
and for module queue tasks. Neither reaches a heartbeat action, which is built by `createActionRegistry` in the composition
root of the agents process.

## Decision

1. **A heartbeat action receives composition-root dependencies as a third argument.** `coreAgentRunAction(pool, runAgent,
dependencies)` takes `CoreAgentRunDependencies`: the gate of its `answerExpectedFilter` config key and a table of run project
   resolvers by name. The composition root of `semprec-agents` builds them (`createNewEmailAgentRunDependencies`, which imports
   the mail module) and passes the gateway client of the process. A heartbeat whose config names a resolver or turns the gate on
   while the composition root provides none is refused with an error before anything is asked or written, so a misconfigured
   process cannot run the action without its gate.
2. **A `runProject` config moves an item-triggered run to another project.** `runProject: { resolver }` names a resolver that
   answers, for the fired item, the id of the project the run starts in; the heartbeat's own project is the answer when the
   resolver has none. The `agent_runs` row and the agent session belong to that project, so the run holds the tools that
   project is granted. The tick thread and the heartbeat's occurrence stay the heartbeat's. A retry of a failed run
   (`context.retryOfRunId`) is created from the retried run and keeps its project and task; the resolver's answer is not used
   for it. The resolver of the `newEmail` heartbeat, `mailThreadProject`, answers the live project in `Threads.project` of the
   message's thread.
3. **The mail tools are present only when the thread's project holds the mail capabilities.** The mail agent tools are granted
   to a project that owns the mail databases ([[2026-10-28-module-agent-tools-approval-and-grants]]). A run in a thread's
   ordinary project is therefore offered no `mail.*` tool, prepares no draft and raises no error, until a project can be
   granted a database it does not own (issue #1810). This is accepted for v1: the issue decides that a thread with a project
   runs in that project, and the alternative below would contradict it. A test composes the real tool list of such a run.
4. **The answer-expected gate decides without an error row.** It follows
   [[2026-09-10-bracket-non-transactional-calls-with-staleness-checked-transactions]]: a read transaction plans the run, the
   gateway is asked outside any transaction, and a second read transaction plans again. No run starts, and nothing is written
   or raised, for an answer of `expectsReply: false`, for an answer that does not fit its schema (the gateway's
   `invalid_response` included), and for an exhausted tenant budget (`budget_exceeded`): these are decisions that no draft is
   wanted, and a notification per newsletter would be noise. Any other gateway failure (a timeout, a non-success answer) is not
   a decision: it propagates, and the queue runs the fire job again. The gate only avoids useless work. A draft a person edited
   is protected by `mail.draft.update` itself, which refuses a run started by a heartbeat a draft whose last editor is the user,
   under the draft's locks.

## Alternatives considered

- **Importing the mail module in `scheduler/actions.ts`.** Closes the import cycle named above.
- **A per-process binding set by the runtime, as for module queue tasks.** A heartbeat action is a value built by the
  registry, not a handler the registry resolves by name, so an argument at construction is plain and testable; a module
  variable would hide the dependency from the tests.
- **Answering a thread's project only when it holds the mail capabilities, otherwise the heartbeat's project.** Prepares a
  draft in every case, but moves the run away from the project the owner chose for the thread and contradicts the issue's
  decision. Left to the issue that grants per-database access to projects (#1810).

## Consequences

- A second heartbeat action that needs a model call or a module's resolver takes the same argument and adds a member; the
  members stay optional, and a config that needs a missing one is refused.
- Until #1810, a thread assigned to an ordinary project gets no automatic reply draft. The user sees none and no error.
- A budget refusal is silent here, and the budget's own announcement ([[2026-11-13-the-gateway-announces-a-tenants-first-budget-refusal-of-a-window]]) is what tells the user.
