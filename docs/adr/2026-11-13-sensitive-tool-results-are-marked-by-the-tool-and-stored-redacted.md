---
status: accepted
date: 2026-11-13
area: [backend]
supersedes: []
superseded-by: null
---

# Sensitive tool results are marked by the tool and stored redacted

## Context

`agent_run_events.payload` stores whole messages, `tool_result` included, and is what conversation reconstruction
replays after a restart. When an agent reads a health record or a sleep night, the full item would land in that
history. Issue #1808 added `databases.sensitive` and [[2026-11-12-per-database-agent-grants]] decides who may read such
a database; issue #1827 keeps the content of its items out of stored history. The issue also names a follow-up (#2001:
tool call arguments, assistant text, compaction summaries) that builds on the mark introduced here.

[[2026-11-03-item-patch-change-redaction-uses-write-metadata]] decides that a redaction classification of an
`item.patch` result is captured inside the write and that no second lookup follows the commit. This record makes the
opposite choice for the sensitive flag, with a reason, so the two do not look like an oversight.

## Decision

**The tool marks, the lifecycle adapter redacts.** A content-bearing generic operation (`item.get`, `item.create`,
`item.patch`, `item.delete`, `item.restore`, `database.query`, `view.query`) whose answer is content of a sensitive
database returns `sensitive: true` on its tool result. The composition root carries it as `details.sensitive`; the
only consumer is `runAgentTurn`, which stores such a `tool_result` through `redactSensitiveToolResult`: the content
becomes `[redacted: sensitive]`, the mark is dropped, the `toolCallId` stays so a replay still pairs it with its call,
and the `before` and `after` values of `details.changes` are dropped, leaving the changed keys. The live turn and the
live stream keep the real result; reconstruction replays the marker as an ordinary tool result.

**An answer is sensitive when any database whose content it carries is.** That is the database of each item the
answer holds (or of a page of items), the queried database or view, every relation target expanded inside an item by
`include.relations`, and the target database of every relation property projected on such a target (those nested
targets arrive without a database id). A target the agent may not read arrives as `{ id, hidden: true }` and carries
no content, so it does not count. The flag is read through the choke point with the tenant scope of the call.

**Fail closed.** A database id that resolves to no database, expanded content that names no database, and a failed
flag lookup all count as sensitive. A failed lookup is logged with the operation, the run and the error class and
never with the answer, and is not reported as a failed call, because an `item.patch` has already committed.

**The flag is read after the operation, in its own transaction.** Reading it inside the operation would need the
write path to know about run history. The read is sound only because `databases.sensitive` is monotonic: it is set at
creation of a system database and by the cutover migration (`UPDATE ... SET sensitive = true`), and no code path turns
it off. A sensitive database therefore cannot become non-sensitive between the operation and the lookup. If a flag
could ever be turned off, the classification would have to be captured inside the operation, as
[[2026-11-03-item-patch-change-redaction-uses-write-metadata]] does for property types, and this record superseded.

## Consequences

Tool results of non-sensitive content are stored unchanged. A read of a sensitive item costs one extra lookup per
database in the answer (plus one property listing per expanded target with projected relation content). A new
content-bearing operation, or a new field that embeds another item's content in an answer (for instance the sources of
`include: ["links"]`, which name items by database key only and are not examined today), must be added to `answerDatabases` or it is stored in full. Redaction
covers stored `tool_result` events only; tool call arguments, assistant text and compaction summaries remain stored
as written until #2001, and events stored before this change are not rewritten.
