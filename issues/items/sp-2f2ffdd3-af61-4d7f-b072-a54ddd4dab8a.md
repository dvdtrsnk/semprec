---
schemaVersion: 1
id: "sp-2f2ffdd3-af61-4d7f-b072-a54ddd4dab8a"
title: "[backend-delivery 61/74] Implement data/mail, data/search, shared/genericOperations changes"
kind: "implementation"
state: "open"
stateReason: null
labels: ["spec:proposed","execution:batch","execution:sequential"]
parent: "sp-62331d42-78af-4b93-ae97-d5ccbe3324df"
assignees: []
milestone: null
createdAt: "2026-10-31T17:31:02.067Z"
updatedAt: "2026-10-31T17:31:02.067Z"
closedAt: null
source: null
approval: null
resolution: null
---
**Blocked by:** sp-c085d86f-fed6-4d7c-b983-a73c72d95223
**Model tier:** high

## Context

Model tier rationale: This delivery combines several existing backend specifications across typed storage, API and runtime boundaries; preserving their contracts and verifying the combined behavior requires cross-module reasoning.

Use one working tree and one source-writing agent at a time. Implement the complete batch before independent review, AC acceptance and full backend verification. Original feature epics remain reporting groups, not execution units. Preserve every embedded Task, decision and acceptance criterion. Each member's Out of scope limits that member; it does not prohibit another explicitly included member's Task. Do not add behavior beyond the union of member Tasks.

Web and mobile implementation, client catalogs, client builds and client tests are excluded. Backend contracts and server-side tests for device/platform behavior remain included. Product UI descriptions are context only. Do not remove existing client-required backend data merely because client work is deferred.

Follow the scoped execution exception in docs/adr/2026-10-31-sequential-backend-delivery-batches.md. Before starting, reconcile this checkout with any newer local integration history; already-delivered work needs evidence and handover reconciliation, not reimplementation. No source or batch is completed by this planning change.

This is a proposed specification, not execution authorization. Obtain owner approval for this exact batch before queueing. Included unapproved source specifications also remain unapproved.

Execution order: gh-1859 → gh-1996 → gh-1865 → gh-1867 → gh-1869 → gh-1872 → gh-1874 → gh-1870 → gh-1873 → gh-1876. Internal prerequisites are included earlier in this order; prerequisites assigned to previous batches must have passed their gates first. Preserve declared source dependencies; no shared-file dependency has been discarded.

## Task

Implement the following immutable requirement snapshots in the listed order. Load each snapshot's required topic skills. Keep an AC evidence matrix keyed by source ID and criterion, with production entry point, implementation SHA, test/scenario, log path and verdict. Write required tests with the implementation and use targeted checks during development; perform independent review and the complete backend gate after the batch is implemented.

### Requirement gh-1859: [global-search 08/09] Return Journal periods in shared search results

#### Context

Model tier rationale: A small additive extension of one existing operation output over data already in the index, but it changes a shared output schema used by REST, MCP and agents, so it needs care with the existing contract tests.

