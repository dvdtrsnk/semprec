---
status: accepted
date: 2026-11-14
area: [backend]
supersedes: []
superseded-by: null
---

# MCP tool label suggestions fill only empty display labels

## Context

`mcp_tool_registrations.display_label` is a user-owned field: the only write
path that sets it is the user-initiated mutation `setMcpToolDisplayLabel`, and
the sync upsert never touches it. [[2026-09-10-single-writer-ownership-model]]
makes a second writer of such a field a bug unless the handoff is recorded.

Issue gh-1983 has the model propose a Czech and an English label for the tools
a sync registered, because a project's tool list is much more useful with a
short human label than without one. Waiting for a person to write every label
by hand leaves most tools unlabeled. The model call goes through the AI
gateway ([[2026-09-10-ai-gateway-monopoly-on-provider-calls]]) and cannot run
inside a database transaction
([[2026-09-10-bracket-non-transactional-calls-with-staleness-checked-transactions]]).

## Decision

`display_label` stays user-owned. `suggestMcpToolLabels`
(`mcpToolLabelSuggestion.ts`) is the one automated writer, and the handoff is
bounded:

- It writes a suggestion only where `display_label IS NULL`, and the condition
  is part of each `UPDATE` (`WHERE id = $1 AND display_label IS NULL`), so a
  label a person set while the model call was running, or any earlier label,
  is never overwritten. It never replaces, regenerates or clears a stored
  label.
- It writes only a `{cs, en}` pair where both languages came back as valid
  plain text for a tool that was asked about, never one language alone.
- The model call runs outside any transaction. The read of the unlabeled tools
  and the write of the labels are two separate transactions, and the write
  re-checks its own condition.
- The suggestion runs after a sync that succeeded and never fails it: a
  refusal, timeout or invalid answer leaves the labels empty.
- A person remains free to change or clear a suggested label afterwards with
  `setMcpToolDisplayLabel`; a cleared label can then be suggested again by a
  later sync.

A later change that adds another automated writer of `display_label`, or makes
this write overwrite, needs its own ADR.

## Consequences

A person's label always wins, whenever it was written. A tool the model could
not label stays empty and is asked about again by the next sync. The cost is a
second writer of a user-owned column that readers of the user-only mutations
must know about, which is why the docstrings of `mcpToolRegistrationsStore.ts`,
`mcpGrantsAdminStore.ts` and `mcpToolLabelSuggestion.ts` point here. Giving the
suggestion its own column with a fallback at read time was considered and
rejected: it duplicates the field and makes every consumer resolve two values.
