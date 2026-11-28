# Data model and writes

How persisted item and database state is shaped and written. Transaction mechanics, side effects and
lock orders are in [transactions-and-side-effects.md](transactions-and-side-effects.md); tenancy and
RLS in [tenancy-and-security.md](tenancy-and-security.md). Paths are relative to the repository root;
`data/` means `backend/packages/data/src/`.

## The choke point

### One write path

- Every mutation of item/database state (databases, properties, items, relations, views, value links,
  page documents) goes through the generic choke point: the generic operation catalog
  (`backend/packages/shared/src/genericOperations/`) dispatched through `GenericApplicationPort`, or
  the `*WithClient` data-layer functions behind it (`createItemWithClient`, `updateItemWithClient`,
  `createRelationWithClient`, `itemDeleteWithClient`, ...).
- No service, worker, script, route handler or client issues a direct `INSERT`/`UPDATE`/`DELETE`
  against these tables. A write that bypasses the choke point skips idempotency, `ifVersion` checks,
  ownership enforcement, domain hooks, heartbeat triggers, realtime invalidation and history.
- Only `packages/data` may write `items`, `databases` and `properties`
  (dependency-cruiser `no-core-table-write-outside-choke-point`); the item store `itemsStore.ts` is
  private to the package (`items-store-private`).
- A caller that already holds a transaction calls the `*WithClient` function with its client; the
  `ChokePoint` facade methods open their own `withTransaction`.

### Composed from domain modules

- `createChokePoint()` (`data/chokePoint/chokePoint.ts`) only composes: it builds one `ChokePointDeps`
  (`chokePointDeps.ts`) and returns `mergeOps(...)` over per-domain section factories
  (`databaseOps`, `propertyOps`, `relationPropertyOps`, `relationOps`, `itemWrites`, `itemReads`,
  `itemTrash`, `viewOps`, `viewQueryOps`, `itemCreateWithRelations`, ...).
- `mergeOps` (`mergeOps.ts`) throws on a method name defined by two sections; no silent shadowing.
- Each factory takes `Pick<ChokePointDeps, ...>` with exactly the dependencies it uses.
- `ChokePoint` is `ReturnType<typeof createChokePoint>`; there is no hand-written interface.
- There is no barrel inside `chokePoint/`: a caller imports a symbol from the module that owns it.
  A helper two domains need lives in a shared, domain-neutral module (`authorization.ts`,
  `databaseGuards.ts`, `relationEdgeContext.ts`, `destructiveProjection.ts`, `hooks.ts`).
- A compound command that spans two write owners (item plus initial edges, a select option plus
  the item values holding it) lives in its own coordinator module (`itemCreateWithRelations.ts`,
  `propertyOptionRemoval.ts`) that calls both owners on one client; the owners never import each
  other.

### Boundary rules (enforced)

| Rule (`backend/dependency-cruiser.rules.json`) | Meaning                                                                                                                                                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `no-choke-point-domain-cross-import`           | A choke-point domain module never imports another one.                                                                                                                                                                         |
| `chokepoint-knows-no-domain`                   | `chokePoint/` never imports a listed domain folder (mail, tasks, inbox, ...); it reaches domains only through the registries in `hooks.ts`. Exceptions: `schemaCoreModuleManifest.ts` and the purge imports of `itemTrash.ts`. |
| `item-trash-domain-imports-are-purge-only`     | `itemTrash.ts` imports listed domains only for `deleteItemDependents`; new purge work registers a purge hook instead.                                                                                                          |
| `no-choke-point-rollup-cycle`                  | No import cycles across `chokePoint/` and `rollup/`.                                                                                                                                                                           |

- Production source files are capped at 900 lines (`max-lines` in `backend/eslint.config.mjs`).
- A domain that needs to call back into a choke-point writer receives the writer as a parameter
  rather than importing it, when importing would close a cycle.

## One owner, one writer

- Every field of persisted state has exactly one owning process. A second writer is a defect even
  when the value it writes is correct.
- A property's `owner` and `ownerProcess` (`properties` row, seeded by module seeds) name its owner:
  - `owner: 'user'` — written only by user- or agent-initiated choke-point calls;
  - `owner: 'system'` — written only by the process named in `ownerProcess` (or, when it is null,
    only by the owning module).
