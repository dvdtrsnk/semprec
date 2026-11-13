---
status: accepted
date: 2026-11-13
area: [backend]
supersedes: []
superseded-by: null
---

# An item linked to a sensitive record inherits its sensitivity for an agent

## Context

[[2026-11-12-per-database-agent-grants]] decides an agent project's access to a database, and `databases.sensitive`
closes a database to a project that holds no grant on it. Data about a sensitive record also lives outside the sensitive
databases: a file attached to a health record (the Files to Health records relation), the transcript of a doctor's
visit, an Inbox entry about it. Those items sit in the Files, Transcripts and Inbox databases, which are open to a
project by default, so an agent read them in full without any grant. The product owner decided that the sensitivity
follows the link, not the content: Transcripts and Inbox entries are not classified by what they say.

## Decision

**An item of a sensitivity-inheriting database that has a relation edge to an item of a sensitive database is treated as
sensitive.** The inheriting databases are the system databases whose `owner_module_id` is in
`SENSITIVITY_INHERITING_MODULE_IDS` (`files`, `transcripts`, `inbox`, next to `SENSITIVE_DATABASE_KEYS`). A user-created
database never inherits, whatever module id it carries. A link is a row of `item_relations` in either direction, whatever
relation property it belongs to, whose other endpoint is not soft-deleted. The item asked about is not filtered by
`deleted_at`, so a file in the trash stays as sensitive as it was. The rule is not transitive: an item linked to an
inheriting item that is itself linked to a sensitive record is not sensitive.

**The agent needs the requested access on every sensitive database the item is linked to.** `sensitiveSourceDatabaseIds`
(`agentGrants/inheritedSensitivity.ts`) returns those databases in one query. `assertAgentDatabaseAccess` takes an
optional `itemId` and, after the item's own database passed, reads the decisions of all the linked databases in one
statement, locks their rows `FOR SHARE` as the point check does, and refuses with the `ForbiddenError` of the database
check (`forbidden`, 403) when any of them is below the requested access. `read` needs `read` on each, `write` needs
`write` on each. The message names the item and the access, not the linked database, so a refusal does not reveal what
the item is linked to. The per-turn read allowance of [[2026-11-13-a-user-attached-ref-grants-one-turn-read-access]]
opens a `read` of the attached item itself, as it does when the database refuses.

**The call sites that name an item pass it.** Item get and find, relation listing, item patch, delete and restore, the
request-time projection of `item.delete` and `link.unlink`, and link unlink and relink. The page operations of
[[2026-11-13-page-operations-follow-the-owner-database-grant]] pass the host
item of the page (`resolvePageOwner`: the item itself, or for a subpage the first ancestor that is not a Pages item), so
the page of a linked file, and every subpage under it, is as closed as the file and the approval projections of
`page.replace` and `page.restoreVersion` refuse the same way. The module tools `transcript.get` and
`transcript.segment.get` make the same check for the transcript they read, in the transaction of the read, honour the
per-turn read allowance, answer a refusal as `forbidden` without naming the linked record, and refuse a run that has no
project when the transcript is linked. A call that names no item decides by the database alone.

**Lists omit and expansions hide instead of refusing.** An agent's `listItems`, `database.query` and `view.query` (a
filtered view and a curated one) add a predicate to the query itself (`inheritedSensitivityDeniedSql`) that leaves out
the items the agent may not read, so the page, its cursor and `totalCount` cover the readable items only and say nothing
about how many were left out. A relation target of an inheriting database that the agent may not read is returned as
`{ id, hidden: true }`, at the top level and inside a projected relation property, and relation listing returns it as a
hidden entry. The relation names of an attached item in the Semp context (`readSempRefContext`) follow the same rule: a
target linked to a sensitive database the project may not read is `{ id, hidden: true }` with no name.

**The tool result is marked.** The generic-operation tool of [[2026-11-13-sensitive-tool-results-are-marked-by-the-tool-and-stored-redacted]]
also marks a content-bearing answer sensitive when an item it carries, an item it expanded as a relation target, or an
entry of a relation property projected on such a target, is linked to a sensitive database, whatever access the project
holds there, so the stored result is the redaction marker. The transcript tools return `sensitive: true` for a linked
transcript and the session composition copies it into the tool result details, as it does for the generic tool.

**An external AI client on `/mcp` is unchanged.** [[2026-11-13-an-external-ai-client-on-mcp-is-refused-sensitive-databases]]
decides it by the database alone, and the checks above run for an agent's project only.

## Consequences

- A file, transcript or Inbox entry is cut off from an agent the moment an edge to a sensitive record exists and is open
  again when the edge is removed or the record is trashed. No flag is stored on the item, so nothing can go stale; the
  price is one extra query per guarded single-item access and a correlated predicate on an agent's list of an inheriting
  database.
- The edge itself is not locked. A link added between the check and the end of the transaction is not seen by it; only
  the decision rows are held. The same holds for the lists, which are not locked at all.
- Not covered by this decision: counts and facets over an inheriting database, search, the titles of value-link sources
  and of page breadcrumb ancestors (both are decided by the database of the item alone), the redaction of tool call
  arguments for a write to a linked item ([[2026-11-13-tool-call-arguments-and-assistant-text-after-a-sensitive-read-are-stored-redacted]]
  decides it by the target database), and relation writes that name a linked item only as the edge's source.
- A transcript or an Inbox entry reaches a sensitive record only through a relation property that does not exist in the
  seeded schema yet; the rule applies as soon as one does.
