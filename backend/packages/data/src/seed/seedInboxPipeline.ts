import type { PoolClient } from "pg";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as viewsStore from "../chokePoint/viewsStore.js";
import {
  createRelationPropertyWithClient,
  type CreateRelationPropertyInput,
} from "../chokePoint/relationPropertyOps.js";
import type { SystemRelationWriteContext } from "../chokePoint/relationEdgeContext.js";
import type { ComputedKeyRegistry } from "../chokePoint/computedKeyRegistry.js";
import type { ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import type { DatabaseRow } from "../types.js";
import { INBOX_ITEM_TYPES_MODULE_ID, INBOX_MODULE_ID, PROCESSING_PROPOSALS_MODULE_ID } from "./inboxPipelineKeys.js";
import { THREADS_MODULE_ID } from "./emailModuleKeys.js";
import { CORE_DATABASE_MODULE_IDS } from "./tenDatabaseKeys.js";
import { INBOX_TYPE_MODULE_TARGET_DATABASES, PROCESSING_METHODS } from "../inbox/inboxTypesStore.js";
import { CAPTURE_CHANNELS } from "../inbox/captureSource.js";
import { createHeartbeat } from "../scheduler/schedulerStore.js";
import { SEMPREC_TICK_ACTION_ID } from "../inbox/inboxTickAction.js";
import { JOURNAL_INBOX_COMPUTED_KEY } from "../inbox/journalInboxCompute.js";
import { registerJournalInboxViewType } from "../views/journalInboxViewType.js";
import { INBOX_TRANSCRIBED_TEXT_KEY } from "../inbox/inboxVoiceNote.js";
import { TRANSCRIPTION_OWNER_PROCESS } from "../transcription/transcriptionJob.js";
import { createProps, selectConfig } from "./propSpecs.js";

async function createDb(
  client: PoolClient,
  name: string,
  ownerModuleId: string,
  ownerProjectItemId: string,
): Promise<DatabaseRow> {
  return databasesStore.createDatabase(client, { name, system: true, ownerModuleId, ownerProjectItemId });
}

export interface InboxPipelineDatabases {
  inbox: DatabaseRow;
  inboxItemTypes: DatabaseRow;
  processingProposals: DatabaseRow;
}

/**
 * Seeds Inbox / Inbox item types / Processing proposals and the Inbox `semprec.tick` heartbeats. Needs the
 * core databases, Threads and the Semprec project item.
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

  // Declared ahead of any writes; the process-local registries need this on every startup, not only
  // on the one-time seed.
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

  // Mandatory and never derived as "today" (offline and delayed capture rely on them); enforced by inboxCreateHook.ts.
  await createProps(client, inbox.id, [
    { key: "date", name: "Date", type: "date", owner: "user" },
    { key: "time", name: "Time", type: "time", owner: "user" },
    { key: "text", name: "Text", type: "text", owner: "user", config: { format: "markdown" } },
    // How and from where the item was captured and when the server accepted it; `addedAt` is written by
    // `inbox/inboxStore.ts` as the Inbox module.
    {
      key: "captureChannel",
      name: "Capture channel",
      type: "select",
      owner: "user",
      config: selectConfig([...CAPTURE_CHANNELS]),
    },
    { key: "sourceApp", name: "Source app", type: "text", owner: "user" },
    {
      key: "addedAt",
      name: "Added at",
      type: "date",
      owner: "system",
      ownerProcess: INBOX_MODULE_ID,
      config: { includeTime: true },
    },
    // Transcript of the item's short voice notes, written by the transcribe process, never by the person,
    // whose own text stays in `text`.
    {
      key: INBOX_TRANSCRIBED_TEXT_KEY,
      name: "Transcribed text",
      type: "text",
      owner: "system",
      ownerProcess: TRANSCRIPTION_OWNER_PROCESS,
    },
  ]);

  await createProps(client, inboxItemTypes.id, [
    { key: "name", name: "Name", type: "title", owner: "user" },
    { key: "emoji", name: "Emoji", type: "text", owner: "user" },
    // An archived type disappears from `GET /api/inbox-types` while existing items keep pointing at it.
    { key: "status", name: "Status", type: "select", owner: "user", config: selectConfig(["active", "archived"]) },
    // Cross-field rules ("database" requires targetDatabase, "pageContent"/"journal" reject it) are enforced
    // in inbox/inboxTypesStore.ts; the schema engine has no cross-field validation.
    {
      key: "processingMethod",
      name: "Processing method",
      type: "select",
      owner: "user",
      config: selectConfig([...PROCESSING_METHODS]),
    },
    // Not a `relation` (whose target is fixed): stores the target's `owner_module_id`; the item is decided at run time.
    {
      key: "targetDatabase",
      name: "Target database",
      type: "select",
      owner: "user",
      // The hardcoded core databases, then the module targets.
      config: selectConfig([...CORE_DATABASE_MODULE_IDS, ...INBOX_TYPE_MODULE_TARGET_DATABASES]),
    },
  ]);

  await createProps(client, processingProposals.id, [
    // `mailThread`: the card of a task Semp proposes from a mail thread.
    {
      key: "kind",
      name: "Kind",
      type: "select",
      owner: "system",
      config: selectConfig(["inbox", "transcript", "mailThread"]),
    },
    { key: "fingerprint", name: "Fingerprint", type: "text", owner: "system" },
    // { entityKind, target, properties }: one generic envelope for every processingMethod, so a chat revise
    // can rewrite it wholesale. `entityKind` is 'database', 'pageContent' or 'relation'.
    { key: "proposal", name: "Proposal", type: "json", owner: "system" },
    // [{ author: 'ai'|'user', message, at }] — chat + decision log.
    { key: "history", name: "History", type: "json", owner: "system" },
    {
      key: "status",
      name: "Status",
      type: "select",
      owner: "system",
      config: selectConfig([
        "needsClarification",
        "proposed",
        "confirmed",
        "rejected",
        "invalid",
        "computing",
        "computeFailed",
      ]),
    },
    // Filled in by confirm; not a relation, since the target can be any system database's item.
    { key: "resultItemId", name: "Result item ID", type: "text", owner: "system" },
    { key: "resultLabel", name: "Result label", type: "text", owner: "system" },
    // The last proposal by an automated producer, the base for "return to the assistant's proposal".
    { key: "aiProposal", name: "AI proposal", type: "json", owner: "system" },
    { key: "userOverrides", name: "User overrides", type: "json", owner: "system" },
    { key: "userEditedKeys", name: "User-edited keys", type: "json", owner: "system" },
    { key: "aiVersion", name: "AI version", type: "number", owner: "system" },
    // Localized explanation of a proposal; used only by cards of kind `inbox`.
    { key: "reason", name: "Reason", type: "text", owner: "system" },
    { key: "recognizedTypeId", name: "Recognized type ID", type: "text", owner: "system" },
    { key: "typeCandidates", name: "Type candidates", type: "json", owner: "system" },
    // Candidate events and speakers shown on transcript cards; transcript alternatives and reasons live in `context`.
    { key: "candidates", name: "Candidates", type: "json", owner: "system" },
    { key: "invalidReason", name: "Invalid reason", type: "json", owner: "system" },
    { key: "referencedItemIds", name: "Referenced item IDs", type: "json", owner: "system" },
    { key: "results", name: "Results", type: "json", owner: "system" },
    // Producer-written data of a transcript card; declared as an opaque json property until its producer defines the shape.
    { key: "context", name: "Context", type: "json", owner: "system" },
    // Set on a sibling card split from an Inbox source; holds the primary card's id.
    { key: "splitFromProposalId", name: "Split from proposal ID", type: "text", owner: "system" },
  ]);

  // Inbox -> Inbox item types: nullable, one-directional, `many_to_many` (with no inverse, `one_to_many` would
  // cap each type to one item).
  await relate({
    sourceDatabaseId: inbox.id,
    key: "type",
    name: "Type",
    targetDatabaseId: inboxItemTypes.id,
    cardinality: "many_to_many",
    owner: "user",
  });

  // Inbox -> Journal: system-owned, resolved by the create hook; one-directional (Journal is locked), many_to_many.
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

  // Processing proposals -> Inbox / Transcripts: one-directional; many_to_many since a source can get several proposals.
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

  // Processing proposals -> Threads: the thread a `mailThread` card proposes a task for, written with the
  // card. One-directional (Threads is locked); `many_to_many` as above.
  const threads = await databasesStore.getDatabaseByModuleId(client, THREADS_MODULE_ID);
  if (!threads) throw new Error("Threads database is missing: the email module must be seeded first");
  await relate(
    {
      sourceDatabaseId: processingProposals.id,
      key: "sourceThread",
      name: "Source thread",
      targetDatabaseId: threads.id,
      cardinality: "many_to_many",
      owner: "system",
      ownerProcess: PROCESSING_PROPOSALS_MODULE_ID,
    },
    processingProposalsContext,
  );

  // Reacts to changed Inbox items without scanning: one heartbeat per event kind (`onItemEventRule.event`
  // is a single value), each dispatching `semprec.tick`.
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

  // View names come from `database.name`, so the label has one source outside this file.
  const defaultViewDatabases: DatabaseRow[] = [all.inbox, all.inboxItemTypes, all.processingProposals];
  for (const database of defaultViewDatabases) {
    await viewsStore.createView(
      client,
      { databaseId: database.id, type: "table", name: database.name!, isDefault: true, createdBy: "system" },
      viewTypeRegistry,
    );
  }

  return all;
}