- `assertWritableProperties` (`data/chokePoint/itemWrites.ts`) refuses with 403 `owner_violation`:
  a system key without an explicit `allowedSystemKeys` grant, and a system key whose `ownerProcess`
  differs from the caller's `systemOwnerProcess`. It refuses rollup keys (403 `computed_readonly`)
  and relation keys (written only through relation operations).
- `assertCallerMayWriteDatabase` refuses a user/agent write into a system database that has no
  user-owned property, even an empty one.
- A feature that seems to need a second writer gets an explicit, declared handoff, never a quiet
  extra write. Current handoffs:
  - `allowedSystemKeys` — a trusted in-process owner writes the system keys it computed itself
    (Journal lazy creation, library metadata, Tasks routes).
  - `systemOwnerProcess: "valueLinks"` — the link engine writes a user-owned property only while an
    `on` value link exists for that item and key (see _Value links_).
  - Provider-backed user state (mail flags) converges through desired/current state owned by the
    sync process (see transactions doc, _Provider write-backs_).
- Tables outside the item model have one writing store too: e.g. every write to `approval_requests`
  goes through `data/mcp/approvalRequestsStore.ts`; other packages call its exported functions,
  never raw SQL.

## Typed rows at the Postgres boundary

- Every `client.query(...)` whose rows are read carries a row type: `client.query<SomeDbRow>(...)`.
  Each module declares the shape once as a named `…DbRow` type used by both the query and the mapper.
  The row type describes what the SQL selects, not the table.
- A single-row read goes through `requireSingleRow(rows, "<what>")` (`data/db/pool.ts`), never
  `rows[0]` passed on unchecked (`noUncheckedIndexedAccess` is on).
- A `DELETE`/`UPDATE` that must hit a row checks it with `requireAffectedRows(result, "<what>")`;
  a zero or null `rowCount` is not success.
- `@typescript-eslint/no-unsafe-*` is on for production code and off only for tests and fixtures.

## Canonical keys and reserved names

- Stored keys (`databases.key`, property keys, select-option keys, settings keys) are English
  camelCase; view-type keys are English kebab-case. The one exception is `ico`.
- Display labels are never stored as a key or hardcoded; they live in the `cs.json`/`en.json`
  catalogs keyed by the canonical key. Label fallback: stored `label`/`name` override →
  `users.locale` catalog → `en` → raw key.
- Option keys added at runtime are user content: the server derives them from the label (NFKD,
  marks stripped, camelCase, `option` when empty, lowest free numeric suffix on collision); the
  caller never chooses one.
- In a proposal card's `userOverrides`, `relations` (relation key → full target list) and `enabled`
  (step switch) are reserved keys; `PATCH /api/proposals/:id/values` refuses them as `set` keys.

## Item writes

### Create (`createItemWithClient`)

Order inside the caller's transaction:

1. Writer access to the database; idempotency-key replay check.
2. Caller-key checks: `assertWritableProperties`, `assertCallerMayWriteDatabase`, color and markdown
   validation.
3. `itemsStore.insertItemWithReplay` reserves the idempotency key, then calls
   `resolveCreateProperties`: pre-write transforms, `config.default` expansion, final value
   validation. On a replay the callback never runs.
4. On a real insert only: create hooks, `onItemEvent` heartbeat triggers, after-commit invalidation.
   A replay returns the stored item and runs nothing else.

### Update (`updateItemWithClient`)

1. Writer access, archived-database guard, caller-key ownership, color, markdown and title checks.
2. The owning module's **update pre-lock hooks** (they take locks that must precede the row lock).
3. Row lock (`itemsStore.lockItemById`) when a transform, an update command, a value-link handoff or a
   select check needs the stored row; `ifVersion` mismatch is a `ConflictError`.
4. Pre-write transforms and update commands on the locked row.
5. Value-link handoff check for `valueLinks` writes (sorted union of caller keys and user-owned keys
   in the final patch).
6. `updateItemProperties`; approval check and link break for changed linked values; update hooks;
   heartbeat triggers; rollup recompute enqueue for every written key; after-commit invalidation.

- The returned `previous` lists only the caller's keys.
- The optimistic-concurrency token is `items.version` (a `bigint`, sent as a decimal string
  `version` on every item read and write result). Every write that advances `updated_at`
  (`updateItemProperties`, the property-migration rewrites) increments it in the same statement;
  `computed` writes, trash and restore leave both unchanged. `ifVersion` is compared with the
  locked row's `version`, never with a timestamp: two writes in one transaction-start millisecond
  still get distinct versions.

