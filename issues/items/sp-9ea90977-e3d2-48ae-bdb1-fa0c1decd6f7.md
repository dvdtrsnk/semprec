---
schemaVersion: 1
id: "sp-9ea90977-e3d2-48ae-bdb1-fa0c1decd6f7"
title: "[backend-delivery 50/74] Implement application, shared/genericOperations, data/agentGrants changes"
kind: "implementation"
state: "open"
stateReason: null
labels: ["spec:proposed","execution:batch","execution:sequential"]
parent: "sp-62331d42-78af-4b93-ae97-d5ccbe3324df"
assignees: []
milestone: null
createdAt: "2026-10-31T17:31:02.037Z"
updatedAt: "2026-10-31T17:31:02.037Z"
closedAt: null
source: null
approval: null
resolution: null
---
**Blocked by:** sp-48013c73-79f6-41ee-9bec-990c39e2647e
**Model tier:** high

## Context

Model tier rationale: This delivery combines several existing backend specifications across typed storage, API and runtime boundaries; preserving their contracts and verifying the combined behavior requires cross-module reasoning.

Use one working tree and one source-writing agent at a time. Implement the complete batch before independent review, AC acceptance and full backend verification. Original feature epics remain reporting groups, not execution units. Preserve every embedded Task, decision and acceptance criterion. Each member's Out of scope limits that member; it does not prohibit another explicitly included member's Task. Do not add behavior beyond the union of member Tasks.

Web and mobile implementation, client catalogs, client builds and client tests are excluded. Backend contracts and server-side tests for device/platform behavior remain included. Product UI descriptions are context only. Do not remove existing client-required backend data merely because client work is deferred.

Follow the scoped execution exception in docs/adr/2026-10-31-sequential-backend-delivery-batches.md. Before starting, reconcile this checkout with any newer local integration history; already-delivered work needs evidence and handover reconciliation, not reimplementation. No source or batch is completed by this planning change.

This is a proposed specification, not execution authorization. Obtain owner approval for this exact batch before queueing. Included unapproved source specifications also remain unapproved.

Execution order: gh-1810 → gh-1849 → gh-1998 → gh-1844 → gh-1861 → gh-2017 → gh-1853 → gh-1800 → gh-2015 → gh-1814. Internal prerequisites are included earlier in this order; prerequisites assigned to previous batches must have passed their gates first. Preserve declared source dependencies; no shared-file dependency has been discarded.

## Task

Implement the following immutable requirement snapshots in the listed order. Load each snapshot's required topic skills. Keep an AC evidence matrix keyed by source ID and criterion, with production entry point, implementation SHA, test/scenario, log path and verdict. Write required tests with the implementation and use targeted checks during development; perform independent review and the complete backend gate after the batch is implemented.

### Requirement gh-1810: [sensitive-data 02/09] Enforce per-database grants in the data layer

#### Context

Model tier rationale: A new authorization contract enforced inside the choke point in the same transaction as every agent read and write of a database, with a new tenant table, a decision record and many call sites, so a missed path is a data leak.

Today an agent run holds all eight core capabilities (`core.database|item|schema|view.read|write`, `backend/packages/shared/src/genericOperations/capabilities.ts`) for every database of the tenant. `genericOperationGateway.ts` `isGranted` decides by capability only, and `genericApplicationService.ts` ignores the actor on reads. Non-destructive writes run immediately (ADR `2026-09-18-non-destructive-generic-operations-bypass-agent-approval`); destructive ones need approval. The choke point does not know the writer's kind or the agent's project for items; #1415 threads the writer kind (user, agent with its project item id, system) into item and relation writes. The ADR `2026-09-17-generic-application-service-port` forbids splitting a protected write into a pre-check in the gateway and a separate write, so the check must live in the data layer.

This issue introduces per-database grants for an agent's project and enforces them. #1808 provides `databases.sensitive`. #1841 manages grants over REST; #1849 adds a one-turn read allowance for items the user attaches; #1827 redacts run history; #1844, #1840, #1853, #1987, #1839 and #1842 build on the check.

