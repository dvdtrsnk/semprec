---
status: accepted
date: 2026-11-13
area: [backend]
supersedes: []
superseded-by: null
---

# A redacted create result keeps the id of the item it created

## Context

[[2026-11-13-sensitive-tool-results-are-marked-by-the-tool-and-stored-redacted]] stores the result of a
content-bearing operation on a sensitive database as `[redacted: sensitive]`, and
[[2026-11-13-tool-call-arguments-and-assistant-text-after-a-sensitive-read-are-stored-redacted]] stores the arguments
of a later call, and of every `item.create` and `item.patch` on a sensitive database, as the same marker. What stays is
the tool name, the call id, the operation and the target ids. The list of items a Semp reply changed (issue #1885) is
stored permanently on the assistant message from those events. A create has no target item id before it runs, and the
id of the new item was only in the result text, so a reply that created a record in a sensitive database stored no
change at all, and a consumer that reads an empty list as "this reply wrote nothing" (issue #1930) would be wrong. A
relation operation acts on its `callerItemId`, which only the arguments named, so a link written after a sensitive read
was lost in the same way.

## Decision

**A successful `item.create` returns the id of the new item as `createdItemId`.** The composition root carries it as
`details.createdItemId`. `redactSensitiveToolResult` keeps every `details` field it does not name, so the stored
redacted result holds the id while its content is the marker. An id names no property value, and the id of a patched
item is already stored in the same way as the `targetItemId` of its `tool_use`.

**A relation operation names its calling item as its target.** The session puts `callerItemId` into `targetItemId` of the
`tool_use` and `tool_result` events of a call that has no `itemId`, so the target survives the redaction of the arguments.

**What the change list stores from this is bounded.** An entry for such a call holds the item id, the database id found
by a lookup in the caller's tenant scope, the kind of change and the changed keys that can still be read; a key that
only the redacted arguments held is left out (`changedKeys: []`). It never holds a value, and never a `before` for a
sensitive database.

## Consequences

A new operation whose stored result is redacted and whose effect a reply summary must record has to keep the identity it
needs in `details` or in the target ids of its events in the same way, or the summary has a gap that looks like a reply
that wrote nothing. Events stored before this change have no `createdItemId`; a create in a sensitive database from such
a run still makes no entry.