### Pre-write transforms

- `registerItemPreWriteTransform(moduleId, transform)` (`data/chokePoint/hooks.ts`); a transform runs
  only for databases whose `ownerModuleId` is that id, in registration order, each receiving the
  previous output. It returns the properties to store or throws (`ValidationError` → 400).
- It receives `{ client, database, stored, patch, humanWriterUserId, writer }`; `stored` is the
  locked row on update and `null` on create.
- A key a transform adds must exist, must not be a rollup or relation, and if system-owned its
  `ownerProcess` must be null or the transform's module (403 `owner_violation`).
- Transforms run inside the transaction; they must not call slow external services.
- Tasks' derived `time` (`data/tasks/deriveTaskTime.ts`) is a transform; the generic write path names
  no module.

## Domain hooks and registries

All registries are per-process, filled at load by the single composition root
`data/domainWriteHooks.ts`, which `data/index.ts` imports before anything writes. A test that deep-imports a
choke-point module imports `domainWriteHooks.js` itself or registers its own hooks; `clearHooksForTests`
empties the write registries.

### Write-time registries (`data/chokePoint/hooks.ts`)

| Registry                                                                                                                                                                  | Runs                                                     | Notes                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------- |
| `registerItemPreWriteTransform`                                                                                                                                           | before insert / on locked row                            | per module, returns patch           |
| `registerItemUpdatePreLockHook`                                                                                                                                           | update, before the first row lock                        | per module; may only take locks     |
| `registerItemDelete/Restore/PurgePreLockHook`                                                                                                                             | trash/restore/purge, before the root lock                | per module                          |
| `registerItemCreateHook`                                                                                                                                                  | after a real insert                                      | gets `initialRelations` (see below) |
| `registerItemUpdateHook`                                                                                                                                                  | after the row update                                     |                                     |
| `registerItemDeleteHook` / `registerItemRestoreHook`                                                                                                                      | per trashed/restored row of the cascade                  | restore gets `deletedAtExact`       |
| `registerItemPurgeHook`                                                                                                                                                   | per row actually removed by the purge                    | gets the locked removed row         |
| `registerRelationEdgeWrite/Delete/ChangedHook`                                                                                                                            | relation edge writes                                     |                                     |
| `registerRelationEdgeBeforeLinkBreakHook`                                                                                                                                 | user/agent edge write, before link break                 | lock only                           |
| `registerItemUpdateCommand`, `registerItemCascadeExpansion`, `registerItemDeleteApprovalGuard`, `registerItemPatchApprovalContribution`, `registerItemDeleteImpactReader` | module-specific extensions of update, trash and approval | per module                          |

- `Set` semantics: registering the same function twice is a no-op; hooks run sequentially in
  registration order inside the caller's transaction; the first rejection rolls the write back.
- `domainWriteHooks.ts` holds one explicit, ordered list per write event (`itemCreateHooks`,
  `itemUpdateHooks`, `itemDeleteHooks`, ..., `itemPreWriteTransforms` and the pre-lock lists keyed by
  module), so the complete set of rules a write runs, and their order, reads from one list. Order
  matters only within a list.
- A domain exports its hook next to its own logic and adds it to the list of its event in
  `domainWriteHooks.ts`; it never edits `itemWrites.ts`, `relationOps.ts` or `itemTrash.ts`.

### Read-time registries

| Registry                                                | Owner module                        | Rule                                                                                                                  |
| ------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `registerAutomationBatchReader`                         | `chokePoint/hooks.ts`               | exactly one reader; a different second one throws; unregistered use fails                                             |
| `registerItemReadProjection`                            | `chokePoint/hooks.ts`               | synchronous per-item read projection                                                                                  |
| `registerRelatedRowContributor(databaseKey, fn)`        | `chokePoint/relatedContributors.ts` | contributed row replaces the generic row of its database, then passes the same grant/archive/order filters; read-only |
| `registerItemSearchGroup` / `registerThreadSearchGroup` | `search/searchGroupRegistry.ts`     | one definition per group type; same object twice is a no-op, a different one throws; the group decides its actor rule |

- A read contributor uses the read transaction's client for its own domain's reads only; it must not
  write.

## Items, properties and relations

### Storage

