---
status: accepted
date: 2026-11-12
area: [backend]
supersedes: []
superseded-by: null
---

# The Inbox editor schema list of pseudo field keys also holds `area` and `markdown`

## Context

[[2026-10-25-server-driven-inbox-editor-schema]] lets a field `key` be a property key, a relation
key or a pseudo field key, and lists the pseudo keys: `allDay`, `due`, `followupTask`,
`followDate`, `credential`, `transport`, `access`, `mcpProjects`, `lang`, `speakers`,
`recordedAt`, `day`, `page`, `placement` and `heading`. It says the list is extended by the
module that brings a new step, and that renaming a pseudo key is a contract change with the
client.

Declaring the editors of the ten system databases (#1825) needs two fields that have no property
or relation of the owning database and no key on that list:

- The task card shows the area the task belongs to. The Tasks database has no `area` property or
  relation of its own; a task reaches an area through its project. Task step 3 of #1825 asks the
  card to show project and area as `select` fields with an `optionsSource`.
- The journal card and the page card show the Markdown text they will write. That text is the
  `pageContent` of the proposal envelope, not a property of the Journal or Pages database.

Using an existing key for either would give one key two meanings, which the client could not tell
apart. A misspelt key in a declaration is caught by a test that checks every field key against the
owning database's properties and this list.

## Decision

The pseudo field keys are the fifteen of [[2026-10-25-server-driven-inbox-editor-schema]] and
these two, appended:

- `area`: the area choice of the `task` card, a `select` with `optionsSource` `area`. It names no
  stored property of Tasks; the value is the area the card links the task to.
- `markdown`: the Markdown content of the `journal` and `page` cards, an `area` control (the
  multi-line text control; the control name and this key are unrelated). It stands for the
  `pageContent` of the proposal envelope.

Both are declared in `backend/packages/data/src/seed/systemDatabasesEditorSchemas.ts`. A later
module that needs another pseudo key appends it in a new record, as the earlier one asks.

## Consequences

- The client may key the Markdown content field on `markdown` and the task's area choice on `area`.
  Renaming either is a contract change and needs its own decision, as for every other pseudo key.
- What `area` and `markdown` are stored as on confirm is not decided here. It belongs to the
  confirm and normalization work (#1928, #1934), as it does for the step keys.
- The declaration test in `inboxRouteHandlers.test.ts` lists these two keys beside the property
  keys, so a declaration with any other unknown key fails it.

## Alternatives considered

- **Add an `area` relation to Tasks.** Rejected: it is a schema change with a second source of
  truth for the area beside the project, outside the scope of a read-side issue.
- **Reuse `heading` or `page` for the Markdown content.** Rejected: both already name other fields
  of the page card, so one key would carry two meanings.