Decisions (record them in the ADR):
- Default for an agent (decided by the product owner): only databases marked sensitive are denied by default. A sensitive database is denied for read and write unless the agent's project has a grant. Every non-sensitive database, system or user-created, stays allowed for read and write as today. A user can switch a user-created database off for a project (#1841); it is then denied like a sensitive database without a grant.
- A grant row has access `none`, `read` or `write`; `write` includes `read`; `none` denies both. Without a row, a sensitive database has `none` and a user-created database has `write`; non-sensitive system databases are always allowed and never have a row. Grants apply to the run's project; a run without a project cannot call generic operations at all today.
- Human and system writers are never checked here. An `/mcp` call with a human session is recorded as `writerKind: 'agent'` without `agentProjectItemId` (#1415); it is not checked against project grants here either. The check applies only when the writer carries an `agentProjectItemId` (an agent run or a run credential). The Inbox proposal computation is a system writer; it includes health data in its context only when the Semprec project has a grant (as #1987 implements).
- A relation write needs `write` on both endpoint databases.
- A refusal is a `ForbiddenError` with code `forbidden` and a message that carries no content of the item. An item that does not exist stays not found.
- Who may grant: #1841. External AI clients using a human token on `/mcp` are denied sensitive databases by #1998, built on this check; in this issue human tokens behave as humans.

#### Task

Load `state-writes`, `error-handling`, `adr-conventions`, `db-migrations` and `testing`. Because several files below are hotspots, keep each edit to the call sites listed.

1. ADR under `docs/adr/` (`<date written>-per-database-agent-grants.md`) recording the decisions above, the alternative of a gateway pre-check (rejected: ADR above) and the alternative of capability ids per database (rejected).
2. Migration `backend/packages/data/src/db/migrations/NNNN_<name>.sql` (next free ordinal at commit time): table `agent_database_grants` with tenant id, project item id (no foreign key, as items are partitioned), database id (composite tenant foreign key), `access` (`none`, `read` or `write`), timestamps; unique index leading with the tenant on (tenant, project item, database); row level security and role grants as for `project_mcp_grants`; tenancy comment.
3. A store with `getAccess(client, projectItemId, databaseId)` and the admin write functions kept out of the package barrel (as `mcp/mcpGrantsAdminStore.ts`), so agent code cannot reach them.
4. `assertAgentDatabaseAccess(client, { agentProjectItemId, databaseId, access })` in one query that reads the database row (`system`, `sensitive`, archived) and the grant, locking the grant row `FOR SHARE`, so a revoke waits for the write's transaction.
5. Call it, for an agent writer that carries an `agentProjectItemId` (not for an `/mcp` human session, which has none), in the same transaction and before the read or write: item get and list/query by the item's or queried database; item create, patch, delete and restore by the item's database; relation put and delete for both endpoint databases; `database.query` and `view.query` by the database. Thread the agent identity into the read paths in `itemReads.ts`, `viewQueryOps.ts` and `genericApplicationService.ts`, which ignore it today.
6. `database.list` and the schema projection omit databases the agent cannot read (add an optional agent project filter to `generateSchemaProjection`); `database.get` of such a database is refused. Where an existing generic read path returns another item reached through a relation, a target in a database the agent cannot read is returned as `{ id, hidden: true }` only. Paths added later bring their own filter.
7. On purge of a Projects item, delete its grants (in `chokePoint/itemTrash.ts` with the other dependent rows).
8. Tests: an agent without a grant gets 403 `forbidden` for `item.get`, `database.query` and `view.query` on a health record database, and passes with a read grant; an agent write needs a write grant; a user-created database without a row stays open for read and write, and is refused for read and write once the project's row is `none`, while the human writes freely; a non-sensitive system database stays open; a relation to a hidden database needs both grants; `database.list` hides the databases; a grant revoked before the check stops the write, and a revoke started after the check waits (two connections); a purged project loses its grants; another tenant's grants never apply; an `/mcp` call with a human session (writer kind `agent` without `agentProjectItemId`) is not checked against project grants by this issue's check (its sensitive-database denial is #1998).

#### Touches

- docs/adr/ (one new ADR file)
- backend/packages/data/src/db/migrations/NNNN_<name>.sql (next free ordinal at commit time)
- backend/packages/data/src/agentGrants/agentDatabaseGrantsStore.ts (new)
- backend/packages/data/src/agentGrants/agentDatabaseAccess.ts (new)
- backend/packages/data/src/chokePoint/itemReads.ts
- backend/packages/data/src/chokePoint/itemWrites.ts
- backend/packages/data/src/chokePoint/relationOps.ts
- backend/packages/data/src/chokePoint/viewQueryOps.ts
- backend/packages/data/src/chokePoint/databaseOps.ts (database list and get)
- backend/packages/data/src/chokePoint/itemTrash.ts (grant cleanup on project purge)
- backend/packages/data/src/manifest/schemaProjection.ts (agent project filter)
- backend/packages/application/src/genericApplicationService.ts (actor passed to reads)
- backend/packages/application/src/genericOperationGateway.ts (only if the actor is not already passed through)
- backend/packages/data/src/index.ts (new export lines; admin functions excluded)
- backend/packages/data/src/__tests__/ (new grant enforcement tests)

#### Scope

##### In scope

- The decision record, the grants table and read store, the access check, its enforcement on the operations above, hiding of unreadable databases, and grant cleanup on project purge.

##### Out of scope

- The `sensitive` column: #1808.
- Managing grants over REST: #1841.
- The one-turn read allowance for attached items: #1849.
- Redacting run history: #1827.
- Page operations: #1844. Sleep tools: #1840.
- Default grants or extra write gating for a module added later: that module adds them on top of this check.
- Filters for search, related items and facets: #1842, #1839; they call this check themselves.
- Grants for module agent tools: decided in the ADR from #1385.
- Sensitivity inherited by files, transcripts and Inbox entries linked to a sensitive record, and refusing filters and aggregations over a sensitive database: #1999 and #2000, built on this check.
- External AI clients using a human token on `/mcp`: #1998.

#### Acceptance criteria

- When an agent without a grant calls `item.get`, `database.query` or `view.query` on a sensitive database, then the result is 403 `forbidden`; with a project grant it succeeds; a human GET of the same item is unchanged.
- When an agent reads or writes a user-created database without a grant row, then it succeeds as today; when the project's row for that database is `none`, then the agent's read and write are 403; the user's own write succeeds.
- When the grant is revoked before the write's check, then the write is refused; a revoke issued after the check waits for the write's transaction.
- When `database.list` runs for an agent without grants, then sensitive databases are absent and user-created databases are listed.
- When a Projects item is purged, then its grants are deleted.
- When an `/mcp` call with a human session (no `agentProjectItemId`) reads or writes a database, then this issue's per-project grant check does not run for it; the default denial of sensitive databases to such a caller is #1998.
- Error messages and logs of a refused call contain no property values of the item.

### Requirement gh-1849: [sensitive-data 06/09] Let a user-attached context ref grant one-run read access

#### Context

Model tier rationale: This is a deliberate, scoped exception to an authorization boundary (read access without a grant) that must be tied exactly to one turn and to refs the user attached, so scope leaks or reuse across turns would silently weaken the grants.

#1810 denies an agent access to sensitive databases, and to user-created databases the user switched off for the project, unless its project has a grant. A user who attaches a health record or a sleep night to a message to Semp has, by doing so, shown Semp that one object. #1682 validates and stores message refs, and #1733 expands refs into the turn context in `semprec-agents` (currently with direct tenant-scoped reads). The Semp agent must be able to read exactly the attached item during that turn, and not the rest of the database, not in later turns, and never write to it.

Builds on #1810, #1682 and #1733. #1853 builds on it for sleep night refs.

Decisions:
- Scope is the turn that carries the ref, not the whole run or thread: rows are created when the turn starts and removed when it settles (success, error or cancel), and a stale row left by a crash is cleared when the next turn of that run starts. This is the strictest reading of "only in the run where the user attached it".
- The allowance is read access to the referenced item id only. Items related to it are not opened; relation targets in databases the agent cannot read stay hidden as `{ id, hidden: true }`.
- Refs naming an item (`item`, `block`, `transcriptSegment`) create allowances; the allowed ids come from the persisted, already-validated refs of the turn's message, never from tool arguments.
- Virtual refs without an item (a sleep night) are handled by #1853 using the same allowance.

#### Task

Load `state-writes`, `db-migrations`, `error-handling` and `testing`.

1. Migration `backend/packages/data/src/db/migrations/NNNN_<name>.sql` (next free ordinal at commit time): table `agent_run_read_allowances` (tenant id, agent run id with a foreign key to `agent_runs` and cascade, item id, created at; unique per tenant, run and item), row level security and role grants as for the other agent tables, tenancy comment.
2. A store with `allowItemsForTurn(client, runId, itemIds)`, `clearForRun(client, runId)` and `isItemAllowed(client, runId, itemId)`.
3. Extend `assertAgentDatabaseAccess` so that a read (never a write) is allowed when the actor's run has an allowance for the item. The check keeps running in the same transaction as the read.
4. In the ref expander (#1733), at turn start clear stale rows, insert the allowances from the message's refs, read the referenced items through the access-checked read path as the run's agent identity (so grants and allowances apply, and hidden relation targets are filtered), and at turn end (success, failure, cancellation) clear them.
5. Tests: a health record ref is read by the agent in that turn without a grant and a different item of the same database is refused; in the next turn without the ref the same item is refused; `item.patch` of the attached item without a write grant is 403; allowances do not cross tenants or runs; rows are removed after a failed and a cancelled turn; a crash leftover is cleared at the next turn start; relation targets of the attached item in unreadable databases are hidden.

#### Touches

- backend/packages/data/src/db/migrations/NNNN_<name>.sql (next free ordinal at commit time)
- backend/packages/data/src/agentGrants/agentRunReadAllowancesStore.ts (new)
- backend/packages/data/src/agentGrants/agentDatabaseAccess.ts
- backend/packages/data/src/index.ts (new export line)
- backend/services/semprec-agents/src/refExpansion.ts
- backend/services/semprec-agents/src/agentRunTasks.ts (turn end cleanup hook, if the cleanup does not fit in the expander)
- backend/services/semprec-agents/src/__tests__/ (new tests)
- backend/packages/data/src/__tests__/ (new store and check tests)

#### Scope

##### In scope

- The per-turn allowance table, its use in the access check and the expander, and cleanup.

##### Out of scope

- The grants and the base check: #1810.
- Sleep night refs: #1853.
- Write access from a ref; writing always needs a grant.
- Opening related items, attachments or other databases from an attached item.
- External AI clients using a human token on `/mcp`: they are denied sensitive databases by #1998; refs attached in a Semp chat create no allowance for them.

#### Acceptance criteria

- When the user attaches a health record to a message, then in that turn the agent reads that item without a grant.
- When the next turn has no such ref, then reading the same item is refused again.
- When the agent tries to patch the attached item without a write grant, then the result is 403.
- When the turn ends in any way, then no allowance rows remain for the run.
- When the attached item relates to an item in an unreadable database, then that target appears only as `{ id, hidden: true }`.

### Requirement gh-1998: [sensitive-data 07/09] Deny sensitive databases to external AI clients on /mcp by default

#### Context

Model tier rationale: This extends an authorization boundary to a second kind of caller on the MCP endpoint, so a missed read path or a wrongly classified caller leaks health data to an external model.

`POST /mcp` (`backend/services/semprec-api/src/mcp/mcpHandler.ts`) derives its actor in one of two ways: a restricted run credential of a Semp agent run (`{ userId, runId, agentProjectItemId }`), or the verified human session or bearer identity from `authenticateRequest`, which today acts exactly like the user over REST (`{ userId }`). An external AI client (a desktop assistant, another agent framework) connected with the user's own token therefore reads every database the user can read, including health records and the sleep databases.

#1808 marks databases as `sensitive` and #1810 enforces per-database access for agent actors inside the data layer, in the same transaction as the read or write. This issue applies the same default to the human-token branch of `/mcp`.

Decisions:
- Decided by the product owner: sensitive databases are denied by default also to external AI clients using a human token on `/mcp`. Any model receives sensitive data only with an explicit permission.
- No way to give an external client that permission exists in this version: a sensitive database is always denied to the human-token branch of `/mcp`. Non-sensitive databases (system and user-created) stay available to it as today.
- The REST API, the web app and the iOS app with the same user are unaffected: only the actor created by the `/mcp` human-token branch carries the external-client marker.
- A refusal is the same `ForbiddenError` with code `forbidden` as in #1810, with no item content in the message.

#### Task

Load `state-writes`, `error-handling` and `testing`.

1. Add an optional `externalClient: true` marker to the actor type used by the generic operation gateway, set only by the human-token branch of `resolveActor` in `mcp/mcpHandler.ts`.
2. In the access check of #1810 (`agentGrants/agentDatabaseAccess.ts`), treat an actor with `externalClient: true` like an agent without a project grant for sensitive databases: read and write of a database with `sensitive = true` are refused, every other database is allowed. The check runs in the same transaction as the read or write, on every path #1810 covers (item reads and writes, relation writes for both endpoints, `database.query`, `view.query`).
3. `database.list`, `database.get` and the schema projection omit or refuse sensitive databases for such an actor, and relation targets in a sensitive database are returned as `{ id, hidden: true }`, as #1810 does for agents.
4. Thread the actor from the gateway into the read paths where #1810 passes only the agent identity, if the marker does not already reach them.
5. Tests: over `POST /mcp` with a human bearer token, `semprec.item.get` of a health record, `semprec.database.query` on `sleepNights` and an item create in Health records return 403 `forbidden`; the same token over REST `GET /api/items/:id` still returns the record; a non-sensitive system database and a user-created database stay readable over `/mcp`; `semprec.database.list` over `/mcp` omits the sensitive databases; a run credential keeps the behavior of #1810; no log line or error message carries item values.

#### Touches

- backend/services/semprec-api/src/mcp/mcpHandler.ts (actor marker in the human-token branch)
- backend/packages/shared/src/genericOperations/port.ts (actor type, only if the actor type is declared there)
- backend/packages/data/src/agentGrants/agentDatabaseAccess.ts
- backend/packages/data/src/chokePoint/databaseOps.ts (database list and get for the marked actor)
- backend/packages/data/src/manifest/schemaProjection.ts (filter for the marked actor)
- backend/packages/application/src/genericApplicationService.ts (only if the marker is not passed through)
- backend/services/semprec-api/src/__tests__/ (new `/mcp` sensitivity tests)

#### Scope

##### In scope

- Marking the human-token actor of `/mcp` as an external client and denying it sensitive databases on every path the access check of #1810 covers.

##### Out of scope

- The grants table and the base check: #1810. Managing project grants: #1841.
- A way to grant an external AI client access to a sensitive database; it needs its own design.
- Module and MCP tool grants over `/mcp`, which have their own mechanism.
- Human REST access, which is unchanged.

#### Acceptance criteria

- When an external client with the user's bearer token calls `semprec.item.get` on a health record over `/mcp`, then the result is 403 `forbidden`.
- When the same user reads the same record over REST, then it is returned unchanged.
- When an external client lists databases over `/mcp`, then sensitive databases are absent and user-created databases are listed.
- When an external client writes to a sensitive database over `/mcp`, then the result is 403 and nothing is written.
- When a Semp agent run credential calls `/mcp`, then the behavior of #1810 applies unchanged.
- Error messages and logs of a refused call contain no property values of the item.

### Requirement gh-1844: [semp-pages 06/09] Classify page operations for agents with capabilities, approval and database grants

#### Context

Model tier rationale: It defines the authorization rule for every agent page write (database grants resolved through page ownership, sensitive-database denial, approval classification), a new isolation and permission contract.

The generic operation catalog (`backend/packages/shared/src/genericOperations/operationNames.ts`) has 29 operations and nothing over docs. Capability ids are only `core.database/schema/view/item .read/.write` (`capabilities.ts`), and the policy for agents is: only an operation that can be reversed with another catalog write may run without approval, otherwise `requiresApproval: true` (`docs/adr/2026-09-18-non-destructive-generic-operations-bypass-agent-approval.md`). The page operations are introduced by #1615 (page summary read), #1678 (read as Markdown), #1765 (replace with `If-Match`), #1679 (insert at a placement) and #1676 (subpages); #1617 adds version restore. A run of the assistant for a project writes through the shared invocation interceptor in `application/src/genericOperationGateway.ts`, which checks approval for agent actors.

This issue classifies the page operations for agents, following the write policy of #1400:

- Every page operation carries capability `core.item.read` (reads) or `core.item.write` (writes), and approval metadata: `page.get` and `page.insert` run without approval; `page.replace` and any deletion require approval; the operations introduced by other issues (ensure, subpage create, duplicate, rename, restore, merge of duplicate journal entries) declare their metadata using the resolver added here.
- Write permission equals the per-database write grant (#1810) on the database that owns the page: a page of an item, the item's own database; a subpage in Pages, the database of its root host item found through `parentItemId`; a Journal day, the Journal database. Reading follows the read grant. Databases flagged sensitive are denied by default; that default is enforced by #1810 and must apply here too.
- The assistant's sprint-summary permission in a project's guidance (write to the journal) is the write grant on Journal for that project. System databases such as Journal are allowed unless a grant record restricts them (default allow, from the grants model).
- Both the AgentTool and the MCP (`semprec.`-prefixed) exposure go through the same path.

Decision: `page.replace` requires approval, also after version restore (#1617) exists, because it is a large destructive change.

#### Task

Load `state-writes`, `error-handling`, `testing` and `canonical-keys`.

1. Add `resolvePageOwnerDatabase(client, itemId)` in `docs/` or `application/` that returns the owning database by the three rules above (item page, subpage via `parentItemId` chain, Journal day), and use it from the page operations' agent authorization step.
2. Extend `OPERATION_METADATA` (`capabilities.ts`) and `CAPABILITY_IDS` consumption so each page operation delivered by the blockers has its capability id and `requiresApproval` value; keep the compile-time exhaustiveness checks green.
3. In `genericOperationGateway.ts` apply the per-database grant check to page operations for agent actors, with a 403 `forbidden` on a restricted database; a project without a grant record on a system database is allowed.
4. Tests: page.get Markdown over notes of a project returns `[Release checklist](semprec://page/<id>)` links and block ids; a run whose project has Journal restricted to read gets 403 on a write to a day's page, and without a grant record the write passes; a subpage follows the grant on Projects; `page.replace` by an agent is held for approval while `page.insert` is not; a sensitive database is denied by default.

#### Touches

- backend/packages/shared/src/genericOperations/capabilities.ts
- backend/packages/shared/src/genericOperations/bindings.ts
- backend/packages/application/src/genericOperationGateway.ts
- backend/packages/application/src/genericApplicationService.ts
- backend/packages/data/src/docs/pageOwnerDatabase.ts (new)
- backend/packages/data/src/index.ts (barrel export)
- backend/packages/shared/src/genericOperations/__tests__/ and backend/packages/application/src/__tests__/ (classification and grant tests)

#### Scope

##### In scope

- Capability ids, approval metadata and page-owner database resolution for the page operations delivered by the blockers, with grant enforcement for agent calls.

##### Out of scope

- The ADR text: #1400; version restore and its metadata: #1617.
- The grant model and its REST management: #1810 and #1841.
- Exposing the Journal period lookup to the assistant: #1861.
- Marking databases as sensitive: #1808.

#### Acceptance criteria

- When `page.get` is called for an item whose page contains a subpage, then the Markdown contains `[title](semprec://page/<id>)` and the block ids.
- When a run of a project whose Journal grant is read-only writes to a day's page, then the response is 403 `forbidden`; without a grant record the write succeeds.
- When an agent calls `page.replace` without approval, then it is held for approval; `page.insert` is not.
- A subpage of a Pages item writes under the grant on the root host's database.

### Requirement gh-1861: [semp-pages 07/09] Let Semp read and write Journal periods

#### Context

Model tier rationale: A thin agent-facing operation over the journal's existing lazy-create mechanism plus page operations already classified, verified against the grant and approval rules.

Semp can read and write pages through the page operations (#1844), but a Journal period (day, week, month) is not an item the assistant can name: the period must first be turned into a Journal item and its page, creating them lazily when missing. #1541 provides that lazy creation as a single REST custom route. The generic catalog is not the place for `journal.*` operations, so the assistant reaches Journal through the page family.

This issue exposes that lookup to the agent as one operation in the page family, `page.ensureJournalPeriod { type, date | period }`, returning `{ itemId, docId, period, range }`; the assistant then reads and writes with `page.get` and `page.insert` (`placement: "end"`). Writing to a week that does not yet exist creates it (for example the week containing 2026-10-16 becomes 2026-W42) and appends the text, with the document update authored `ai_agent`.

Decision: variant (a) is chosen, the page-family operation rather than module agent tools, because module tools are not yet composed into agent sessions (#1523); moving to dedicated `journal.read`/`journal.write` module tools stays possible later and is not planned.

#### Task

Load `state-writes`, `error-handling`, `canonical-keys` and `testing`.

1. Add `page.ensureJournalPeriod` to the page operation family (name, input and output schemas, binding, application service method), delegating to the lazy-create function behind #1541 and requiring the write grant on Journal through the rules of #1844.
2. Metadata: capability `core.item.write`, `requiresApproval: false` (it creates an empty, easily trashed entry the user could create themselves).
3. Validate `type` and `date`/`period` as the journal store defines them; reject an unknown type or a malformed period with 400.
4. Tests: writing to the week containing 2026-10-16 with no existing week creates `2026-W42`, appends at the end, and `doc_updates` rows are `ai_agent`; an existing entry is reused; a run restricted to read on Journal gets 403; the AgentTool and MCP names resolve to the same handler.

#### Touches

- backend/packages/shared/src/genericOperations/operationNames.ts
- backend/packages/shared/src/genericOperations/schemas.ts
- backend/packages/shared/src/genericOperations/capabilities.ts
- backend/packages/shared/src/genericOperations/bindings.ts
- backend/packages/shared/src/genericOperations/port.ts
- backend/packages/application/src/genericApplicationService.ts
- backend/packages/data/src/journal/ (call into the lazy-create function; export only)
- backend/packages/data/src/__tests__/ and backend/packages/application/src/__tests__/

#### Scope

##### In scope

- The `page.ensureJournalPeriod` operation, its schema and metadata, and the end-to-end write of a summary into a journal period.

##### Out of scope

- The lazy-create mechanism itself: #1541.
- Grant and approval classification of the other page operations: #1844.
- Module agent tools `journal.read`/`journal.write`: not planned yet; they wait for module tools in sessions (#1523).

#### Acceptance criteria

- When the assistant writes to the week containing 2026-10-16 and no such week exists, then `2026-W42` is created, the text is appended at the end, and `doc_updates.created_by` is `ai_agent`.
- When a run's project has Journal restricted to read, then the call returns 403 `forbidden`.
- When the period already exists, then no second entry is created.

### Requirement gh-2017: [semp-pages 08/09] Let Semp propose merging duplicate journal entries for approval

#### Context

Model tier rationale: One new page-family operation that delegates to an existing merge function behind the approval flow, on the operation catalog seams that blockers extend, with existing classification and approval fixtures; the destructive work itself is delivered by #1726.

#1726 adds `mergeJournalDuplicates(client, { periodType, period })`: for a period with two live Journal entries it keeps the older one, appends the other's page content, re-points every relation edge and moves the duplicate to the trash, in one transaction. Merging changes links (relations and Inbox day edges), so it must never run silently. The assistant prevents duplicates by writing Journal periods only through `page.ensureJournalPeriod` (#1861) and proposes a merge where duplicates already exist; the user decides.

The page operation family lives in the shared operation catalog (`operationNames.ts`, `schemas.ts`, `capabilities.ts`, `bindings.ts`, `port.ts`) with the application service in `genericApplicationService.ts`. #1844 classifies page operations for agents (capability, `requiresApproval`, database grants through the page owner database); an operation with `requiresApproval: true` called by an agent is held as an approval request and runs once after the user approves it. The weekly journal cleanup (#1883) lists the duplicated periods for the assistant, which then calls this operation.

Decision: the assistant never merges on its own. The merge is exposed only as an operation that always requires approval; the approval request names the period and the two entries.

Shared-file ordering: this issue also waits for #1861 because both edit the operation catalog files listed in Touches.

#### Task

Load `state-writes`, `error-handling`, `canonical-keys` and `testing`.

1. Add `page.mergeJournalDuplicates` to the page operation family (name, input and output schemas, binding, application service method): input `{ type, period }` validated as the journal store defines them (unknown type or malformed period 400), output `{ survivorId, mergedItemId }` or `{ merged: false }` when the period has no duplicate. It delegates to `mergeJournalDuplicates` of #1726.
2. Metadata: capability `core.item.write`, `requiresApproval: true`; it requires the write grant on Journal through the rules of #1844.
3. The safe summary of the approval request names the period (type and key) and the titles of the surviving and the merged entry, without page content.
4. Tests: an agent call for a day with two live entries creates a pending approval request and changes nothing; approving it merges the entries once (one survivor, the other in the trash); rejecting it leaves both entries; a run restricted to read on Journal gets 403; a period without a duplicate returns `{ merged: false }` after approval; the AgentTool and MCP names resolve to the same handler.

#### Touches

- backend/packages/shared/src/genericOperations/operationNames.ts
- backend/packages/shared/src/genericOperations/schemas.ts
- backend/packages/shared/src/genericOperations/capabilities.ts
- backend/packages/shared/src/genericOperations/bindings.ts
- backend/packages/shared/src/genericOperations/port.ts
- backend/packages/application/src/genericApplicationService.ts
- backend/packages/data/src/journal/ (call into `mergeJournalDuplicates`; export only)
- backend/packages/data/src/__tests__/ and backend/packages/application/src/__tests__/

#### Scope

##### In scope

- The approval-gated `page.mergeJournalDuplicates` operation and its approval summary.

##### Out of scope

- The merge itself; #1726.
- Finding duplicated periods and running the weekly cleanup; #1883.
- A merge action in the app UI.

#### Acceptance criteria

- When the assistant calls `page.mergeJournalDuplicates` for a day with two live entries, then an approval request is pending and both entries are unchanged.
- When the user approves the request, then the entries are merged exactly once; when the user rejects it, then both entries stay live.
- When a run whose project has Journal restricted to read calls it, then the response is 403 `forbidden`.

### Requirement gh-1853: [sleep 13/13] Expand a sleepNight context ref into the agent turn

#### Context

Model tier rationale: One new variant added to an existing closed ref schema, its date validation and one expander branch over a pure resolver, with existing ref-validation and expansion fixtures; the access rules come from blocking issues.

A user can attach an object to a message to Semp, and Semp receives a reference and reads the object itself. The ref schema is the closed union defined by #1369; refs are validated and stored by the message endpoint (#1682, on the route of #1620); and before the model prompt of a turn, `semprec-agents` expands every ref into a context block (#1733). A night of sleep is not an item: it is the plan of a wake day merged with an optional exception, resolved by #1792, so it needs its own virtual ref kind. A sleep plan is a normal item and uses the existing `item` ref.

This issue adds the `sleepNight` ref: the user drags the night strip of the calendar, the night circle or the bedtime-reminder marker onto Semp, and the agent gets the resolved night, its plan and its exception. The sleep databases are sensitive (#1808) and a run reads them only with a database grant (#1810); a ref the user attaches in the message can grant a one-run read of the referenced data (#1849).

Decisions:
- The ref is `{ kind: "sleepNight", night: "YYYY-MM-DD" }` and carries no item id. Its dedup identity is `kind` plus `night`.
- Access: the expander reads the sleep data with the run's database grant. Without a grant it falls back to the one-run read access of #1849, which is extended here to this virtual kind (the settings, the plans and the exception of that night, for this run only). If that access is not given, the ref is rendered as unavailable (no access) and the turn continues.
- Which night the area card and the home-overview circle attach (today's night versus the settings) is a client decision; the backend only accepts a night date.

#### Task

Load `io-hardening`, `error-handling`, `canonical-keys` and `testing`.

1. In the shared message-ref module (`backend/packages/shared/src/sempMessageRef.ts`, #1369) add the strict variant `{ kind: "sleepNight", night }` where `night` must be a real calendar date `YYYY-MM-DD` (`2026-13-01` is invalid), include it in the list of kinds, and make `messageRefKey` return the identity `sleepNight:<night>`.
2. In the message endpoint's ref validation (#1682) accept the variant with no existence check (the ref is virtual); an invalid date is a 400 with `field` `context[i]`.
3. In `backend/services/semprec-agents/src/refExpansion.ts` (#1733) add a `sleepNight` branch: call `loadSleepNights` (#1809) for that single date in the turn's tenant scope and render one section: the night, the plan name, bedtime, wake time, alarm, whether it differs from the plan (`changed`), the duration, the bedtime-reminder time, and the plan and exception item ids so the agent can edit them. When there is no plan and no exception, render "no sleep planned for this night". Apply the per-ref size cap of the expander.
4. Apply the access rule above: a run without grant and without the one-run access of #1849 renders the section as unavailable and expands nothing from the sleep databases.
5. Tests: the shared schema accepts a valid night and rejects an invalid date and extra fields; two equal refs share one identity; the endpoint returns 400 `context[i]` for `2026-13-01`; expansion of `2026-10-16` with the weekend plan produces 00:00 to 08:30, weekend plan, no alarm; with a grant the sleep data is read; without a grant and without the one-run access the section is unavailable; no expanded text appears in `agent_runs.task` or run events.

#### Touches

- backend/packages/shared/src/sempMessageRef.ts (new variant)
- backend/packages/shared/src/__tests__/sempMessageRef.unit.test.ts
- the ref validation of the Semp message endpoint introduced by #1682 (accept the variant)
- backend/services/semprec-agents/src/refExpansion.ts (sleepNight branch)
- backend/services/semprec-agents/src/__tests__/refExpansion.unit.test.ts
- the one-run read access of #1849 (one added kind)

#### Scope

##### In scope

- The `sleepNight` ref variant, its validation, its dedup identity and its expansion into the agent turn with the access rules above.

##### Out of scope

- The ref schema and the endpoint: #1369, #1682, #1620; the expander: #1733.
- Grants and sensitive marking: #1810 and #1808; the general one-run read access: #1849.
- Agent tools to read and change nights: #1840.
- Client labels and kinds in the context chips: not part of the backend.
- Which night the area card and the overview circle attach: not planned yet; it waits for a product decision.

#### Acceptance criteria

- When a message carries `{ kind: "sleepNight", night: "2026-10-16" }` and the run may read the sleep databases, then the agent's context for the turn contains the night 00:00 to 08:30, the weekend plan, no alarm, and the plan and exception ids.
- When `night` is `2026-13-01`, then the endpoint answers 400 with `field` `context[i]` and stores nothing.
- When the run has neither a grant nor the one-run access, then the ref is rendered as unavailable and the turn continues.
- When the same night is attached twice, then it is stored once.
- When the turn is stored, then neither `agent_runs.task` nor any run event contains the expanded text.

### Requirement gh-1800: [calendar-recurrence 02/08] Generate birthday entries in the calendar timeline

#### Context

Model tier rationale: One known mechanism (a read-only timeline source) over an existing extension point, but it has to handle leap-day birthdays, year boundaries inside a range and the tenant locale for the title.

The calendar timeline (#1717) is assembled from sources listed in `backend/packages/data/src/calendar/timelineSources.ts`. People now carry `birthday` and `birthdayYearKnown` (#1795), and the Calendars database has a system calendar with system key `birthdays` (#1600). This issue adds the birthday source: each live person with a birthday appears as an all-day entry every year, derived on read.

Behavior: for a requested range, for every live (not trashed) person with a valid `birthday`, and for every year the range touches (a range can span two years), the source returns an item with `kind` `birthday`, `id` `birthday:<personId>:<year>`, `personId`, `personName`, `title`, `date` (that year's date), `allDay` true, `calendarId` (the Birthdays calendar, null if absent) and `readOnly` true. Only month and day of the stored birthday matter. A birthday on 29 February falls on 28 February in a year that is not a leap year. No Events rows are created; the user edits a birthday only on the person.

Title: the calendar module catalog template `calendar.birthday.title` ("Birthday - {name}" / Czech "Narozeniny – {name}") with `{name}` the person's given name, which is the first word of `name` (the whole value when it has one word). The locale is the tenant user's locale (`cs` by default).

Decision: the given name is the first word of the person's name, as the design shows ("Birthday - Jana" for "Jana Kovářová"), not the full name.

Virtual entries are not items: their ids are not UUIDs, so the item routes (`PATCH`, `DELETE`, relation writes) reject them with 400 `validation_failed` and change nothing; this is the existing id validation and only needs a test.

#### Task

Load `testing` and `canonical-keys`.

1. Add `backend/packages/data/src/calendar/timelineBirthdaySource.ts` implementing the source above (one batched query over People for persons with a birthday), and add it to the source list in `backend/packages/data/src/calendar/timelineSources.ts`.
2. Add `calendar.birthday.title` to `backend/packages/data/src/calendar/i18n/cs.json` and `en.json`.
3. Tests: a person with `birthday` `2000-10-16` and `birthdayYearKnown` false yields items for 16 Oct 2026 and 16 Oct 2027 with her `personId` and the Birthdays `calendarId`; a range from 28 Dec 2026 to 5 Jan 2027 yields entries for the right year each; a `2000-02-29` birthday yields 28 Feb 2027 and 29 Feb 2028; a trashed person yields nothing; a person with no or an invalid stored birthday yields nothing and does not fail the timeline; the title is Czech or English by locale and uses the given name; `PATCH /api/items/birthday:<personId>:2026` returns 400 and changes nothing.

#### Touches

- backend/packages/data/src/calendar/timelineBirthdaySource.ts (new)
- backend/packages/data/src/calendar/timelineSources.ts (one registered source)
- backend/packages/data/src/calendar/i18n/cs.json (`calendar.birthday.title`)
- backend/packages/data/src/calendar/i18n/en.json (`calendar.birthday.title`)
- backend/packages/data/src/calendar/__tests__ (new source tests)

#### Scope

##### In scope

- The birthday timeline source, its title and the tests, including the rejection of virtual ids on item routes.

##### Out of scope

- The People properties and their validation: #1795.
- Public holidays: #1804.
- Opening the person from a birthday entry: the client; the entry carries `personId`.
- Birthday reminders on the day: the reminder issues, and only when the Birthdays calendar's `notify` is true.

#### Acceptance criteria

- When the timeline covers 16 Oct 2026 and 2027, then a birthday on 16 Oct yields an entry on each, with her `personId`, the Birthdays `calendarId`, `allDay` true and `readOnly` true.
- When a person is trashed, then no birthday entry is returned.
- When the birthday is 29 Feb, then the entry is on 28 Feb in a non-leap year.
- When a client patches or deletes a `birthday:...` id, then the response is 400 and nothing changes.

### Requirement gh-2015: [journal 20/21] Add the day's birthdays to the journal day response

#### Context

Model tier rationale: A filter over the timeline call the journal day already makes, adding one array of items an existing source produces, in one handler with existing fixtures; no new query, lifecycle or contract.

The Journal day is an overview of the day and stays consistent with the calendar, so it shows all-day events and birthdays as a compact row at the top. #1721 fills `events` in the Journal day response by calling the shared calendar timeline function once for the day and keeping the items of kind `event`, all-day events included. #1800 adds a birthday source to that timeline: for every live person with a valid `birthday` it returns an item with `kind` `birthday`, `id` `birthday:<personId>:<year>`, `personId`, `personName`, `title`, `date`, `allDay` true, `calendarId` (the Birthdays calendar, null if absent) and `readOnly` true; 29 February falls on 28 February in a year that is not a leap year.

Decision: the birthdays come from the same timeline call that #1721 makes; there is no second calendar read and no second implementation of the birthday rule. Public holidays stay out of the Journal day. The count in the day heading stays the length of `events`; birthdays are not counted.

#### Task

Load `testing` and `canonical-keys`.

1. In the Journal day response add `birthdays`, filled from the items of kind `birthday` returned by the timeline call that #1721 already makes for the day. Each element carries `id`, `personId`, `personName`, `title`, `date` and `calendarId` as given by the timeline. The array is empty when the day has no birthday.
2. Keep `events` exactly as #1721 defines it: no birthday appears in `events`.
3. Tests: a person with a birthday on 16 October appears in `birthdays` of the day 2026-10-16 with `personName` and the Birthdays calendar id, and is absent from `events`; a person born on 29 February appears in `birthdays` of 2027-02-28; a trashed person does not appear; the number of queries of the day read does not change when birthdays are present; a public holiday on the day appears in neither array.

#### Touches

- backend/packages/data/src/journal/journalRouteHandlers.ts (`birthdays` on the day response)
- backend/packages/data/src/journal/__tests__/ (birthday tests)

#### Scope

##### In scope

- The `birthdays` array of the Journal day response, taken from the existing timeline call.

##### Out of scope

- The birthday timeline source and its rules; #1800.
- The day's events and the all-day events among them; #1721.
- Public holidays in the Journal day (not shown there).
- How the client lays out the compact top row.

#### Acceptance criteria

- When the day 2026-10-16 is read and a person has a birthday on 16 October, then `birthdays` contains that person with `personName` and `calendarId`, and `events` does not contain it.
- When a person was born on 29 February, then the day 2027-02-28 lists the birthday.
- When the day has no birthday, then `birthdays` is an empty array.
- When the day has birthdays, then the day read issues no additional query.

### Requirement gh-1814: [health 06/09] Reject unknown select keys in Inbox proposals

#### Context

Model tier rationale: One extra check inside an existing envelope validation function that already routes failures to a card state, covered by existing tick and confirm fixtures.

An Inbox proposal carries `properties` for a target database. `assertValidProposalEnvelope` (`backend/packages/data/src/inbox/inboxTickAction.ts`) rejects unknown, relation, rollup and system properties but does not check a select value against the target's options. It is called when the tick writes a card, on revise, and on confirm (`confirmProposalWithClient` in `proposalActions.ts`). A failed tick computation becomes a card in state `needsClarification` (`writeNeedsClarification`); a failed revise or confirm returns 400. #1802 adds the same value check for item writes; this issue closes the same hole earlier, so a wrong value never reaches a card as a normal proposal.

#1990 gives the proposal computation the option catalog so it normally chooses valid keys; this check is the safety net when it does not.

Decision: the same rule as #1802: a `select` value is `null` or a known option key; a `multi_select` is an array of known keys; `null` and an empty array are accepted.

#### Task

Load `error-handling` and `testing`.

1. In `assertValidProposalEnvelope`, for an envelope of kind `database`, load the target database's `select` and `multi_select` properties and reject a value whose key is not in `config.options[].key` with `ValidationError` carrying `field` the property key. Do nothing for other envelope kinds.
2. Tests: a tick whose computed envelope has `tags: ["neznamy"]` for a Health record writes a `needsClarification` card; revise and confirm with the same value return 400 with `details.field` `tags`; `["medication"]` passes in all three; `null` passes; an envelope for a database without selects is unchanged.

#### Touches

- backend/packages/data/src/inbox/inboxTickAction.ts (`assertValidProposalEnvelope`)
- backend/packages/data/src/__tests__ (extend inbox proposal validation tests)

#### Scope

##### In scope

- Rejecting unknown select and multi-select keys in database proposal envelopes at tick, revise and confirm.

##### Out of scope

- The same check on item writes: #1802.
- Proposing a new option: #1994.
- Giving the computation the option catalog: #1990.

#### Acceptance criteria

- When a tick computes `tags: ["neznamy"]` for a health record, then the card is `needsClarification`.
- When a proposal is revised or confirmed with `tags: ["neznamy"]`, then the response is 400 with `details.field` `tags`.
- When `tags` is `["medication"]`, then tick, revise and confirm accept it.

## Touches

- docs/adr/ (one new ADR file)
- backend/packages/data/src/db/migrations/NNNN_<name>.sql (next free ordinal at commit time)
- backend/packages/data/src/agentGrants/agentDatabaseGrantsStore.ts (new)
- backend/packages/data/src/agentGrants/agentDatabaseAccess.ts (new)
- backend/packages/data/src/chokePoint/itemReads.ts
- backend/packages/data/src/chokePoint/itemWrites.ts
- backend/packages/data/src/chokePoint/relationOps.ts
- backend/packages/data/src/chokePoint/viewQueryOps.ts
- backend/packages/data/src/chokePoint/databaseOps.ts (database list and get)
- backend/packages/data/src/chokePoint/itemTrash.ts (grant cleanup on project purge)
- backend/packages/data/src/manifest/schemaProjection.ts (agent project filter)
- backend/packages/application/src/genericApplicationService.ts (actor passed to reads)
- backend/packages/application/src/genericOperationGateway.ts (only if the actor is not already passed through)
- backend/packages/data/src/index.ts (new export lines; admin functions excluded)
- backend/packages/data/src/__tests__/ (new grant enforcement tests)
- backend/packages/data/src/agentGrants/agentRunReadAllowancesStore.ts (new)
- backend/packages/data/src/agentGrants/agentDatabaseAccess.ts
- backend/packages/data/src/index.ts (new export line)
- backend/services/semprec-agents/src/refExpansion.ts
- backend/services/semprec-agents/src/agentRunTasks.ts (turn end cleanup hook, if the cleanup does not fit in the expander)
- backend/services/semprec-agents/src/__tests__/ (new tests)
- backend/packages/data/src/__tests__/ (new store and check tests)
- backend/services/semprec-api/src/mcp/mcpHandler.ts (actor marker in the human-token branch)
- backend/packages/shared/src/genericOperations/port.ts (actor type, only if the actor type is declared there)
- backend/packages/data/src/chokePoint/databaseOps.ts (database list and get for the marked actor)
- backend/packages/data/src/manifest/schemaProjection.ts (filter for the marked actor)
- backend/packages/application/src/genericApplicationService.ts (only if the marker is not passed through)
- backend/services/semprec-api/src/__tests__/ (new `/mcp` sensitivity tests)
- backend/packages/shared/src/genericOperations/capabilities.ts
- backend/packages/shared/src/genericOperations/bindings.ts
- backend/packages/application/src/genericOperationGateway.ts
- backend/packages/application/src/genericApplicationService.ts
- backend/packages/data/src/docs/pageOwnerDatabase.ts (new)
- backend/packages/data/src/index.ts (barrel export)
- backend/packages/shared/src/genericOperations/__tests__/ and backend/packages/application/src/__tests__/ (classification and grant tests)
- backend/packages/shared/src/genericOperations/operationNames.ts
- backend/packages/shared/src/genericOperations/schemas.ts
- backend/packages/shared/src/genericOperations/port.ts
- backend/packages/data/src/journal/ (call into the lazy-create function; export only)
- backend/packages/data/src/__tests__/ and backend/packages/application/src/__tests__/
- backend/packages/data/src/journal/ (call into `mergeJournalDuplicates`; export only)
- backend/packages/shared/src/sempMessageRef.ts (new variant)
- backend/packages/shared/src/__tests__/sempMessageRef.unit.test.ts
- the ref validation of the Semp message endpoint introduced by #1682 (accept the variant)
- backend/services/semprec-agents/src/refExpansion.ts (sleepNight branch)
- backend/services/semprec-agents/src/__tests__/refExpansion.unit.test.ts
- the one-run read access of #1849 (one added kind)
- backend/packages/data/src/calendar/timelineBirthdaySource.ts (new)
- backend/packages/data/src/calendar/timelineSources.ts (one registered source)
- backend/packages/data/src/calendar/i18n/cs.json (`calendar.birthday.title`)
- backend/packages/data/src/calendar/i18n/en.json (`calendar.birthday.title`)
- backend/packages/data/src/calendar/__tests__ (new source tests)
- backend/packages/data/src/journal/journalRouteHandlers.ts (`birthdays` on the day response)
- backend/packages/data/src/journal/__tests__/ (birthday tests)
- backend/packages/data/src/inbox/inboxTickAction.ts (`assertValidProposalEnvelope`)
- backend/packages/data/src/__tests__ (extend inbox proposal validation tests)

## Scope

### In scope

- Exactly the combined backend Tasks and AC in the requirement snapshots above, including their named tests, migrations and production composition roots.
- Coordinating shared files and migration ordinals across members, without duplicate registration or duplicate ownership.
- Independent review of the entire batch and an explicit verdict for every source criterion.

### Out of scope

- Web/mobile source, screens, navigation, client localization and client validation.
- Requirements not included in this batch, except prerequisites already delivered by earlier batches.
- Automatic approval, automatic deployment, production security sign-off by implementers, and closing a source issue merely because its code was written.

## Acceptance criteria

- Every criterion under every embedded source Acceptance criteria section passes with recorded evidence; none may be sampled, silently omitted or treated as implemented by a stub.
- Required backend tests and functional scenarios exercise production paths, including relevant failures, tenant isolation, concurrency, idempotency and populated-tenant migrations.
- Independent review has no unresolved medium-or-higher findings. Confirmed findings are fixed and affected evidence is rerun against the final candidate SHA.
- The full backend `pnpm run verify` passes. No web or mobile verification is required. A missing external service or required live-provider check is BLOCKED/NOT RUN, never PASS.
- Only after this entire gate passes may this batch and its approved source records be completed with individual handovers pointing to the verified implementation. All source approvals must still match their specifications.
- The next sequential batch starts only after this batch's gate passes; a failure holds advancement.