- `items` is one ordinary table: primary key `id`, `UNIQUE (tenant_id, id)` as the target of every
  item foreign key (and the access path of id lookups under RLS), `(database_id, id)` for reads and
  keyset sweeps by database, and `(tenant_id, deleted_at DESC, id)` over trashed rows for trash reads
  and the purge sweep.
  Creating a database runs no DDL; deleting one (`deleteDatabaseWithItems`) deletes its remaining items
  and then the row, in the caller's transaction.
- Every foreign key to an item is `(tenant_id, <column>) REFERENCES items (tenant_id, id)`: FK checks
  ignore RLS, so another tenant's item id fails exactly like a random one, and the deploy-time verifier
  refuses any other shape (`itemForeignKey`). An FK violation (23503) reaches an HTTP caller as 409
  `foreign_key_violation` with no constraint name; a write that names an item still checks it first
  when the caller needs a specific error or a tenant-scoped not-found (missing, trashed and foreign ids
  alike), because the key accepts a trashed item and says nothing about its database.
- Every referencing column is indexed, alone or after `tenant_id`.
- Every item key is `DEFERRABLE INITIALLY DEFERRED`, checked at commit; `CASCADE` and `SET NULL` still act at
  the delete statement. The check at commit lets the idempotency reservation precede its item, lets the
  permanent purge (`purgeExpiredTrashSubtree`, archived-database `deleteItemChunk`) delete an item before the
  dependents its owners remove, and keeps a dependent insert from taking the item's `FOR KEY SHARE` lock ahead
  of the writer's own row lock, so concurrent item writers queue on the item row as they did without keys.
  A delete that leaves a `NO ACTION` dependent behind fails the commit.

| Column                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | On item delete      | Why                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `item_relations.item_a`, `.item_b`; `view_items.item_id`; `item_search_index.item_id`; `docs.item_id` (doc children cascade from `docs`); `value_links.item_id` (sources cascade from the link); `task_recurrence.item_id`; `project_kept_dates.item_id`; `item_automation.item_id`; `item_origins.item_id`; `library_cover_candidates.item_id`; `calendar_feed_state.calendar_item_id`; `calendar_account_sync_state.account_item_id`; `calendar_event_push_state.event_item_id`; `calendar_remote_state.calendar_item_id`; `calendar_push_channels.account_item_id`, `.calendar_item_id`; `event_remote_state.event_item_id`, `.calendar_item_id`; `agent_database_grants.project_item_id`; `project_mail_signals.project_item_id`; `recording_requests.file_item_id`; `transcript_action_item_states.transcript_item_id` | `CASCADE`           | Rows derived from or keyed by the item whose removal is a plain delete with no side effect.                                                                                                                                                                                                                           |
| `mail_account_server_settings.mailbox_item_id`; `mail_account_sync_state.item_id`; `mail_attachments.message_item_id` (blobs and Files items stay); `mail_message_flag_sync_state.message_item_id`; `mail_message_content_cache.item_id`; `external_credentials.item_id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `CASCADE`           | Plain deletes with no side effect; mailbox removal deletes the settings, sync state and credential itself when the mailbox is trashed. An MCP server's credential goes with its item too.                                                                                                                             |
| `mail_folder_sync_state.item_id`; `mail_drafts.email_item_id`; `mail_oauth_states.mailbox_item_id`; `mail_sent_copies.mailbox_item_id`; `mcp_server_connection_state.mcp_server_item_id`; `person_email_index.item_id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `CASCADE`           | State of the item that no reader needs once it is gone; a purged person's addresses become claimable by another person.                                                                                                                                                                                               |
| `idempotency_keys.item_id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `CASCADE`           | Reserved before its item is inserted in the same transaction (`insertItemWithReplay`); a replay that finds no key creates the item again.                                                                                                                                                                             |
| `value_link_sources.source_item_id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `NO ACTION`         | Removing the sources ends links left without one and invalidates their items (`deleteItemDependents`).                                                                                                                                                                                                                |
| `inbox_attachments.inbox_item_id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `NO ACTION`         | Removing an attachment releases its blobs when unreferenced (`deleteItemDependents`); a cascade would leak them.                                                                                                                                                                                                      |
| `mail_message_meta.item_id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `NO ACTION`         | Removing the meta row may trash the thread's Threads item and delete the thread (`mailItemPurgeHook`).                                                                                                                                                                                                                |
| `item_origins.inbox_item_id`, `.source_transcript_id`; `mail_drafts.source_email_item_id`; `recording_requests.event_item_id`, `.project_item_id`; `transcript_action_item_states.task_item_id`, `.owner_person_id`; `task_recurrence.trashed_active_item_id`; `semp_problems.project_item_id`; `semp_threads.subject_proposal_id`; `views.creator_project_item_id`                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `SET NULL (column)` | Optional references whose row outlives the item; every reader already treats the item as possibly gone, and null reads the same as a missing item.                                                                                                                                                                    |
| `item_origins.proposal_id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | no key              | Provenance read after its Processing proposals card is purged (siblings grouped by card); `NOT NULL`.                                                                                                                                                                                                                 |
| `databases.parent_item_id`, `.owner_project_item_id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | no key              | `items.database_id` references `databases`, so a key would close a cycle the tenant purge cannot order; an inline database whose owner is purged while it still holds items outlives the owner.                                                                                                                       |
| `mail_message_meta.mailbox_item_id`; `mail_drafts.mailbox_item_id`; `mail_message_move_sync_state.mailbox_item_id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | no key              | A mailbox and its emails are separate purge roots in no fixed order; the email's rows must outlive a purged mailbox.                                                                                                                                                                                                  |
| `mail_message_move_sync_state.message_item_id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | no key              | The provider-move ledger, which no path deletes; a cascade would drop an operation the drain may still own, `NO ACTION` would block every moved message's purge.                                                                                                                                                      |
| `mail_threads.item_id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | no key              | The thread row belongs to its messages and is deleted with the last of them; it can outlive its Threads item, and a key would block that purge or cascade into the messages.                                                                                                                                          |
| `credential_access_log.item_id`; `ai_gateway_calls.project_item_id`; `agent_runs.project_item_id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | no key              | History that must keep the id after the item goes. Writers may name a purged project (a heartbeat of a purged project still runs), and a gateway call must never fail to record its cost.                                                                                                                             |
| `agent_run_read_allowances.item_id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | no key              | Per-turn rows built from stored message references, which may name items purged since.                                                                                                                                                                                                                                |
| `project_heartbeats.project_item_id`; `project_agent_guidance`, `project_agent_guidance_versions`, `agent_guidance_drift_findings` (`.project_item_id`); `mcp_tool_registrations.mcp_server_item_id`; `project_mcp_grants.project_item_id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | no key              | Agent state with no purge path: it outlives its project or MCP server. A cascade would skip the domain delete (guidance) or run into run history that `NO ACTION`/`RESTRICT` keys protect (heartbeats, registrations); `NO ACTION` would block the project's purge; the grants route accepts an unchecked project id. |
| `semp_threads.subject_inbox_item_id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | no key              | A thread stays listed after its subject is gone (`subject_exists`); `NOT NULL` for an item thread and its messages are protected by `ai_gateway_calls`.                                                                                                                                                               |
| `semp_problems.source_id`, `notifications.source_id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | no key              | Polymorphic, keyed by `source_table`.                                                                                                                                                                                                                                                                                 |

