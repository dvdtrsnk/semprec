---
status: accepted
date: 2026-11-14
area: [backend]
supersedes: []
superseded-by: null
---

# MCP tool classification is owned by the annotation sync until a person sets it

## Context

[[2026-09-10-single-writer-ownership-model]] gives every field exactly one owning process and says a feature that
seems to need a second writer needs an explicit, recorded ownership handoff. Until issue gh-1979,
`mcp_tool_registrations.risk_class` and `requires_approval` had one writer: a person, through `setMcpToolRiskClass` and
`setMcpToolRequiresApproval` in `mcpGrantsAdminStore.ts`, reached by `PATCH /api/mcp-tool-registrations/:id`. The
tool sync never touched them, so every synced tool kept the column defaults (`unclassified`, approval required) until a
person reclassified it. Those two columns decide whether a tool runs without approval, and issue #124 requires that
agents have no write path to them, which is why the person-facing writers are not on the `@semprec/data` public surface.

The MCP `tools/list` response carries annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`). Issue gh-1979
uses them to give a new registration a better default than "unclassified, approval required". That makes the tool sync a
second writer of the two columns, so the handoff between the two writers is decided here.

## Decision

- **A column `classification_source` says who owns the two columns of a registration**: `annotation` or `manual`
  (a text column with a CHECK constraint, default `annotation`). `risk_class` and `requires_approval` always have one
  owner at a time, the one the column names.
- **The sync owns them while the source is `annotation`.** `syncMcpServerTools` derives the class and approval from the
  tool's annotations with `classifyMcpToolFromAnnotations` and writes them with `upsertClassifiedMcpToolRegistration`:
  on insert, and on conflict only for a row whose `classification_source` is `annotation` (a `CASE` in the `DO UPDATE`
  clause keeps the stored value of any other row). A later sync re-derives the classification, so a server that changes a hint changes the default.
- **A person owns them once the source is `manual`, and the transition is one way.** `setMcpToolRiskClass` and
  `setMcpToolRequiresApproval` set `classification_source = 'manual'` in the same statement that writes the value. No
  code sets it back to `annotation`; a `manual` registration keeps both columns through every later sync, while the
  sync still refreshes its schema, description and `active`. Setting only the display label is not a classification
  and leaves the source as it is.
- **Neither writer can overwrite the other's value by interleaving.** The sync's upsert is one
  `INSERT ... ON CONFLICT DO UPDATE` statement under the default READ COMMITTED isolation: it takes the row lock of the
  conflicting row and evaluates its `SET` against the latest committed version of that row. A person's change that
  commits first has made the source `manual`, so the sync keeps the value; one that arrives while the sync's
  transaction holds the row waits for it and then writes its own value and `manual`.
- **The classifying write stays off the public surface.** `@semprec/data` exports `upsertMcpToolRegistration`, which has
  no classification input and copies only the discovery fields, so a caller that reaches it, `agent-runtime`
  included, cannot write the two columns. The classifying variant is `upsertClassifiedMcpToolRegistration`; it is
  reached by its relative path from `mcpSync.ts` and the tests of the data package, as `mcpGrantsAdminStore.ts` is. The
  sync action itself (`syncMcpServerTools`) is exported and is documented as called by a human-facing route or by the
  job a human's confirmation queued.
- **`openWorldHint` counts only when explicitly true.** The MCP default of an absent value is also true; treating it
  as `outbound` would classify nearly every tool that way and make the class meaningless. The mapping is ordered
  (`readOnlyHint` true is `read` without approval; otherwise `destructiveHint` not explicitly false is `destructive`;
  otherwise `openWorldHint` explicitly true is `outbound`; otherwise `write`), and a tool with no `annotations` object
  stays `unclassified` with approval. Because `destructiveHint` defaults to true, an annotations object with no
  `destructiveHint` is `destructive`, including `{ openWorldHint: true }` alone.
- **The migration backfills conservatively and does nothing on a second run.** A row that still holds the defaults
  (`unclassified`, approval required) becomes `annotation`; every other row becomes `manual`, because it may have been
  set by a person and nothing a person set may be lost. The whole change, the backfill included, runs only when the
  column does not exist: a second run would otherwise turn a row that a sync has since derived (`annotation`, not the
  defaults) into `manual`.

## Consequences

- A tool the server advertises as read-only needs no approval from its first sync on. A server that lies in its hints
  gets the default it asks for: annotations are hints and only choose the default, and a person's change through the
  PATCH is final.
- A backfilled `manual` row is never re-derived, including one whose non-default values came from nobody, which
  costs a person one change to opt it into a classification.
- A new writer of the two columns, or a new value of `classification_source`, needs a new decision that narrows this
  one.
