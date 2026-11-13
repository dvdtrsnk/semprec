---
status: accepted
date: 2026-11-13
area: [backend]
supersedes: []
superseded-by: null
---

# An external AI client on `/mcp` is refused every sensitive database

## Context

[[2026-11-12-per-database-agent-grants]] checks an agent run's access to a database in the data layer, in the
transaction of the read or write it guards. It leaves a caller without a project unchecked: a person, the system and an
`/mcp` call on a human session, which that decision names as the one issue #1998 delivers. `POST /mcp` derives its actor
in one of two ways. A restricted run credential gives `{ userId, runId, agentProjectItemId }`. The verified bearer or
session identity of the user gives `{ userId }`, which acts exactly like the user over REST, so an external AI client
(a desktop assistant, another agent framework) connected with the user's own token reads every database the user can
read, health records and sleep data included. The product owner decided that any model receives sensitive data only
with an explicit permission, and that this version has no way to give an external client that permission.

## Decision

**The human-token branch of `/mcp` marks its actor.** `resolveActor` in `mcp/mcpHandler.ts` returns
`{ userId, externalClient: true }` for it, and no other code sets the marker: not the run credential branch, not the REST
adapter and not the AgentTool composition root, and no input schema accepts it. `writerIdentityOf` carries it to the
writer of a choke-point write (`WriterIdentity.externalClient`), and the generic application service turns the actor into
a `DatabaseReader` for the reads.

**The data layer decides for a reader.** A `DatabaseReader` is either the Projects item of an agent run (a string) or the
external-client marker. For the marker the access is a property of the database alone: a sensitive database is `none`, any
other database is `write`. No project grant, stored decision or `none` row applies to it, because it has no project, and
there is no decision row to lock. The check runs on every path [[2026-11-12-per-database-agent-grants]] lists, in the
transaction of the read or write: item reads and lists, `database.query` and `view.query` (a curated view leaves the items
of sensitive databases out of its page, cursor and count), the relation list and relation target hiding (a target in a
sensitive database is `{ id, hidden: true }`), item create, patch, delete and restore, relation writes for both endpoint
databases, link unlink and relink, `database.get` (refused as `forbidden`), `database.list` and the schema projection
(which leave the sensitive databases out; no `/mcp` operation returns the projection, so its `externalClient` option has
no caller yet), and the value-link sources of `include=links`. A refusal is the same
`ForbiddenError` with code `forbidden`, naming the database and the access and no content of an item. Over `/mcp` it is
the JSON-RPC error `-32000` with `data.code: "forbidden"`, as every other `ChokePointError`.

**The same reader is applied to the other operations `/mcp` serves, for the marker only.** The catalog hands a human token
every operation, so a sensitive database would otherwise stay open through the paths the agent decision leaves to later
issues. For the marker, and not for an agent's project (an agent run keeps the behavior of
[[2026-11-12-per-database-agent-grants]] on these paths), each is refused in the transaction of the operation, by the
database it names or resolves:

- `item.count` and `database.facets`, by the database of each entry (one sensitive entry refuses the call), before any group
  key, value or count is computed;
- `property.list`, `get` and `getByKey`, `property.create`, `patch` and `delete`, and `property.create` of a relation, by the
  database of the property and, for a relation, of its paired side too (a change on the open side reaches the paired
  property);
- `view.get`, `create`, `patch` and `delete`, by the database of the view, and the `viewItem` operations on a curated view
  (which has no database), by the database of the member item and of every database above it, walked as `getItemPath`
  walks;
- `database.patch`, `archive` and `restore`, by the database itself, and `database.create` nested under an item
  (`parentItemId`), by the database of that item and of every database above it;
- every page operation (`page.get`, `changes`, `ensure`, `createSubpage`, `insert`, `duplicate`, `rename`,
  `restoreVersion`, and `replace` through its writer), by the database that owns the page, found by
  `resolvePageOwnerDatabase` of [[2026-11-13-page-operations-follow-the-owner-database-grant]]: the database of the
  item, or of the root host of a subpage, so the page of a subpage of a sensitive record is as closed as the record's
  own page. That is the one resolver of the page check for an agent's project and for an external client: the data layer
  hands the page methods a `DatabaseReader` and `assertAgentPageAccess` decides it. As for an agent, the page of an item
  in a database nested under a sensitive record is decided by its own database, as every item read is, and the ancestor
  in the sensitive database is shown in the breadcrumbs of `page.get` as `{ itemId, title: "", databaseKey: null,
  hidden: true }`.

The operations the generic gateway never dispatches to `/mcp` (`property.option.add` and `update`, `page.replace`, and
`database.create` with properties, which needs a REST session) carry no check for the marker.

**Human REST is unchanged.** The REST API, the web app and the iOS app with the same user carry no marker, so the same
token that is refused over `/mcp` reads and writes the sensitive databases over REST.

**There is no permission for an external client in this version.** A way to grant one, for example per token or per client
name, needs its own design and its own decision. Until then the denial is unconditional.

## Alternatives rejected

- **A sentinel project id for the external client.** The grants table is keyed by a Projects item, so a made-up id would
  have to be excluded from every grant write and every join, and a grant stored for it would silently open sensitive data.
  A reader that is not a project cannot be given a row.
- **Refusing at the gateway.** A check before the operation is the pre-check outside the write's transaction that
  [[2026-09-17-generic-application-service-port]] forbids, and it would have to enumerate the operations and the nested
  paths (relation targets, curated views, link sources) that the data layer already filters.

## Consequences

- A path added later that exposes database content to an agent calls the check for a `DatabaseReader`, which covers the
  external client as well as the project. Search, related items and aggregations that join other databases are not
  covered by this decision and are open to the external client until the issues that add or own them call the check.
- The counts, facets, schema, view and page operations above are checked for the external client only. The same
  operations stay open to an agent's project until the issues that own them extend
  [[2026-11-12-per-database-agent-grants]] to them.
- A count or a facet of an open database that groups by or lists a relation into a sensitive database shows the ids of the
  related items and their counts, the same ids a hidden relation target shows, and nothing of the item.
- The marker is on the actor of every `/mcp` call without a run credential, also of a person who points a first-party
  client at `/mcp` with their own token. That is the decision: the endpoint cannot tell such a client from an external one.
- Module tool grants and MCP tool grants over `/mcp` keep their own mechanism and are not part of this decision.