### Properties

- A seed schema-locks system databases (`databases.schema_locked`). `assertDatabaseSchemaUnlocked`
  (`data/chokePoint/propertiesStore.ts`) refuses create, retype, config change and delete with
  403 `schema_locked`; display names stay writable.
- The only exception: `property.option.add`, `property.option.update` and `property.option.remove`
  change `config.options` of a select/multi-select on a locked database. Add and update never
  remove, reorder or rekey an option.
  Labels are 1–60 UTF-16 units without NUL or lone surrogates; a label equal (case/diacritic-
  insensitive, against stored labels and both catalogs) to another option's is 409
  `option_label_exists`; at most 100 options. All three run under `SELECT ... FOR UPDATE` on the
  property row, as does `property.patch`.
- `property.option.remove` (REST only, `DELETE /api/properties/:id/options/:key`, 204) refuses a
  system-owned property (400 `system_owned`). In its transaction it drops the option and a
  `config.default` naming it, then clears the key from every item value holding it, live and
  trashed: a select becomes `null`, a multi_select loses the key. Live items are written through
  `updateItemWithClient` as the system writer (hooks, item invalidation, search reindex); trashed
  items get the value set directly (`setTrashedItemProperty`). A user or agent item create or update
  holds every select/multi-select property its own keys name `FOR SHARE` from before the option
  check (`assertSelectValuesKnown`) to commit, so a removal and such a write serialize on the
  property row and no user or agent write stores the removed key after the removal commits.
  System writers skip the option check and take no such lock.
