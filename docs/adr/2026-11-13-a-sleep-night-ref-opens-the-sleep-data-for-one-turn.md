---
status: accepted
date: 2026-11-13
area: [backend]
supersedes: []
superseded-by: null
---

# A sleep night attached to a Semp message opens the sleep data for that one turn

## Context

[[2026-11-13-a-user-attached-ref-grants-one-turn-read-access]] lets an item the user attaches to a Semp message be read
by the run of that turn without a database grant, and leaves one case to its own issue: a ref that names no item. A
night of sleep is such a ref. It is the plan of a wake day merged with an optional exception, computed by
`loadSleepNights`, so the message carries `{ kind: "sleepNight", night }` and no item id. The three sleep databases
(settings, plans, nights) are sensitive ([[2026-11-12-per-database-agent-grants]]), so an agent reads them only under a
grant of its project.

## Decision

**The ref is virtual.** The message endpoint validates the date through the ref schema (`YYYY-MM-DD`, a date that exists)
and checks no row; its dedup identity is `sleepNight:<night>`.

**The turn that attaches a night opens the items the night is computed from.** `openTurnReadAllowances` adds, to the
allowance rows of the item refs (same table, same lifetime, same read-only rule as the ADR above), the live settings
item, every live plan and the live night items of the attached nights (`listSleepNightReadItemIds`). The nights are read
from the persisted refs of the message. A plan is opened as a whole because the plan of a night is chosen among all
plans by the weekday; a night item of another night stays closed.

**The prompt reads the night on the fact of the attachment, not on the rows.** The ref expansion of a waking turn runs
before the run row exists, so it cannot consult the allowance rows (the reason the item refs are read unconditionally).
For a sleep night it must not read unconditionally in every case, because history is expanded again by later turns. The
expander is told whether the refs are those of the turn that is starting (`attachedThisTurn`, set only by the composition
root of the Semp message task, which is the caller that opens the rows for the same refs). It reads a `sleepNight` ref
when that is so, or else when the agent's project (the Semprec project in a chat) holds read access to all three sleep databases (an explicit grant,
checked with `assertAgentDatabaseAccess`, inside the read's transaction). Otherwise the section is
`sleepNight: unavailable (no access).`, nothing from the sleep databases is read, the other refs expand as usual and the
turn goes on.

**The night is resolved in one snapshot.** `loadSleepNights` requires a REPEATABLE READ transaction, so the expander opens
one for a `sleepNight` ref and the context reader refuses another isolation level.

**The expanded text is not stored.** The label captured for the ref is the night itself, not a plan name, so the
expansion puts no content of the sleep databases into the stored context, the task of the run or its events. What the
agent later reads with a tool is stored as the result of that tool, like any other read.

**Alternatives rejected.** Reading the night in the prompt in every case would put sensitive data into the history of a
thread each time a later turn rebuilds it, with no grant and no attachment. Requiring a grant even in the attaching turn
would make the attachment, the user's one deliberate act of showing the night to Semp, do nothing. Checking the allowance
rows from the expander would need the run to exist before the prompt is built.

## Consequences

- A night attached to a message is readable, with the plans and settings it is computed from, in that turn only. In a later
  turn the prompt rebuilt from history shows it only to a project that holds a grant on the sleep databases; the content
  the model already saw stays in the conversation like any other earlier message.
- The run can read the settings, all plans and the night item of the attached night through `item.get`; it cannot read
  the night items of other nights, and cannot write any of them (a write needs a grant, [[2026-11-12-per-database-agent-grants]]).
- A tenant without the sleep module or without its settings item gets the section `sleepNight: no longer exists or is
  unavailable.`
- A caller that expands refs and does not pass `attachedThisTurn` is treated as a later turn. Only the Semp message task
  passes it.