The grouped search operation (#1842) returns Journal days and weeks as ordinary item results. A client cannot show a human title such as "Pátek 16. října" or "Týden 42", and cannot open the Journal at that period, without the period itself. Journal items already store it: the Journal database has a system `type` select (`year`, `quarter`, `month`, `week`, `day`; `JOURNAL_PERIOD_TYPES` in `journal/journalStore.ts`) and a `period` text in canonical form (`2026-10-16`, `2026-W42`, `2026-08`, `2026-Q3`, `2026`).

Journal text reaches the index through #1658 (page text and the text of a day's Inbox entries).

Decision: the server returns only the canonical `type` and `period` values; the localised label ("Pátek 16. října") is composed by each client, because it depends on the user's language and, for relative words, on the clock.

Shared-file ordering: this issue also waits for #1858 because both edit the same registry, manifest, cutover, route matrix or hook files listed in Touches.

#### Task

Load `canonical-keys` and `testing`.

1. Extend the `search` output schema in `shared/genericOperations/schemas.ts` so a result in the `journal` group carries `journal: { type, period }`. `type` is one of the Journal period types and `period` is the stored canonical string. Results of other groups do not carry the field.
2. In the search operation's journal group (the code added by #1842), fill `journal` from the item's `type` and `period` properties. A Journal item with a missing or unknown value is dropped from the group rather than returned malformed.
3. Update the generic operation JSON schema and port types accordingly and the REST contract test for `GET /api/search`.
4. Tests: a day result carries `{ type: "day", period: "2026-10-16" }`, a week result `{ type: "week", period: "2026-W42" }`; the journal group never contains an Inbox item or a trashed entry; no localised period label appears in the response.

#### Touches

- backend/packages/shared/src/genericOperations/schemas.ts (`search` output: `journal` field)
- backend/packages/shared/src/genericOperations/port.ts (output type, if the output type is declared there)
- backend/packages/data/src/search/searchItemsQuery.ts (journal group result mapping)
- backend/services/semprec-api/src/__tests__/tenantIsolationRoutes.test.ts (only if the search route entry needs the new field)

#### Scope

##### In scope

- The `journal { type, period }` field on journal-group results.

##### Out of scope

- The search operation itself, group order, trash and tenant filtering, ranking: #1842.
- Indexing page and journal text: #1658.
- Titling Journal entries: #1711.
- Localised period labels and opening the Journal at a period: clients.
- Excerpts from `body`.

#### Acceptance criteria

- When a Journal day for 2026-10-16 matches a search, its result carries `journal { type: "day", period: "2026-10-16" }`.
- When the Journal week 42 of 2026 matches, its result carries `journal { type: "week", period: "2026-W42" }`.
- Results of other groups have no `journal` field.
- The journal group contains no Inbox item and no item in the trash.
- The response contains no localised period label.

### Requirement gh-1996: [global-search 09/09] Return excerpts for page and journal text hits in search results

#### Context

Model tier rationale: One read-side mechanism (build an excerpt with `ts_headline` from a column the index already stores) inside an existing operation and its existing tenant and grant filtering, with no new write path, migration or authorization contract.

A hit in the text of a page (project notes, subpages, an item's own page) or of a Journal day is reported in the group of the item the page belongs to, with an excerpt that shows where the words were found. There is no separate "Pages" group. #1658 stores the readable excerpt source in `item_search_index.body` (for a Journal day, the text of its Inbox entries followed by the day's page text; for every other item, its page text), and the search operation from #1842 returns `snippet` as `null` for every item-backed result. This issue fills `snippet` from `body`.

The query builder and the combined vector come from #1589 (`search/itemSearchQuery.ts`). #1859 adds the `journal { type, period }` field to journal results and #1854 adds the thread-backed chat group; both edit the same query file as this issue.

Decisions:
- `snippet` is returned only for an item-backed result whose `body` itself matches the query (the same combined `czech` and `czech_simple` vector and the same tsquery as the index match). A result found only through its title or other properties keeps `snippet: null`.
- The excerpt is at most 160 characters of plain text, built with `ts_headline` over `body` without highlight markers (`StartSel` and `StopSel` empty), so clients receive no markup.
- Thread-backed results (`mail`, `chat`) are unchanged: their snippets are owned by their own issues.
- The query text never reaches logs or error messages.

Shared-file ordering: this issue also waits for #1854, #1859 because they edit the same files listed in Touches.

#### Task

Load `testing` and `io-hardening`.

1. Add `search/searchSnippet.ts` exporting the SQL fragment builder for the excerpt: given the bound tsquery from the #1589 builder, it yields `CASE WHEN body IS NOT NULL AND (to_tsvector('czech', body) || to_tsvector('czech_simple', body)) @@ <query> THEN left(ts_headline('czech_simple', body, <prefix query>, 'StartSel="", StopSel="", MaxFragments=1, MaxWords=25, MinWords=8'), 160) ELSE NULL END`, where `<prefix query>` is the `czech_simple` prefix part of the same builder output. Every value is a bind parameter.
2. In `search/searchItemsQuery.ts`, select the excerpt for the returned rows only (after the per-group limit and cursor are applied, not for every match) and map it to `snippet` of item-backed entries in every item group.
3. Tests with the fixed clock 2026-10-16, see acceptance criteria.

#### Touches

- backend/packages/data/src/search/searchSnippet.ts (new)
- backend/packages/data/src/search/searchItemsQuery.ts (excerpt selection and `snippet` mapping)
- backend/packages/data/src/search/__tests__/searchSnippet.test.ts (new)

#### Scope

##### In scope

- `snippet` of item-backed search results built from `item_search_index.body`.

##### Out of scope

- Storing `body` and `page_text`: #1658.
- The search operation, its groups, ranking and visibility rules: #1842.
- Mail and chat snippets: their own group issues (#1854 keeps chat `snippet` `null`).
- A separate result group for pages: not planned; page hits stay in the owner's group.
- Highlighting matched words in the client.

#### Acceptance criteria

- Given a Journal day 2026-10-16 whose Inbox entry text contains "Standup v pohodě, klient schválil rozsah druhé fáze", when searching "klient schválil", then the day's result in the `journal` group has a `snippet` containing "klient schválil" of at most 160 characters.
- Given a project "Semprec iOS" whose page contains "rozpočet schválený", when searching "rozpocet", then the project's result in the `project` group carries a `snippet` containing "rozpočet", and no other group contains the page.
- Given a task "Odeslat fakturu" without a page, when searching "faktur", then its result has `snippet` `null`.
- Given a project whose title matches the query but whose page text does not, then its result has `snippet` `null`.
- The `snippet` contains no highlight markup.
- A query containing `& | ! : '` and parentheses produces no error and no SQL built from the query text.
- Neither logs nor error responses contain the query text.

### Requirement gh-1865: [mail-threads 25/28] Mark a mail thread read or unread

#### Context

Model tier rationale: One new transactional route that writes several Emails items through the existing update path and the new invalidation, with clear rules but several seams (thread resolution, own-message classification, hook, realtime).

The Mail screen toggles a conversation as read or unread. Today a client can only patch single messages through `PATCH /api/items/:id`, which needs the item's current version and has to be repeated per message. The hook that records the provider write-back runs only when a message is written through `updateItemWithClient`, so the thread route must write through it (#1494 then queues the sync).

The design shows read state only at conversation level, and opening a conversation should mark it read. Own sent messages are always read (#1461) and are never changed.

Decisions: `read: true` sets `read=true` on every incoming message of the thread (not own, not in Sent or Drafts), on every copy in every mailbox; `read: false` sets `read=false` only on the last incoming message (and its copies in other mailboxes); versions are loaded by the server, so the last write wins; everything runs in one transaction; the route sends exactly one `mailThread` invalidation (#1816) after commit; a merged thread id is translated (#1493); the client is expected to call it with `read: true` when a conversation is opened.

Shared-file ordering: this issue also waits for #1859, #1864 because both edit the same registry, manifest, cutover, route matrix or hook files listed in Touches.

#### Task

Load `state-writes` and `testing`.

1. Add `backend/packages/data/src/mail/mailThreadActions.ts` with shared helpers used by the thread action routes: resolve the thread id (alias translation, 404 `not_found` for unknown or foreign), list the thread's counted messages with their own/incoming classification and last-incoming message, and the after-commit invalidation call.
2. Implement `POST /api/mail/threads/:threadId/read` with body `{ read: boolean }` (400 on anything else), declared in `mailModuleManifest.ts` (`handlerExport` `createMailThreadReadRouteHandler`, justification `transactional-semantics`) with a `routeMatrix.ts` entry. Write each message with `updateItemWithClient` so the flag hook runs. Skip writes whose value already matches.
3. Response `{ threadId, unread }` with the thread id after translation and its resulting unread state.
4. Add tests: on the four-message fixture `read:true` sets both incoming messages of Petr and leaves the sent ones; `read:false` changes only the last incoming; a copy in a second mailbox changes too; one invalidation per call and none after a rollback; the desired-state rows exist for changed messages; a merged id works; an unknown or foreign id is 404.

#### Touches

- backend/packages/data/src/mail/mailThreadActions.ts (new)
- backend/packages/data/src/mail/mailThreadRoutes.ts (read handler)
- backend/packages/data/src/mail/mailModuleManifest.ts (customRoutes entry and handler export)
- backend/packages/data/src/index.ts (export line)
- backend/services/semprec-api/src/routeMatrix.ts
- backend/services/semprec-api/src/__tests__/tenantIsolationRoutes.test.ts
- backend/packages/data/src/__tests__/mailThreadRead.test.ts (new)

#### Scope

##### In scope

- `POST /api/mail/threads/:threadId/read` and the shared thread-action helpers.

##### Out of scope

- Flagging: #1893; archive and trash: #1917.
- Queuing the provider sync: #1494.
- Client behavior (calling it when a conversation is opened).

#### Acceptance criteria

- When `read:true` is posted for "Re: Nabídka na web", then both incoming messages from Petr are read and the sent messages are unchanged.
- When `read:false` is posted, then only the last incoming message becomes unread.
- When the call succeeds, then exactly one `mailThread` invalidation is sent; when it fails, none.
- When the id is unknown or another tenant's, then the response is 404.

### Requirement gh-1867: [mail-compose 09/12] Create, read, update and discard drafts over HTTP

#### Context

Model tier rationale: This adds a new write path that atomically creates and updates an item, a metadata row and a folder edge under system-owned properties, with optimistic concurrency, actor attribution, address authorization and invalidations.

Users and Semp write and edit mail drafts. Today the Emails properties `name`, `recipients` and `body` are system-owned, so the generic item PATCH rejects them, `createEmailDraft` (`backend/packages/data/src/mail/draft.ts`) is never called, and no route exists. A draft therefore cannot be created, reopened, edited or discarded from the app.

It builds on the structured draft storage (#1504) and on thin mail-thread realtime invalidations (#1816). Reply, forward, attachments and sending (#1899, #1895, #1896) and the agent's thread and draft tools (#1927) call this interface.

Custom routes need a justification (`backend/packages/module-registry/src/manifest.ts`): create and update touch an Emails item, a `mail_drafts` row and the Drafts edge in one transaction (`transactional-semantics`); reading a draft is a read shaped for one consumer (`single-consumer-read`).

Decision: the body is plain text and the outgoing MIME part is `text/plain`.

Decision: the app creates the draft on the first change in the compose window (a debounced autosave PATCH or POST), so that it has an id to drag onto Semp and appears in the Drafts folder. Cancelling the window keeps the draft; the client discards an empty new draft with DELETE.

Shared-file ordering: this issue also waits for #1865 because both edit the same registry, manifest, cutover, route matrix or hook files listed in Touches.

#### Task

Load `state-writes`, `error-handling`, `io-hardening`, `canonical-keys` and `testing`.

1. `POST /api/mail/drafts` with `{ mailboxId, from, to, cc, bcc, subject, body, threadId?, mode?, sourceEmailId? }` creates the draft through the module's writer (the `EMAIL_INGEST_ALLOWED_SYSTEM_KEYS` write path), the `mail_drafts` row and the Drafts folder edge in one transaction. `PATCH /api/mail/drafts/:id` takes the same fields and an `ifVersion` equal to the draft's `updatedAt`. `GET /api/mail/drafts/:id` returns the draft. `DELETE /api/mail/drafts/:id` soft-deletes it. Register all four in the mail module manifest and the route matrix.
2. The response shape is `{ id, mailboxId, from, to, cc, bcc, subject, body, threadId, mode, sourceEmailId, attachments: [{ fileItemId, blobId, filename, byteSize }], createdBy, lastEditedBy, updatedAt, sentAt }`; the attachments list is empty until #1895 fills it.
3. A `from` address that the mailbox does not have answers 403 `from_address_not_registered` (the existing code). A stale `ifVersion` answers 409 `version_conflict`; editing or deleting a sent draft answers 409 `mail_draft_already_sent` (add the code). `PATCH` records `last_edited_by` from the acting user or agent.
4. A draft without a `mail_drafts` row (a provider draft) cannot be changed or discarded: PATCH, DELETE and sending answer 409 `mail_draft_not_editable` (add the code), and it is not counted among Semp drafts.
5. Every successful change publishes the thin mail-thread invalidation from #1816 for the draft's thread.

#### Touches

- backend/packages/data/src/mail/mailDraftRouteHandlers.ts (new)
- backend/packages/data/src/mail/draft.ts (update and discard operations)
- backend/packages/data/src/mail/mailModuleManifest.ts (`customRoutes`)
- backend/packages/data/src/index.ts (barrel export)
- backend/services/semprec-api/src/routeMatrix.ts
- backend/services/semprec-api/src/adapter/errorContract.ts (`mail_draft_already_sent`, `mail_draft_not_editable`)
- backend/services/semprec-api/src/__tests__/tenantIsolationRoutes.test.ts
- backend/packages/data/src/__tests__/mailDraftRoutes.test.ts (new)

#### Scope

##### In scope

- Create, read, update and discard routes with versioning, address authorization, actor attribution and invalidation.

##### Out of scope

- Reply, reply-all and forward prefill (#1899), attachments (#1895), contact suggestions (#1507).
- Sending (#1896).
- Semp-written drafts and their per-thread rule at the tool level (#1927).
- Uploading the draft to the provider.

#### Acceptance criteria

- When a draft is saved and reopened, then it has the same recipients and the same sending mailbox.
- When the first edit is made, then the draft exists and is in the mailbox's Drafts folder.
- When PATCH carries a stale `ifVersion`, then it answers 409 `version_conflict`; when the draft is sent, then 409 `mail_draft_already_sent`.
- When PATCH targets a Gmail draft without a `mail_drafts` row, then it answers 409 `mail_draft_not_editable`.
- When a `from` address is not one of the mailbox's addresses, then the answer is 403 `from_address_not_registered`.
- When an agent creates a second unsent draft for a thread, then the database rejects it and the route answers 409.
- A draft of another tenant is not readable or writable.

### Requirement gh-1869: [mail-items 06/15] Inherit a thread's company and project from its sender

#### Context

Model tier rationale: This defines the first module resolver for the value-link mechanism (domain matching, a new link-source kind persisted in a migration, merge precedence) and each piece is a persisted-data or isolation-sensitive contract, so the work needs the higher tier.

A thread has a company and a project. Instead of making the user set them, they are inherited: the company from the sender of the thread, the project from the company. Today nothing is inherited anywhere: the value-link store (#1403) records where an inherited value came from and its breaking rules (#1516) end the link when a user or Semp writes the value. Rules are declared in module manifests (#1411) and recomputed by the propagation job `valueLinks.propagate` (#1593). The Threads database with the relations Threads.company and Threads.project exists after #1573; thread invalidations are published by #1816.

Decisions: the sender of a thread is the author of its first inbound message. Freemail domains never match a company. Zero or several matching companies means empty. The sender-domain link source is added by this issue.

Next, #1897 returns the link state, #1898 propagates the project to attachments, and #1900 uses the project for tasks.

Shared-file ordering: this issue also waits for #1867 because both edit the same registry, manifest, cutover, route matrix or hook files listed in Touches.

#### Task

Load `state-writes`, `db-migrations`, `canonical-keys` and `testing`.

1. Declare two link rules in `mail/mailModuleManifest.ts` with a module resolver in `mail/threadLinkRules.ts`:
   - company: the sender's address domain is matched against `Companies.web` hosts (host equal to the domain or the domain being a subdomain of the host, case-insensitive, `www.` ignored). For a sender known in `person_email_index` (`mail/personEmailIndexStore.ts`): only companies in that person's `People.companies` whose web host matches; the link source is that person (`source_item_id` of the person, property `companies`). For an unknown sender: the company whose web host matches the domain; the link source is the sender domain. A freemail domain (maintained constant list in code, at least gmail.com, googlemail.com, outlook.com, hotmail.com, live.com, icloud.com, me.com, yahoo.com, seznam.cz, email.cz, centrum.cz, post.cz, atlas.cz, volny.cz, proton.me, protonmail.com) never yields a company.
   - project: source Threads.company, the single project among the company's `Companies.projects` with status `inProgress` or `longTerm`, otherwise empty. It is inherited from Threads.company whether that value was inherited or entered by the user; clearing the company clears an inherited project.
2. Migration `backend/packages/data/src/db/migrations/NNNN_value_link_sender_domain.sql (next free ordinal at commit time)` on `value_link_sources`: add `source_kind` (`item` | `senderDomain`, existing rows `item`), `source_domain text NULL`, and make `source_item_id` nullable for `senderDomain` rows (a check constraint ties the columns to the kind). Add the variant `{ kind: 'senderDomain', domain }` to the `links.sources` type of the value-link read shape, and make relink for a `senderDomain` source succeed when a company with that domain in `Companies.web` currently exists.
3. Recomputation inputs: the resolver declares the edges `People.companies` and `Companies.projects` and the properties `Companies.web` and `Projects.status` as source changes (edge changes through the hook of #1530), so a change of any of them runs `valueLinks.propagate` for the affected threads. After ingest of a thread's first inbound message, trigger the evaluation of both rules for that thread through the entry point of #1593.
4. Every change of company or project of a thread publishes the `mailThread` invalidation of #1816.
5. Merge (extends `reassignThread` from #1573): when both threads have a value, the own value beats an inherited one; between equal kinds the thread with the older `mail_threads.created_at` wins; the project inherited by the winner's attachments is recomputed through the propagation job.

#### Touches

- backend/packages/data/src/mail/mailModuleManifest.ts (linkRules)
- backend/packages/data/src/mail/threadLinkRules.ts (new; resolver, freemail list)
- backend/packages/data/src/mail/mailMessageMetaStore.ts (`reassignThread` precedence)
- backend/packages/data/src/mail/ingest.ts (trigger after the first inbound message)
- backend/packages/data/src/db/migrations/NNNN_value_link_sender_domain.sql (next free ordinal at commit time)
- backend/packages/data/src/mail/__tests__/ (new resolver, relink and merge tests)

#### Scope

##### In scope

- The company and project link rules and their resolver, the sender-domain link source with its migration and relink, the invalidations, and the merge precedence.

##### Out of scope

- The link store, breaking on writes, unlink and relink operations themselves (#1403, #1516, #1587).
- The propagation job (#1593).
- Returning company, project and links in thread responses (#1897).
- Project assignment by Semp (#1872); the warning text before Semp ends a link is part of the generic approval flow.

#### Acceptance criteria

- A thread whose first inbound message is from a known person whose company web host matches the sender domain has that company and its single active project, both marked inherited.
- A thread from a freemail address of a person in a company has no company and no project; a thread from an unknown address of a company's domain has that company with a sender-domain source.
- When the company's project changes, the thread's inherited project changes; when a user sets the project by hand, the link ends and a later company change does not touch it; relink restores it.
- Setting "no company" on a thread clears its inherited project.
- After a merge, the winner keeps its own value over an inherited one; with two equal kinds the older thread's value remains.

### Requirement gh-1872: [mail-items 07/15] Let Semp assign a project to an unlinked thread

#### Context

Model tier rationale: This combines a budgeted AI call outside a transaction with a staleness-checked write attributed to an agent, and the choice of writer identity touches the single-writer ownership rules, so the failure modes need the higher tier.

Some threads get no inherited project, for example a newsletter or a notification, because their sender is in no company. For those, Semp should sort the thread: pick a project as the thread's own value and otherwise leave it empty. Nothing of this exists: the Threads database comes from #1573 and thread invalidations from #1816.

Decisions:
- The assignment is written by Semp as an agent writer through the generic `relation.put` path (a non-destructive operation, so no approval is needed under `docs/adr/2026-09-18-non-destructive-generic-operations-bypass-agent-approval.md`), not by a system job that owns `Threads.project`. This keeps the single-writer ownership model (`docs/adr/2026-09-10-single-writer-ownership-model.md`) unchanged because the property stays user-owned.
- The value is written without a `value_links` row, so it is the thread's own value and ends no link.
- An assignment by Semp never carries permission for autonomous mail sending.
- When unsure, the project stays empty. An exhausted tenant AI budget skips the thread silently.

Shared-file ordering: this issue also waits for #1869 because both edit the same registry, manifest, cutover, route matrix or hook files listed in Touches.

#### Task

Load `ai-gateway`, `state-writes`, `error-handling` and `testing`; follow `docs/adr/2026-09-10-bracket-non-transactional-calls-with-staleness-checked-transactions.md`.

1. Add a module task `mailTriageThreadProject` (declared in `mail/mailModuleManifest.ts` `taskNames`, runtime affinity as the other mail tasks) with payload `{ threadItemId }`, single-flight per thread. Enqueue it after the commit of a new thread's first inbound message, delayed so that sender inheritance (#1869) has been evaluated first.
2. At run time read the thread: skip when it is soft-deleted, has a Threads.project edge, or has an inherited project link row.
3. Outside any transaction call the ai-gateway with the cheap model class and the tenant budget: input is the subject, the first inbound message text cut to 4000 characters, the sender, and up to 50 candidate projects (id, name, status `inProgress` or `longTerm`, most recently changed first). Validate the answer against a schema `{ projectId: uuid | null, confidence: number }`; accept only a `projectId` from the candidate set with confidence at least 0.8, otherwise leave empty. Record the usage under a feature key `mailThreadProject`.
4. In a new transaction re-check the skip conditions from step 2; if the thread is unchanged, write Threads.project through the generic relation put with the agent writer kind. If the write conflicts or the thread changed, drop the result.
5. Publish the `mailThread` invalidation of #1816 through the normal write path.

#### Touches

- backend/packages/data/src/mail/threadProjectTriage.ts (new)
- backend/packages/data/src/mail/mailModuleManifest.ts (`taskNames`)
- backend/packages/data/src/mail/ingest.ts (enqueue after the first inbound message)
- backend/packages/data/src/mail/__tests__/ (new tests with a stubbed gateway)

#### Scope

##### In scope

- The triage task, its AI call, candidate selection, validation and the staleness-checked agent write.

##### Out of scope

- Inheritance of company and project from the sender (#1869).
- Approval for ending a link when Semp writes an inherited value (generic link handling; the warning text only is mail-specific).
- A user setting that turns triage off; this work is not planned yet and waits for a product decision.

#### Acceptance criteria

- A thread with no project and no inherited link, with a clear answer from the gateway, receives that project as its own value and no `value_links` row exists for it.
- When the gateway answer is empty, below the confidence threshold, or names a project outside the candidates, the project stays empty and no error is recorded.
- When the tenant AI budget is exhausted, the thread is skipped without an `agent_run_error` notification.
- When the user set a project or inheritance filled it between the AI call and the write, the AI result is discarded.

### Requirement gh-1874: [mail-items 08/15] Count mail threads in a record's Souvislosti

#### Context

Model tier rationale: Registers one module-specific count path and one omission in the related-collections declaration whose mechanism is built elsewhere, so the risk is correct wiring and counting unit, with existing fixtures.

The record detail shows a "related" list with a count per collection, served by the relation-related operation (#1839), whose collection order is declared per module (#1517). For a person, the generic path would return the whole Emails collection with a message count (for example 4). The product shows mail for a person as a count of threads. For a project, an area and a company the "Mail" row (counted through Threads.project, via the project for an area, and Threads.company) is produced by #1839 itself once the Threads database exists (#1573).

Decision: the unit is threads. A person with one thread of four messages shows 1.

Shared-file ordering: this issue also waits for #1872 because both edit the same registry, manifest, cutover, route matrix or hook files listed in Touches.

#### Task

Load `canonical-keys` and `testing`.

1. In `mail/mailModuleManifest.ts` declare the person path of the related operation as defined by #1517 and #1839: for a People item the count of distinct Threads that contain a not-deleted message with an edge `Emails.senderPeople` or `Emails.recipientsPeople` to that person.
2. Add the Emails collection to the manifest's list of collections omitted from the People related result, so the operation returns no Emails entry for a person.
3. Messages in the Trash folder are not counted; a thread counts when at least one of its matching messages is not deleted.

#### Touches

- backend/packages/data/src/mail/mailModuleManifest.ts (related declaration for People and the omission)
- backend/packages/data/src/mail/threadRelatedCount.ts (new; the count query)
- backend/packages/data/src/mail/__tests__/ (new tests)

#### Scope

##### In scope

- The person-to-threads count path and the omission of Emails for a person.

##### Out of scope

- The project, area and company mail rows and the operation itself (#1839).
- The ordering mechanism (#1517).
- Any change to client copy.

#### Acceptance criteria

- For a person who is sender in one thread with four messages, the related result contains a mail entry with count 1 and no Emails entry.
- For a person with no mail, no mail entry is returned.
- A message in Trash only does not produce a count.

### Requirement gh-1870: [transcripts 16/19] Mount the proposal revise route with an optional message

#### Context

Model tier rationale: One new custom route over an existing, already tested domain function, following the confirm route's registration pattern; the route matrix and tenant-isolation test registrations are routine, and the version check reuses the choke point's existing `ifVersion` handling.

`reviseProposalWithClient` in `backend/packages/data/src/inbox/proposalActions.ts` exists since the first Inbox pipeline issue but has no HTTP route; only `POST /api/proposals/:id/confirm` is mounted (`backend/packages/data/src/inbox/inboxModuleManifest.ts`, handler in `inboxRouteHandlers.ts`). Its input is `{ message, entityKind, target, properties }`: it replaces the card's whole envelope, re-validates it as confirm would (`assertValidEnvelopeForCard`, which also forbids a transcript card to switch between an Event proposal and a speaker mapping), refuses a locked (`confirmed` or `rejected`) card, sets the status back to `proposed` and appends a history entry.

Clients need to correct a card: choose another Event or another person for a transcript card (a `relation` envelope), change the values of a new-item proposal, or give Semp an instruction in words. This issue mounts `POST /api/proposals/:id/revise` for those cases. It builds on the reject route (#1845, which owns the shared card-action route pattern and ordering of the Inbox manifest), on the card-state properties and the gateway operations of #1451 and #1392, and on the realtime publishing of #1383 so that other devices see the revised card. Semp's own instruction handling, which recomputes a transcript card from a message, is #1940; the agent tool that calls this route is #1906; editing single fields is #1892.

Decisions:

- The body is `{ entityKind?, target?, properties?, message?, ifVersion? }`. The three envelope fields are all-or-nothing (a partial envelope is never merged): either all three are sent or none. At least the envelope or a `message` is required, otherwise `400 validation_failed`.
- A `message` without an envelope is allowed only for transcript cards (`kind = transcript`); for any other card it is `400 validation_failed` (field `message`). For a transcript card, this issue records the instruction as a user history entry and leaves the card's status and envelope untouched; acting on the instruction is #1940.
- The target of a relation envelope may be any live item that passes the existing validation, not only one listed in the card's candidates.
- `ifVersion` is the card's `updatedAt`. A mismatch is the existing `409 version_conflict` with the current card in `details.currentItem`. A locked card keeps today's `400 validation_failed` (field `status`); moving locked-card refusals to a dedicated 409 code is left to the issue that introduces that code.
- Without a `message` the history entry text is "Revised by user.".

Shared-file ordering: this issue also waits for #1867 because both edit the same registry, manifest, cutover, route matrix or hook files listed in Touches.

#### Task

Load `state-writes`, `error-handling`, `io-hardening` and `testing`.

1. Change `ReviseProposalInput` and `reviseProposalWithClient` in `proposalActions.ts` to accept an optional envelope (all of `entityKind`, `target`, `properties` or none), an optional `message` and an optional `ifVersion`. With an envelope the behavior is unchanged (validation through `assertValidEnvelopeForCard`, status `proposed`, history entry); with a `message` only (transcript cards only) append the user history entry and change nothing else. Pass `ifVersion` to the card update so the existing version check applies. Existing callers and tests that pass the full input keep working.
2. Add `createReviseProposalRouteHandler(pool)` to `inboxRouteHandlers.ts`: parse the body strictly (reject unknown keys, wrong types, a partial envelope, an empty body) with the same `ValidationError` conventions as `parseConfirmCredential`, run the revise in one transaction and answer `200` with the updated card.
3. Register the route in `inboxModuleManifest.ts` (`customRoutes`: name `reviseProposal`, `POST /api/proposals/:id/revise`, `handlerExport: "createReviseProposalRouteHandler"`, justification `transactional-semantics`: the envelope validation against live destination state, the lock and the status transition commit together) and re-export the handler on the manifest's export line; add the entry to `backend/services/semprec-api/src/routeMatrix.ts` the case to `backend/services/semprec-api/src/__tests__/tenantIsolationRoutes.test.ts` (case table and request list) and the handler mapping to `backend/services/semprec-api/src/__tests__/chokePointWriteBoundary.unit.test.ts`. Place the manifest entry after the reject route's, as the ordering of the Inbox routes requires.
4. Tests in `backend/packages/data/src/inbox/__tests__/inboxRouteHandlers.test.ts` and `proposalActions.test.ts`: revise a transcript Event card to another Event (relation envelope) without a message; revise with a message only on a transcript card (history entry added, envelope and status unchanged) and on an `inbox` card (400); a partial envelope and an empty body (400); a locked card (400, field `status`); a stale `ifVersion` (409 `version_conflict` with the current card, nothing written); a speaker card revised to an Event envelope (400, role switch); an unknown and a foreign card id answer identically (404).

#### Touches

- backend/packages/data/src/inbox/proposalActions.ts (`ReviseProposalInput`, `reviseProposalWithClient`)
- backend/packages/data/src/inbox/inboxRouteHandlers.ts
- backend/packages/data/src/inbox/inboxModuleManifest.ts (`customRoutes` entry, export line)
- backend/services/semprec-api/src/routeMatrix.ts (one entry)
- backend/services/semprec-api/src/__tests__/tenantIsolationRoutes.test.ts (one case)
- backend/services/semprec-api/src/__tests__/chokePointWriteBoundary.unit.test.ts (route to handler file mapping)
- backend/packages/data/src/inbox/__tests__/inboxRouteHandlers.test.ts
- backend/packages/data/src/__tests__/proposalActions.test.ts

#### Scope

##### In scope

- The `POST /api/proposals/:id/revise` route, its strict body parsing, the optional `message` for transcript cards and the optional `ifVersion`.

##### Out of scope

- Recomputing a transcript card from the user's instruction: #1940.
- The `inbox.proposal.revise` agent tool: #1906.
- Editing single fields of a card and the manual-edit history: #1892.
- The reject route and `ifVersion` on confirm and reject: #1845, #1852.
- A new error code for locked cards.

#### Acceptance criteria

- When a transcript Event card is revised with a relation envelope to another live Event and no message, the card shows that Event as its proposal, its status is `proposed` and its history has one new entry.
- When a transcript card is revised with only a message, its history gets that message and its proposal is unchanged; the same request on an `inbox` card is `400 validation_failed`.
- When `ifVersion` does not equal the card's current `updatedAt`, the response is `409 version_conflict` with the current card and nothing changed.
- A confirmed or rejected card cannot be revised (`400 validation_failed`), and a speaker-mapping card cannot be revised into an Event proposal.
- A foreign tenant's card id answers exactly like an unknown id, and the tenant isolation route test includes the new route.

### Requirement gh-1873: [trash 03/06] List archived databases as trash

#### Context

Model tier rationale: A small read route with a simple query that repeats the route-registration pattern of the listing it follows, in the same files; no write path and no new contract beyond the response shape.

The "Recently deleted" screen has a second tab for databases. A deleted database is an archived database (`DELETE /api/databases/:id` sets `databases.archived_at`; `POST /api/databases/:id/restore` clears it; a system database cannot be archived; `GET /api/databases` leaves archived ones out). Nothing lists them. This issue adds `GET /api/trash/databases`, a read-only custom route of the schemaCore module next to `GET /api/trash/items` (#1851), which also documents the route-registration points; the bulk restore (#1904) acts on the databases listed here, and the account summary (#1903) counts them. Both routes are also ordered after #1837 because they edit the same manifest and route matrix.

Decisions:

- Today an archived database has no deadline, so this listing returns `purgeAt: null` and `daysLeft: null` for every row. #1875 introduces the 30-day purge of archived databases and makes this listing report the real deadline.
- The list is not paged: archived user databases are few. It returns at most 500 rows, newest archived first, and `totalCount` is the real number.

Shared-file ordering: this issue also waits for #1870 because both edit the same registry, manifest, cutover, route matrix or hook files listed in Touches.

#### Task

Load `io-hardening`, `error-handling` and `testing`.

1. Add `createTrashDatabasesRouteHandler(pool)` to `backend/packages/data/src/trash/trashRouteHandlers.ts` for `GET /api/trash/databases`: the tenant's archived databases with `system = false`, as `{ databases: [{ id, key, name, liveItemCount, archivedAt, purgeAt, daysLeft }], totalCount }`, ordered by `archived_at DESC, id`. `name` is the stored name; `key` is null for a user database; `liveItemCount` is `countItems` for the database (items with `deleted_at IS NULL`); `purgeAt` and `daysLeft` are `null` (see decisions).
2. Register it in `schemaCoreModuleManifest.ts` (name `listTrashDatabases`, `GET /api/trash/databases`, justification `single-consumer-read`) with the handler re-exported in the export block, add `"list trash databases"` to `routeMatrix.ts` and the cases to `tenantIsolationRoutes.test.ts` and `chokePointWriteBoundary.unit.test.ts`.
3. Tests in `backend/packages/data/src/trash/__tests__/trashRouteHandlers.test.ts`: an archived user database with 3 live and 1 deleted item reports `liveItemCount` 3; a system database never appears; a live database does not appear; ordering by archive time; restoring the database removes it from the list; another tenant's databases are invisible.

#### Touches

- backend/packages/data/src/trash/trashRouteHandlers.ts (second handler)
- backend/packages/data/src/trash/__tests__/trashRouteHandlers.test.ts
- backend/packages/data/src/chokePoint/schemaCoreModuleManifest.ts (`customRoutes` entry, handler re-export)
- backend/services/semprec-api/src/routeMatrix.ts (one entry)
- backend/services/semprec-api/src/__tests__/tenantIsolationRoutes.test.ts (one case)
- backend/services/semprec-api/src/__tests__/chokePointWriteBoundary.unit.test.ts (route to handler file mapping)

#### Scope

##### In scope

- The read-only listing of archived user databases with their live item count.

##### Out of scope

- The 30-day purge of archived databases and the real `purgeAt` and `daysLeft`: #1875.
- Restoring databases, singly or in bulk: the existing restore route and #1904.
- Trashed items: #1851.

#### Acceptance criteria

- When a user database is archived, it appears with its stored name, its number of live items and its archive time; a system database never does.
- When the database is restored, it disappears from the list.
- The response carries `purgeAt` and `daysLeft` as `null`.
- Another tenant's archived databases are never visible.

### Requirement gh-1876: [subpages 12/12] Handle restyling a page block into another type

#### Context

Model tier rationale: A destructive operation that trashes a page subtree and rewrites a block in the parent in one transaction, guarded by a client-confirmed impact count, so a stale confirmation or a partial failure loses or hides user content.

In the editor a `page` block can be restyled into another type (text, heading, list and so on). The shared block model refuses that conversion because it needs database work: `setType` fails with `page_conversion_required` for any case that involves a `page` block (#1610). Left alone, a client that rewrote the block directly would leave the subpage orphaned without anyone being told. Deleting a record must always state the impact on what it contains, and deleted items stay restorable for 30 days; the impact preview is #1856, and trashing a page with its subpages and block is #1723.

Decision (decided by the product owner): the server offers an explicit operation `page.convertToBlock` that trashes the subpage tree and puts a normal block in its place, and it refuses to run unless the caller passes the number of pages the user was shown (409 on mismatch). The trashed pages stay restorable for 30 days.

Further decisions:
- The new block takes the page's title as its text (no inline attributes) and keeps the block's indent; its type must not be `page`.
- The call trashes through the normal item delete, so its hooks run and the restore of the page later brings back its block (the converted block stays; the user removes it).
- Agents need approval for it (destructive); the classification is set in #1844.

Shared-file ordering: this issue also waits for #1873 because both edit the same registry, manifest, cutover, route matrix or hook files listed in Touches.

#### Task

Load `state-writes`, `error-handling` and `testing`.

1. Add `page.convertToBlock` to the generic catalog: strict input `{ parentItemId, blockId, type, confirmedPageCount }` (`type` one of the block types except `page`), output `{ blockId, trashedPageCount }`, port method, binding and metadata as a destructive write on the item-write capability; plus the application service method and the route and method the ADR of #1394 records, with `routeMatrix.ts` and tenant-isolation entries.
2. Implement it in `backend/packages/data/src/docs/pageOperations.ts`, in one transaction: load the parent document, require a `page` block `blockId` (else `ValidationError` on `blockId`); count the live pages in the subtree with `collectSubpageTree` (#1723) plus the page itself; if the count differs from `confirmedPageCount`, answer 409 with the current count in `details` and change nothing; otherwise trash the page with the choke point's item delete (its hooks remove the block and nested pages), then insert a new block of the requested type at the recorded position with the page's title as plain text and the original indent.
3. Tests: with a matching count the page and its nested page are trashed and a text block with the title stands where the page block was; a stale count answers 409 with the actual count and nothing changes; a non-page block, a `page` target type and a block of another document are rejected; a failure while writing the document rolls back the trash; restoring the page later returns the page and its block while the converted block remains; an agent call creates an approval request instead of running.

#### Touches

- backend/packages/data/src/docs/pageOperations.ts (convertPageToBlock)
- backend/packages/shared/src/genericOperations/operationNames.ts (hotspot)
- backend/packages/shared/src/genericOperations/schemas.ts (hotspot)
- backend/packages/shared/src/genericOperations/port.ts (hotspot)
- backend/packages/shared/src/genericOperations/bindings.ts (hotspot)
- backend/packages/shared/src/genericOperations/capabilities.ts (hotspot)
- backend/packages/application/src/genericApplicationService.ts (convertPageToBlock; hotspot)
- backend/packages/application/src/genericOperationGateway.ts (only if its exhaustive mapping needs the name; hotspot)
- backend/services/semprec-api/src/itemsHandler.ts (new route)
- backend/services/semprec-api/src/routeMatrix.ts (route entry; hotspot)
- backend/services/semprec-api/src/__tests__/tenantIsolationRoutes.test.ts (route case; hotspot)
- backend/packages/data/src/__tests__/ (conversion tests)

#### Scope

##### In scope

- The confirmed conversion of a `page` block into another block type with the subpage tree trashed.

##### Out of scope

- The refusal of page conversions inside the pure block operations: #1610.
- The impact preview endpoint: #1856.
- Trashing and restoring pages: #1723.
- Agent approval classification: #1844.
- Converting other block types into pages: #2013.

#### Acceptance criteria

- When the call passes the number of pages shown to the user, then the page and its nested pages are trashed and a block of the requested type with the page's title stands in the page block's place.
- When `confirmedPageCount` differs from the current count, then the response is 409 with the current count and nothing changes.
- When the target type is `page` or the block is not a `page` block, then the response is 400.
- When the document write fails, then no page is trashed.
- When an agent calls it, then an approval request is created and nothing changes until approval.

## Touches

- backend/packages/shared/src/genericOperations/schemas.ts (`search` output: `journal` field)
- backend/packages/shared/src/genericOperations/port.ts (output type, if the output type is declared there)
- backend/packages/data/src/search/searchItemsQuery.ts (journal group result mapping)
- backend/services/semprec-api/src/__tests__/tenantIsolationRoutes.test.ts (only if the search route entry needs the new field)
- backend/packages/data/src/search/searchSnippet.ts (new)
- backend/packages/data/src/search/searchItemsQuery.ts (excerpt selection and `snippet` mapping)
- backend/packages/data/src/search/__tests__/searchSnippet.test.ts (new)
- backend/packages/data/src/mail/mailThreadActions.ts (new)
- backend/packages/data/src/mail/mailThreadRoutes.ts (read handler)
- backend/packages/data/src/mail/mailModuleManifest.ts (customRoutes entry and handler export)
- backend/packages/data/src/index.ts (export line)
- backend/services/semprec-api/src/routeMatrix.ts
- backend/services/semprec-api/src/__tests__/tenantIsolationRoutes.test.ts
- backend/packages/data/src/__tests__/mailThreadRead.test.ts (new)
- backend/packages/data/src/mail/mailDraftRouteHandlers.ts (new)
- backend/packages/data/src/mail/draft.ts (update and discard operations)
- backend/packages/data/src/mail/mailModuleManifest.ts (`customRoutes`)
- backend/packages/data/src/index.ts (barrel export)
- backend/services/semprec-api/src/adapter/errorContract.ts (`mail_draft_already_sent`, `mail_draft_not_editable`)
- backend/packages/data/src/__tests__/mailDraftRoutes.test.ts (new)
- backend/packages/data/src/mail/mailModuleManifest.ts (linkRules)
- backend/packages/data/src/mail/threadLinkRules.ts (new; resolver, freemail list)
- backend/packages/data/src/mail/mailMessageMetaStore.ts (`reassignThread` precedence)
- backend/packages/data/src/mail/ingest.ts (trigger after the first inbound message)
- backend/packages/data/src/db/migrations/NNNN_value_link_sender_domain.sql (next free ordinal at commit time)
- backend/packages/data/src/mail/__tests__/ (new resolver, relink and merge tests)
- backend/packages/data/src/mail/threadProjectTriage.ts (new)
- backend/packages/data/src/mail/mailModuleManifest.ts (`taskNames`)
- backend/packages/data/src/mail/ingest.ts (enqueue after the first inbound message)
- backend/packages/data/src/mail/__tests__/ (new tests with a stubbed gateway)
- backend/packages/data/src/mail/mailModuleManifest.ts (related declaration for People and the omission)
- backend/packages/data/src/mail/threadRelatedCount.ts (new; the count query)
- backend/packages/data/src/mail/__tests__/ (new tests)
- backend/packages/data/src/inbox/proposalActions.ts (`ReviseProposalInput`, `reviseProposalWithClient`)
- backend/packages/data/src/inbox/inboxRouteHandlers.ts
- backend/packages/data/src/inbox/inboxModuleManifest.ts (`customRoutes` entry, export line)
- backend/services/semprec-api/src/routeMatrix.ts (one entry)
- backend/services/semprec-api/src/__tests__/tenantIsolationRoutes.test.ts (one case)
- backend/services/semprec-api/src/__tests__/chokePointWriteBoundary.unit.test.ts (route to handler file mapping)
- backend/packages/data/src/inbox/__tests__/inboxRouteHandlers.test.ts
- backend/packages/data/src/__tests__/proposalActions.test.ts
- backend/packages/data/src/trash/trashRouteHandlers.ts (second handler)
- backend/packages/data/src/trash/__tests__/trashRouteHandlers.test.ts
- backend/packages/data/src/chokePoint/schemaCoreModuleManifest.ts (`customRoutes` entry, handler re-export)
- backend/packages/data/src/docs/pageOperations.ts (convertPageToBlock)
- backend/packages/shared/src/genericOperations/operationNames.ts (hotspot)
- backend/packages/shared/src/genericOperations/schemas.ts (hotspot)
- backend/packages/shared/src/genericOperations/port.ts (hotspot)
- backend/packages/shared/src/genericOperations/bindings.ts (hotspot)
- backend/packages/shared/src/genericOperations/capabilities.ts (hotspot)
- backend/packages/application/src/genericApplicationService.ts (convertPageToBlock; hotspot)
- backend/packages/application/src/genericOperationGateway.ts (only if its exhaustive mapping needs the name; hotspot)
- backend/services/semprec-api/src/itemsHandler.ts (new route)
- backend/services/semprec-api/src/routeMatrix.ts (route entry; hotspot)
- backend/services/semprec-api/src/__tests__/tenantIsolationRoutes.test.ts (route case; hotspot)
- backend/packages/data/src/__tests__/ (conversion tests)

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