- Property read order is `initial_position ASC NULLS LAST, key`. `createDatabaseWithProperties`
  stores positions (title 0, then input order); every later property has a null position.

### Relations

- Relation values are edges, never item properties. Cardinality is enforced by a trigger under a
  per-definition transaction advisory lock
  (`pg_advisory_xact_lock(hashtextextended(relation_definition_id::text, 0))`).
- `createItemWithRelationsWithClient` (`itemCreateWithRelations.ts`) inserts the item, runs create
  hooks, then validates and writes each edge in input order, all on one client. A replay writes no
  edge.
- Create hooks receive `initialRelations` (property id + target ids) as an announcement, not a fact:
  nothing is checked or written yet. A hook may leave a write to the create (the default-calendar
  hook writes no calendar edge when the create names one).
- Realtime relation invalidations collapse to one final event per item/property key per transaction
  (`runAfterCommitKeyed`).

### Values derived from a project

- An Event's company is read through its project (`data/derived/`); an Event without a live project
  shows its own `company` edges only.
- While an Event has a live project, the choke point refuses a new own `company` edge
  (`assertNotDerivedValueWrite`, `GUARDED_DERIVED_VALUE_SOURCES`). An Event's own `company` edge is
  not removed when it gets a project.
- A change of a project's `company` edge queues `derivedValuesInvalidate`, which announces the
  project's live Events after commit (`derived/projectDerivedValueInvalidation.ts`).
- An Inbox card offers no field for a value derived from the project.

### Value links

- A value link (`value_links`, `data/chokePoint/valueLinksStore.ts`) lets the `valueLinks` process
  write a user-owned property it inherits. Every required key needs its own `on` link, even for a
  null or unchanged value; transform output is no extra authority.
- A user/agent write that changes a linked value breaks that link; system writes leave links on.
- Lock protocol for these writes is in the transactions doc.

### Reads

- `getItemPath` (`data/chokePoint/itemReads.ts`) walks ancestors iteratively, per level: a missing
  ancestor ends the walk (no error), a repeated database id ends it (cycle guard), and the chain
  length is capped. Follow this shape for any new hierarchy walk.
- `item_origins.capture_time_basis` says how `captured_at` is known: `inboxCapture` (verified),
  `unknown` (null), `legacyUnverified` (estimate). Readers check the basis before treating the value
  as a capture instant.

## Views

- Views are direct writes of every actor, outside the proposal flow.
- A view whose `config` has `systemKey` is a system view: unique per database
  (`views_database_system_key_uq`), read-only for every actor (`assertViewWritable` → 403
  `owner_violation`, reason `system_owned`), and only the system may set the key
  (`assertSystemKeyWritable`, reason `system_key_reserved`). Seeds create system views with
  `createdBy: "system"`.
- A module manifest's database descriptor carries the collection hints a client renders with
  (`quickFilters`, `defaultSort`, `dateLabels`, `collectionFilter`, `pickerFilter`,
  `facetBarProperty`; `packages/module-registry/src/manifest.ts`). The registry validates their
  shape when the module loads; `GET /api/schema` publishes them per database. `facetBarProperty`
  names the property whose values a collection shows as a chip bar and is absent for a database
  that declares none; the schema handler publishes it only when it is a `select` or
  `multi_select` property of that database in the response, and any other declaration fails the
  request with 500 instead of being published or dropped.

## Pages and blocks

### Block model (`shared/block-model/`, package `@semprec/block-model`)

- A page is the Yjs document of an item (`docs.item_id`, at most one per item). Blocks are `Y.Map`s
  in `doc.getMap('blocks')`; order is the flat `Y.Array` `doc.getArray('order')`; hierarchy is only
  `indent` (0–5).
- Closed type set: `text`, `h1`–`h3`, `bullet`, `number`, `todo`, `quote`, `toggle`, `page`. Inline text
  is `Y.Text` with `bold`, `italic`, `code`, `link`, `strike`, `underline`, and `color`/`highlight`
  holding a key of the closed `INLINE_COLORS` registry (an unknown key is dropped on read). A
  `toggle` block's children are the following blocks with a greater indent; `h1`–`h3` carry an
  optional boolean `toggle` (a toggle heading). Collapsed state is client UI state, never stored.
- Server-side writes validate strictly (400). Sync (`WS /api/sync`) cannot reject partial updates, so
  readers normalize at read time with a pure function; reading never writes.
- Markdown is only a serialization; the canonical serializer/parser in `shared/block-model/` is the
  one format every consumer uses. No native block JSON API exists.
