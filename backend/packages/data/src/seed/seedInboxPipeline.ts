import type { PoolClient } from "pg";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as viewsStore from "../chokePoint/viewsStore.js";
import {
  createRelationPropertyWithClient,
  type CreateRelationPropertyInput,
  type SystemRelationWriteContext,
} from "../chokePoint/chokePoint.js";
import type { ComputedKeyRegistry } from "../chokePoint/computedKeyRegistry.js";
import type { ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import type { DatabaseRow, PropertyOwner, PropertyType } from "../types.js";
import { INBOX_ITEM_TYPES_MODULE_ID, INBOX_MODULE_ID, PROCESSING_PROPOSALS_MODULE_ID } from "./inboxPipelineKeys.js";
import { TEN_DATABASE_MODULE_IDS } from "./tenDatabaseKeys.js";
import { PROCESSING_METHODS } from "../inbox/inboxTypesStore.js";
import { createHeartbeat } from "../scheduler/schedulerStore.js";
import { SEMPREC_TICK_ACTION_ID } from "../inbox/inboxTickAction.js";
import { JOURNAL_INBOX_COMPUTED_KEY } from "../inbox/journalInboxCompute.js";
import { registerJournalInboxViewType } from "../views/journalInboxViewType.js";

function selectConfig(options: string[]): Record<string, unknown> {
  return { options };
}

interface PropSpec {
  key: string;
  name: string;
  type: PropertyType;
  owner?: PropertyOwner;
  config?: Record<string, unknown>;
}

async function createDb(
  client: PoolClient,
  name: string,
  ownerModuleId: string,
  ownerProjectItemId: string,
): Promise<DatabaseRow> {
  return databasesStore.createDatabase(client, { name, system: true, ownerModuleId, ownerProjectItemId });
}

async function createProps(client: PoolClient, databaseId: string, specs: PropSpec[]): Promise<void> {
  for (const spec of specs) {
    await propertiesStore.createProperty(client, {
      databaseId,
      key: spec.key,
      name: spec.name,
      type: spec.type,
      owner: spec.owner,
      config: spec.config,
    });
  }
}

export interface InboxPipelineDatabases {
  inbox: DatabaseRow;
  inboxItemTypes: DatabaseRow;
  processingProposals: DatabaseRow;
}

/**
 * Seeds Inbox / Inbox item types / Processing proposals (issue #101: the three databases
 * issue #24's ten hardcoded databases deliberately exclude — see the epic, #100) as one
 * group of system databases owned by the existing Semprec project, the same class as
 * Mailboxes/Folders/Emails (issue #26). Must run after `seedTenDatabasesInTransaction`
 * (needs Journal for `journalDay` and Transcripts for `sourceTranscript`) and after the
 * Semprec project item exists (see seedSystem.ts).
 *
 * The baseline schema, ownership, canonical keys, the Journal relation, (issue #102)
 * types' `processingMethod`/`targetDatabase`, and (issue #103) the Inbox
 * `onItemEvent`/`semprec.tick` dispatch heartbeats are in scope here — fingerprinting/
 * proposal computation (#223) and the confirm/reject/revise endpoints (#105) are later
 * issues in the series and are not implemented by this seed.
 */
export async function seedInboxPipelineInTransaction(
  client: PoolClient,
  journalDatabaseId: string,
  transcriptsDatabaseId: string,
  semprecProjectItemId: string,
  computedKeyRegistry: ComputedKeyRegistry,
  viewTypeRegistry: ViewTypeRegistry,
): Promise<InboxPipelineDatabases> {
  const relate = (
    input: CreateRelationPropertyInput,
    context?: SystemRelationWriteContext,
  ): Promise<{ property: unknown; inverseProperty: unknown }> =>
    createRelationPropertyWithClient(client, input, context, computedKeyRegistry);

  // Issue #106: declares the Journal day cache key ahead of any writes, and registers
  // "journal-inbox" into *this process's* registry the same way registerTemporalSwitcherViewType
  // etc. do in seedSystem.ts — needed on every startup, not only the one-time DB seed.
  computedKeyRegistry.add(JOURNAL_INBOX_COMPUTED_KEY);
  registerJournalInboxViewType(viewTypeRegistry);

  const inbox = await createDb(client, "Inbox", INBOX_MODULE_ID, semprecProjectItemId);
  const inboxItemTypes = await createDb(client, "Inbox item types", INBOX_ITEM_TYPES_MODULE_ID, semprecProjectItemId);
  const processingProposals = await createDb(
    client,
    "Processing proposals",
    PROCESSING_PROPOSALS_MODULE_ID,
    semprecProjectItemId,
  );

  // Both mandatory: the client always supplies date/time, and the server never derives
  // them as "today" — offline capture on a phone and delayed batch submission after a
  // connectivity outage both depend on the supplied values being preserved verbatim.
  // Enforcement of "mandatory" lives in inbox/inboxStore.ts's `createInboxItemWithClient`
  // (the schema engine has no generic required-field concept), not here.
  await createProps(client, inbox.id, [
    { key: "date", name: "Date", type: "date", owner: "user" },
    { key: "time", name: "Time", type: "time", owner: "user" },
    { key: "text", name: "Text", type: "text", owner: "user" },
  ]);

  await createProps(client, inboxItemTypes.id, [
    { key: "name", name: "Name", type: "title", owner: "user" },
    { key: "emoji", name: "Emoji", type: "text", owner: "user" },
    // Archiving (issue #102) removes a type from `GET /api/inbox-types` for new capture
    // while existing Inbox items keep pointing at it validly.
    { key: "status", name: "Status", type: "select", owner: "user", config: selectConfig(["active", "archived"]) },
    // Replaces the mock's hardcoded label-text comparison (issue #100). Cross-field
    // validation ("database" requires targetDatabase, "pageContent" rejects it) is
    // enforced in inbox/inboxTypesStore.ts, not here — same reason inboxStore.ts enforces
    // date/time itself: the schema engine has no generic cross-field validation concept.
    {
      key: "processingMethod",
      name: "Processing method",
      type: "select",
      owner: "user",
      config: selectConfig([...PROCESSING_METHODS]),
    },
    // Deliberately not a `relation` property: a relation's target database is fixed at
    // creation time (chokePoint.ts's `createRelationPropertyWithClient`), but this must be
    // able to point at any one of the ten hardcoded databases (issue #24) — the same reason
    // Processing proposals' `resultItemId` above is `text`, not `relation`. Stores the
    // target's canonical `owner_module_id` key (e.g. 'tasks', 'events'); which project/page
    // within it is a runtime, content-driven decision (issue #100), never stored here.
    {
      key: "targetDatabase",
      name: "Target database",
      type: "select",
      owner: "user",
      config: selectConfig([...TEN_DATABASE_MODULE_IDS]),
    },
  ]);

  await createProps(client, processingProposals.id, [
    { key: "kind", name: "Kind", type: "select", owner: "system", config: selectConfig(["inbox", "transcript"]) },
    { key: "fingerprint", name: "Fingerprint", type: "text", owner: "system" },
    // { entityKind, target, properties } — a single generic envelope regardless of
    // processingMethod, so a chat-driven revise can rewrite it wholesale (issue #105).
    { key: "proposal", name: "Proposal", type: "json", owner: "system" },
    // [{ author: 'ai'|'user', message, at }] — chat + decision log.
    { key: "history", name: "History", type: "json", owner: "system" },
    {
      key: "status",
      name: "Status",
      type: "select",
      owner: "system",
      config: selectConfig(["needsClarification", "proposed", "confirmed", "rejected", "invalid"]),
    },
    // Filled in by confirm; not a relation, since the target can be any system database's item.
    { key: "resultItemId", name: "Result item ID", type: "text", owner: "system" },
    { key: "resultLabel", name: "Result label", type: "text", owner: "system" },
  ]);

  // Inbox -> Inbox item types: nullable (an item without a type is valid — it later enters
  // `needsClarification`, issue #100), one-directional — no inverse is needed by this issue.
  // `many_to_many`, not `one_to_many` (issue #82): property_id_a/item_a (the Inbox item) is
  // single-valued for this field, so the enforced `one_to_many` contract would land its
  // "at most one edge" constraint on item_b (the type) instead — wrongly capping each type to
  // one Inbox item. With no inverse to swap this source/target pairing onto (Inbox item types'
  // schema has no reciprocal property here), `one_to_many` can never correctly enforce this
  // relation, same as Emails.attachments.
  await relate({
    sourceDatabaseId: inbox.id,
    key: "type",
    name: "Type",
    targetDatabaseId: inboxItemTypes.id,
    cardinality: "many_to_many",
    owner: "user",
  });

  // Inbox -> Journal ("journalDay"): system-owned, resolved at write time through the
  // existing lazy Journal-day mechanism (journal/journalStore.ts's `getOrCreateJournalItem`,
  // wired up in inbox/inboxStore.ts's `createInboxItemWithClient`) — no default database is
  // added for this, it reuses the Journal relation directly. One-directional: Journal's
  // schema is already locked by `seedTenDatabasesInTransaction`, the same reason
  // Emails->Files/People (issue #26) carry no inverse either. `many_to_many`, not
  // `one_to_many` (issue #82), for the same structural reason as Inbox.type above — many
  // Inbox items share one Journal day, and this one-directional relation has no inverse to
  // swap the source/target pairing onto.
  await relate(
    {
      sourceDatabaseId: inbox.id,
      key: "journalDay",
      name: "Journal day",
      targetDatabaseId: journalDatabaseId,
      cardinality: "many_to_many",
      owner: "system",
      ownerProcess: INBOX_MODULE_ID,
    },
    { ownerProcess: INBOX_MODULE_ID },
  );

  // Processing proposals -> Inbox / Transcripts: nullable, populated according to `kind`.
  // Both targets are already locked, so both are one-directional for the same reason as above.
  // `many_to_many`, not `one_to_many` (issue #82): a source Inbox item/Transcript can end up
  // referenced by more than one proposal over time (e.g. a superseding proposal created after
  // an earlier one for the same source was rejected/soft-deleted), and with no inverse to
  // swap onto, `one_to_many` would wrongly cap each source to a single proposal.
  const processingProposalsContext: SystemRelationWriteContext = { ownerProcess: PROCESSING_PROPOSALS_MODULE_ID };
  await relate(
    {
      sourceDatabaseId: processingProposals.id,
      key: "sourceInbox",
      name: "Source inbox item",
      targetDatabaseId: inbox.id,
      cardinality: "many_to_many",
      owner: "system",
      ownerProcess: PROCESSING_PROPOSALS_MODULE_ID,
    },
    processingProposalsContext,
  );
  await relate(
    {
      sourceDatabaseId: processingProposals.id,
      key: "sourceTranscript",
      name: "Source transcript",
      targetDatabaseId: transcriptsDatabaseId,
      cardinality: "many_to_many",
      owner: "system",
      ownerProcess: PROCESSING_PROPOSALS_MODULE_ID,
    },
    processingProposalsContext,
  );

  // Issue #103: react to a changed Inbox item without periodically scanning the whole
  // database. One heartbeat row per event kind — `onItemEventRule.event` is a single enum,
  // not an array — each dispatching the same `semprec.tick` action; the actual proposal
  // computation is issue #223's scope, not this seed's.
  for (const event of ["create", "update", "delete"] as const) {
    await createHeartbeat(client, {
      projectItemId: semprecProjectItemId,
      name: `Inbox tick (${event})`,
      rule: { kind: "onItemEvent", databaseId: inbox.id, event },
      actionId: SEMPREC_TICK_ACTION_ID,
      actionConfig: {
        inboxDatabaseId: inbox.id,
        inboxItemTypesDatabaseId: inboxItemTypes.id,
        processingProposalsDatabaseId: processingProposals.id,
      },
    });
  }

  const all: InboxPipelineDatabases = { inbox, inboxItemTypes, processingProposals };
  await client.query(`UPDATE databases SET schema_locked = true WHERE id = ANY($1::uuid[])`, [
    [inbox.id, inboxItemTypes.id, processingProposals.id],
  ]);

  for (const database of Object.values(all)) {
    await viewsStore.createView(
      client,
      { databaseId: database.id, type: "table", name: database.name, isDefault: true, createdBy: "system" },
      viewTypeRegistry,
    );
  }

  return all;
}
