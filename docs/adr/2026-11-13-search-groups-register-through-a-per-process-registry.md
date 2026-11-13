---
status: accepted
date: 2026-11-13
area: [backend]
supersedes: []
superseded-by: null
---

# Search groups register through a per-process registry

## Context

Global search answers in groups (`SEARCH_GROUP_TYPES`: seven item groups, then
the thread groups `mail` and `chat`). `searchItemGroups`
(`backend/packages/data/src/search/searchItemsQuery.ts`) held the item groups
as a closed allow-list of owner modules and the `chat` group as a hard-wired
block that called `searchSempThreads` for a person. `mail` is an accepted scope
value and a thread-backed group of the output schema, but nothing could fill it,
and a group of a further domain could be added only by editing that function.

[[2026-09-30-choke-point-domain-hooks-through-a-per-process-registry]] solved
the same shape for the write path: the reading code names no domain, and the
composition root registers each domain's contribution.
[[2026-11-05-automation-batch-reads-use-the-domain-registry]] extended it to a
read, with the rule that the same registration twice is a no-op and a different
second one is refused. Search is a third case, and it has two constraints those
records do not meet.

## Decision

`search/searchGroupRegistry.ts` holds one per-process registry of search
groups, keyed by `SearchGroupType`, and `searchItemGroups` reads it instead of
naming any group. The composition root `domainWriteHooks.ts` fills it, so every
process that loads `@semprec/data` has the same groups before it searches. A
group of a further domain registers there with one call.

There are two kinds of group:

- An item group, `{ type, ownerModuleIds }`, registered with
  `registerItemSearchGroup`. The function searches the unarchived databases of
  those owner modules through `item_search_index`, with the ranking, snippets,
  subtitle parts and cursor it has always had.
- A thread group, `{ type, prepare(cursor) }`, registered with
  `registerThreadSearchGroup`. `prepare` validates the token as the group's own
  cursor, throws the group's `ValidationError` for a malformed one, and returns
  the search bound to the parsed cursor. The function runs it after the item
  groups, inside the same repeatable-read transaction, with the search text, the
  shared tsquery builder, the per-group limit, the agent's Projects item and
  whether a person asks. A group answering `total` 0 is omitted, as an item
  group is.

The actor rule belongs to the group. The function passes the facts it has
(`agentProjectItemId`, `humanActor`) and does not decide who may see a group:
`chat` answers an empty page for an agent run or an MCP session, because Semp
conversations belong to the user, and a future `mail` group states its own rule
the same way. The function still excludes, for every item group, the databases
an agent has no read grant for.

A requested type without a registration contributes nothing and is not an
error. A cursor is checked before anything is searched, for every actor and for
a query without a searchable word: by `prepare` when the scope is exactly one
registered thread group, in the item cursor shape otherwise, and a cursor with a
scope of more or fewer than one group is refused.

The registration rule is that of
[[2026-11-05-automation-batch-reads-use-the-domain-registry]]: registering the
same object twice is a no-op, and registering a different group for a type that
has one throws. `clearSearchGroupsForTests` empties the registry and throws
unless `NODE_ENV` is `test`. The registry is not exported from the data package.

Why the registry is in `search/` and not in `chokePoint/hooks.ts`: search is not
a write path, and `clearHooksForTests`, which several tests call, would empty the
groups of every later search in the file. Why it is not a `ModuleManifest`
field: the search function runs on a `Pool` with no module registry, and loading
one into it would change its signature and its caller.

## Consequences

`searchItemsQuery.ts` imports no domain's search and no module id. A group is
added by a registration in `domainWriteHooks.ts`, not by an edit of the
function. A deep-import test that calls `searchItemGroups` imports
`domainWriteHooks.ts` itself, as for the write hooks, or registers its own
groups after `clearSearchGroupsForTests`.

A registry that a process fills in its composition root can be empty in a
process that never loaded it. Such a search answers no groups instead of
failing, which is the behaviour the contract gives an unregistered type, so
`@semprec/data`'s first import of `domainWriteHooks.ts` remains the
initialization contract.

The registry holds code, not data: one definition per type, shared by every
tenant. Tenant scope and row-level security stay with the queries each group
runs in the caller's transaction.
