---
status: accepted
date: 2026-11-13
area: [backend]
supersedes: []
superseded-by: null
---

# An item the user attaches to a Semp message is readable by the run for that one turn

## Context

[[2026-11-12-per-database-agent-grants]] closes a sensitive database to an agent's project unless the user granted it,
and closes a user-created database the user switched off for the project. A user who attaches a health record or a
sleep night to a message to Semp has shown Semp that one object. Without an exception the agent would be handed the
object in the prompt and refused when it reads the same item through its tools, or it would need a standing grant for
the whole database to look at one record.

The exception is an authorization boundary crossed without a grant, so its extent has to be exact: one turn, the items
the user attached, read only. The refs of a message are validated and stored when it is sent (`semp_messages.context`,
issue #1682) and expanded into the turn's prompt by `semprec-agents` (issue #1733).

## Decision

**An allowance is a row, created for one turn and deleted when the turn settles.** The table
`agent_run_read_allowances` holds one row per tenant, agent run and item id. The ids are those of the `item`, `block`
and `transcriptSegment` refs of the message of the turn, read from the persisted refs, never from a tool argument, a
request or a model output. Other refs open no item. A ref without an item id (a sleep night) is delivered by its own
issue with the same table.

**The turn's composition root owns the lifecycle.** In `semprec-agents`, the `onTurnStart` hook of a Semp turn (awaited
after the turn's run exists and before the model is prompted further) deletes whatever the run still holds and inserts
the allowances, in the transaction that records the turn's start.
The hook is the first point at which the run's id exists for a waking turn, and no tool can run before it returns.
Whether the turn succeeds, fails or is cancelled, its rows are deleted: after the model turn returns, before the message
is completed, and in the error path, before the error state is stored. A cleanup that fails is not swallowed: after a
successful model turn it fails the turn, and after a failed turn it is reported together with the turn's error once
the error state is stored. A process that dies between start and end leaves its rows; the next turn of the same run
deletes them at its start. A row left for a run that no turn continues does nothing unless a call authenticated as that
run reads that item.

**The access check honors the allowance for a read of that item only.** `assertAgentDatabaseAccess` accepts an optional
`readAllowance` (run id and item id). When the project's access to the item's database refuses a `read` and the run
holds an allowance for that item, the read passes; the allowance row is looked up, and locked `FOR SHARE`, in the
transaction of the read, only after the project's access refused. It is never consulted for a `write`. A write of the
attached item, a query or list of its database, its relation list and its delete stay governed by the grants. The
caller of the check supplies the run id from the run credential, as it does the project; today that is `item.get`
(`findItem`), the path by which an agent reads one item by id.

**Related items are not opened.** The attached item is read in full, and the relation targets in databases the project
cannot read come back as `{ id, hidden: true }`, as for every agent read ([[2026-11-12-per-database-agent-grants]]).
The ref expansion builds the prompt before the run row of a waking turn exists, so it cannot use the run's rows; it
reads the referenced item because the user attached it and leaves out the names of related items in databases the
Semp project cannot read, listing them as `{ id, hidden: true }`. The same expander rebuilds the history of a thread
for a new run with the same rule, in every branch that names relations (an item, a task trace, a task occurrence).
The value links of a read go by the same rule: `item.get`, `database.query` and `view.query` with `include` links leave a
link source item in a database the project cannot read out of the entry, so its id, database key and title are not
returned. Derived values name only projects, areas and companies, system databases that are open to every project.

**The lock is a share lock on the allowance row.** The delete at the end of the turn waits for a read that passed on
the row, and a read that starts after the delete commits finds no row. Where the read found the project's own access
sufficient, no allowance row is looked up and nothing is locked.

**Alternatives rejected.** An allowance per run and thread would keep the item readable in later turns, against the
decision that scope is the turn that carries the ref. Passing the attached ids with the tool call would let a model
output name what is readable. A standing database grant for the attached item's database would open the rest of it.

## Consequences

- The attached item is readable by the run only while its turn runs. A later turn without the ref is refused again; the
  content the model already saw stays in the conversation like any other earlier message.
- The check has one more input and one more lookup, on the refused path only. Another path that reads one item by id for
  an agent passes the run id to the same check to honor the allowance; one that does not stays closed.
- The table carries no foreign key to the item (`items` is partitioned). A row for an item purged during the turn is
  deleted with the others when the turn ends.
- External AI clients on a human token on `/mcp` carry no run and get no allowance from a Semp chat.