- The package depends only on `yjs`; the backend consumes it through its pnpm workspace.

### Subpages

- A subpage is an item of the tenant's hidden `pages` system database (owner module `pages`), created
  on first use under an advisory lock (`data/docs/pagesDatabase.ts`). Its address is
  `semprec://page/<itemId>`.
- Its system-owned `parentItemId` (text, not a relation) names the host or parent page. Only the
  creation owner (`createSubpage`) sets it; nothing reparents pages. A page is never its own ancestor.
- The `page` block's `text` in the parent document is the title's source of truth; the Pages item's
  `title` is a mirror written by `page.rename` and the debounced `pageTitleMirror` job, both under
  owner process `pages`. Trash, export, search and breadcrumbs read the mirror.
- Light editors (Markdown text properties) cannot hold `page` blocks. An orphan subpage (no block names
  it) is trashed by `data/docs/pageOrphanSweep.ts`.

### Page operations

- Pages are reached only through catalog operations (`page.*` in `operationNames.ts`, all on
  `core.item.read`/`core.item.write`); there is no page CRUD route. Deleting a page is `item.delete`.
- `page.get` never creates a document; `page.ensure` is idempotent.
- A page's version is `docEtag` (`data/docs/pageMarkdown.ts`): base64url SHA-256 of the encoded Yjs
  snapshot. `GET /api/items/:id/page.md` sends it as a strong `ETag`; `PUT` of the same URL requires
  `If-Match` (428 without, 409 when stale).
- `page.replace` (`replacePageMarkdown`) and `page.restoreVersion` are destructive and approval-gated.
  Replace applies an id-preserving diff (`planBlockDiff`), validates that every `page` block names a
  live subpage of the host, and trashes subpages it no longer links.
- `page.rename` writes the Pages item title (via `updateItemWithClient`, owner `pages`) and the first
  naming block in the parent document in one transaction.
- `page.duplicate` copies the whole subtree as new pages (cap `MAX_DUPLICATE_PAGES` = 500, planned
  before any write).
- `page.changes` fetches history in groups of at most 4 MiB; an update larger than that is refused
  (`history_window_too_large`) only when actually needed.
- `POST /api/items/:id/page/insert` alone also accepts a run credential, resolved by
  `resolveRunCredentialCaller` exactly as `/mcp` does.

## Trash, restore and purge

### Items (`data/chokePoint/itemTrash.ts`)

- Trash is a soft delete (`deleted_at`) of the item and its cascade (inline databases owned by it,
  plus module cascade expansions); restore brings back the rows of the same deletion epoch.
  `deletedAtExact` lets a trash join an earlier epoch.
- The choke point never updates a trashed row.
- The permanent purge (`purgeExpiredTrashSubtree`, nightly `handleItemTrashPurgeSweepTask`) removes
  rows trashed longer than `RETENTION_DAYS` (`data/trashRetention.ts`). It locks each row with
  `lockTrashedItemBefore` (still trashed and older than the cutoff, decided by the locking statement),
  hard-deletes it, calls `deleteItemDependents`, then runs purge hooks with the removed row. Blob
  bytes are removed after commit, best-effort, in both storage roots.
- A purge hook failure rolls back that call; the sweep logs it and continues. The tenant erase runs
  no purge hook.

### Pages and hosts (`data/docs/pageTrash.ts`)

- Trashing a page removes its `page` block from the parent document and records the position in the
  parent's `doc.getMap('trashedPages')`; restore puts it back there (or at the end), restoring
  subpages in reverse id order.
- Trashing any other row (a host) trashes its live subpages into the host's epoch
  (`hostItemDeleteHook`); restore brings back the subpages of that exact epoch.
- Nested trash/restore runs with the hook context's writer, agent run and acting user.

### Archived databases (`data/trash/purgeArchivedDatabases.ts`)

- Archiving sets `archived_at` and `purge_at = now() + RETENTION_DAYS × 24h`; restore clears both.
  Only user databases are archived or purged.
- After `purge_at` the daily task purges in repeatable steps: items in chunks of 500 (owned inline
  databases first, depth-first, each item with `deleteItemDependents` and purge hooks), then one final
  transaction that removes dependent schema in other databases (rollups over it, paired relation
  sides, one-directional relations targeting it) and deletes the database. Every
  deleting transaction first re-checks the database under `FOR NO KEY UPDATE`.
