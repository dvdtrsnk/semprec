import { insertInboxOriginNotes } from "./originNote.js";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { PoolClient } from "pg";
import { deriveEventTimeProperties, eventDateIsInstant } from "../calendar/eventTime.js";
import { readProposalTimezone } from "./proposalComputedUpdates.js";
import { assertEventCreateRules } from "../calendar/eventValidationHook.js";
import { parseOccurrenceId } from "../calendar/eventOccurrenceId.js";
import { materializeEventOccurrence } from "../calendar/materializeEventOccurrence.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import {
  assertRelationCreatableWithClient,
  createRelationIfAbsentWithClient,
  createRelationWithClient,
} from "../chokePoint/relationOps.js";
import { putBlockWithClient } from "../docs/docStore.js";
import { pageContentV2Schema } from "./proposalEnvelope.js";
import { insertProposalPageContent } from "./proposalPageContent.js";
import { LOCKED_PROPOSAL_STATUSES } from "./inboxTypesStore.js";
import { assertProposalVersion, incompatibleStatusError } from "./proposalPreconditions.js";
import {
  aiProposalPatch,
  appendHistoryEntry,
  assertValidProposalEnvelope,
  isFinalInvalid,
  parseStoredProposalEnvelope,
  unknownStoredEntityKind,
  type ProposalEntityKind,
  type ProposalEnvelope,
} from "./inboxTickAction.js";
import { insertItemOrigins } from "./itemOriginsStore.js";
import { requireRelationPropertyId, resolveItemOriginSource } from "./proposalItemOrigin.js";
import { MAIL_THREAD_CARD_KIND, assertValidMailThreadCard, confirmMailThreadCard } from "./mailThreadCard.js";
export {
  updateProposalValuesWithClient,
  type UpdateProposalValuesInput,
  type UpdateProposalValuesResult,
} from "./proposalValueUpdates.js";
export { reviseProposalFromThreadWithClient, type ReviseProposalFromThreadInput } from "./proposalThreadRevision.js";
export { resetProposalOverridesWithClient, type ResetProposalOverridesInput } from "./proposalReset.js";
export { reopenProposalWithClient, type ReopenProposalInput, type ReopenProposalResult } from "./proposalReopen.js";
export { recomputeProposalWithClient, type RecomputeProposalInput } from "./proposalRecompute.js";
import { recordTranscriptCardInstruction } from "./transcriptCardInstruction.js";
export type { ProposalWarning } from "./editorSchema.js";
import { assertRequiredFieldsHaveValues } from "./proposalEditorRules.js";
import { assertCardIsNotStdioMcpServer, normalizeEnvelopeForWrite } from "./proposalHiddenFields.js";
import { appendDroppedValuesEntry, retainValuesForRevise } from "./proposalRetention.js";
import { executeProposalSteps } from "./proposalSteps.js";
import { createEdgeRecorder, writeRecordedEdge } from "./proposalEdgeRecording.js";
import { effectiveStepRelations } from "./proposalStepGraph.js";
import { enqueueJournalInboxRecomputeForProposal } from "./journalInboxCompute.js";
import { referencedItemIdsOf, runWhileConfirmingCard } from "./proposalReferences.js";
import { publishInboxCardChange } from "./inboxCardsRealtime.js";
import { MCP_SERVERS_MODULE_ID } from "../seed/mcpModuleKeys.js";
import { EVENTS_MODULE_ID, PEOPLE_MODULE_ID, TRANSCRIPTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { releaseTrashedEventEdges } from "../transcription/transcriptEventEdges.js";
import { addSpeakersAsEventParticipants } from "../transcription/transcriptEventParticipants.js";
import { transcriptSpeakerCardContextSchema } from "../transcription/transcriptSpeakerCardContext.js";
import { TRANSCRIPT_SPEAKERS_PROPERTY_KEY } from "../transcription/transcriptionSpeakerEdges.js";
import { storeCredential, type CredentialType } from "../credentials/externalCredentialsStore.js";
import { ChokePointError, ConflictError, NotFoundError, ValidationError } from "../errors.js";
import type { DatabaseRow, ItemRow } from "../types.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";

/** Confirming a proposal is a person's decision, so every write in its transaction is a `user` write. */
const CONFIRMING_USER_WRITER: WriterIdentity = { writerKind: "user" };

export interface ProposalActionConfig {
  processingProposalsDatabaseId: string;
}

/**
 * A logged-in human's separately-supplied secret for an MCP server proposal (issue #123) —
 * never part of the envelope's `properties`, and only ever accepted by `confirmProposalWithClient`
 * itself, never `revise` (a chat-driven, AI-visible correction). Optional: not every MCP server
 * needs a credential (e.g. a local `stdio` command with no auth of its own).
 */
export interface ConfirmProposalCredentialInput {
  credentialType: CredentialType;
  plaintext: string;
}

/** Row-locks the proposal (serializing concurrent confirm/reject/revise on the same row) and rejects a missing or soft-deleted one. */
export async function lockLiveProposal(client: PoolClient, databaseId: string, proposalId: string): Promise<ItemRow> {
  const proposal = await itemsStore.lockItemById(client, databaseId, proposalId);
  if (!proposal || proposal.deletedAt) throw new NotFoundError(`Processing proposal ${proposalId} not found`);
  return proposal;
}

/** The target item's own title-property value, for `resultLabel` — falls back to the item id when the target database declares no title property or the value is empty. */
async function resolveResultLabel(client: PoolClient, databaseId: string, item: ItemRow): Promise<string> {
  const properties = await propertiesStore.listPropertiesByDatabase(client, databaseId);
  const titleProperty = properties.find((property) => property.type === "title");
  const value = titleProperty ? item.properties[titleProperty.key] : undefined;
  return typeof value === "string" && value.length > 0 ? value : item.id;
}

export const confirmationResultSchema = z.object({
  ref: z.string(),
  itemId: z.string(),
  databaseKey: z.string().nullable(),
  label: z.string(),
  role: z.enum(["primary", "secondary"]),
  date: z.string().nullable(),
  linkLabels: z.array(z.string()),
  followUp: z.enum(["transcriptionQueued", "mcpSyncQueued"]).nullable(),
  updatedAt: z.string(),
  blockIds: z.array(z.string()),
});
export type ConfirmationResult = z.infer<typeof confirmationResultSchema>;

/** Validates the stored JSON before returning it across the API boundary. */
export function readConfirmationResults(properties: Record<string, unknown>): ConfirmationResult[] {
  return z.array(confirmationResultSchema).parse(properties.results ?? []);
}

/** The Transcripts `event` relation property: the Transcription<->Event edge a transcript card's confirm writes. */
const TRANSCRIPT_EVENT_PROPERTY_KEY = "event";

/**
 * What a `kind = 'transcript'` card proposes (issue #185): either the transcript's Event (create a
 * new one, or link an existing one through Transcripts `event`), or one speaker-to-person mapping
 * (a link through Transcripts `speakers` whose metadata names the speaker key). A card keeps its
 * role for life — `revise` may change the Event or the person, never turn one role into the other.
 */
type TranscriptCardRole = "event" | "speaker";

/** What a transcript card's confirm writes: an edge from its source transcript through `relationPropertyId`. */
interface TranscriptCardEdge {
  role: TranscriptCardRole;
  transcriptId: string;
  relationPropertyId: string;
  speaker?: string;
}

/**
 * What `assertValidEnvelopeForCard` resolved on the caller's behalf: the transcript-card edge
 * (`null` for a non-transcript card), and the envelope's target database row for a `'database'`
 * envelope (`null` for `'relation'`/`'pageContent'`) — `confirmProposalWithClient`'s credential
 * guard reuses that row instead of re-fetching it (issue #735).
 */
/** Whether `error` is the v2 page-content check's refusal of a heading that is no longer on the page. */
function isHeadingUnavailable(error: ValidationError): boolean {
  const details: unknown = error.details;
  return (
    typeof details === "object" && details !== null && "reason" in details && details.reason === "heading_unavailable"
  );
}

export interface EnvelopeForCard {
  transcriptCardEdge: TranscriptCardEdge | null;
  targetDatabase: DatabaseRow | null;
  /** The Threads item of a `kind = 'mailThread'` card's `sourceThread` edge; absent for any other card. */
  mailThreadItemId?: string;
}

/** An unknown stored kind is displayed, never executed: this release cannot validate or run it. */
export function unsupportedEntityKindError(entityKind: string): ConflictError {
  return new ConflictError(`Proposal entityKind '${entityKind}' is not supported by this release`, {
    field: "entityKind",
    entityKind,
  });
}

export function transcriptCardRole(envelope: ProposalEnvelope): TranscriptCardRole {
  return envelope.entityKind === "relation" && envelope.properties.propertyKey === TRANSCRIPT_SPEAKERS_PROPERTY_KEY
    ? "speaker"
    : "event";
}

/** A `'relation'` envelope's optional edge metadata; `assertValidProposalEnvelope` has already rejected anything but a plain object. */
function relationEnvelopeMetadata(envelope: ProposalEnvelope): Record<string, unknown> | undefined {
  const { metadata } = envelope.properties;
  if (metadata === undefined) return undefined;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    throw new ValidationError("Relation proposal metadata must be an object", { field: "properties" });
  }
  return { ...metadata };
}

async function requireDatabaseIdByModuleId(client: PoolClient, moduleId: string): Promise<string> {
  const database = await databasesStore.getDatabaseByModuleId(client, moduleId);
  if (!database) throw new NotFoundError(`Database for module '${moduleId}' not found`);
  return database.id;
}

/**
 * Writes the envelope's `relations` edges from the freshly created item, in the order of the keys
 * and ids in the envelope. Runs in the confirm transaction, so a failing edge aborts the item and
 * every earlier edge; the edge's own canonical error is rethrown with `details.field` set to the
 * relation key.
 */
async function writeEnvelopeRelations(
  client: PoolClient,
  databaseId: string,
  itemId: string,
  relations: ProposalEnvelope["relations"],
  actingUserId?: string,
): Promise<void> {
  for (const [key, targetItemIds] of Object.entries(relations ?? {})) {
    const relationPropertyId = await requireRelationPropertyId(client, databaseId, key);
    for (const targetItemId of targetItemIds) {
      try {
        await createRelationWithClient(
          client,
          { relationPropertyId, callerItemId: itemId, targetItemId },
          undefined,
          CONFIRMING_USER_WRITER,
          actingUserId,
        );
      } catch (error) {
        if (!(error instanceof ChokePointError)) throw error;
        const details = typeof error.details === "object" && error.details !== null ? error.details : {};
        throw new ChokePointError(error.status, error.code, error.message, { ...details, field: key });
      }
    }
  }
}

/**
 * Before a pairing card (role `event`) writes its transcript's edge to the Event it confirms: deletes that
 * transcript's edge to an Event in the Trash, in the confirm transaction, as the confirming user's write
 * (issue #1743). The relation allows a transcript one Event, so the new edge would otherwise fail with
 * `cardinality_violation`. A speaker card writes through `speakers` and removes nothing.
 */
async function releaseTrashedEventOfPairingCard(
  client: PoolClient,
  edge: TranscriptCardEdge,
  actingUserId?: string,
): Promise<void> {
  if (edge.role !== "event") return;
  await releaseTrashedEventEdges(
    client,
    { eventPropertyId: edge.relationPropertyId, transcriptId: edge.transcriptId },
    CONFIRMING_USER_WRITER,
    actingUserId,
  );
}

/** The transcript a `kind = 'transcript'` card was created for, via its `sourceTranscript` edge (written with the card by the match step). */
export async function requireSourceTranscriptId(
  client: PoolClient,
  config: ProposalActionConfig,
  proposal: ItemRow,
): Promise<string> {
  const propertyId = await requireRelationPropertyId(client, config.processingProposalsDatabaseId, "sourceTranscript");
  const relationDefinition = await relationsStore.getRelationDefinitionByPropertyId(client, propertyId);
  if (!relationDefinition)
    throw new NotFoundError(`Relation definition for Processing proposals 'sourceTranscript' not found`);
  const [edge] = await relationsStore.listRelationsForItem(client, relationDefinition.id, proposal.id);
  if (!edge) {
    throw new ValidationError(`Transcript proposal ${proposal.id} has no source transcript`, {
      field: "sourceTranscript",
    });
  }
  return relationsStore.otherSide(edge, proposal.id);
}

/**
 * Validates an envelope against the card it is for (issue #184), on top of the envelope's own
 * shape (`assertValidProposalEnvelope`). A `'relation'` envelope needs a source item to link from,
 * which only a `kind = 'transcript'` card has. A transcript card can:
 * create a new Event (`'database'` targeting Events), link its transcript to an existing Event
 * (`'relation'` through the Transcripts `event` property), or map one of its speaker keys to a
 * person (`'relation'` through `speakers`, issue #185), or create a person for a speaker card —
 * and never switches between an Event shape
 * and a speaker mapping (`transcriptCardRole`). A link is checked against the relation's
 * integrity, ownership and edge-metadata rules now, with the same canonical errors the write
 * itself would raise. A create-Event envelope also has to pass the Events create rules on its times
 * (`assertEventCreateRules`, issue #1818). Returns the edge confirm must write for a transcript card (`null` for any
 * other card) alongside the envelope's target database row (`null` for a non-`'database'`
 * envelope). A `kind = 'mailThread'` card (issue gh-2034) must carry a Tasks `database` envelope with only a `name` and
 * an optional `date` (`assertValidMailThreadCard`, whose own rules are checked before the generic validation) and a `sourceThread` edge;
 * it returns that edge's Threads item as `mailThreadItemId`.
 */
export async function assertValidEnvelopeForCard(
  client: PoolClient,
  config: ProposalActionConfig,
  proposal: ItemRow,
  envelope: ProposalEnvelope,
): Promise<EnvelopeForCard> {
  if (proposal.properties.kind === MAIL_THREAD_CARD_KIND)
    return assertValidMailThreadCard(client, config, proposal, envelope);
  const targetDatabase = await assertValidProposalEnvelope(client, envelope);
  if (proposal.properties.kind !== "transcript") {
    if (envelope.entityKind === "relation") {
      throw new ValidationError("entityKind 'relation' is only valid on a transcript proposal", {
        field: "entityKind",
      });
    }
    return { transcriptCardEdge: null, targetDatabase };
  }

  const current = parseStoredProposalEnvelope(proposal.properties.proposal, proposal.id);
  if (current && "unknownKind" in current) throw unsupportedEntityKindError(current.entityKind);
  const rawContext = proposal.properties.context;
  const contextRole = z.object({ role: z.literal("speaker") }).safeParse(rawContext).success;
  const speakerContext = contextRole ? transcriptSpeakerCardContextSchema.parse(rawContext) : null;
  const priorRole = speakerContext ? "speaker" : current ? transcriptCardRole(current) : null;
  const isPeopleCreation = envelope.entityKind === "database" && targetDatabase?.ownerModuleId === PEOPLE_MODULE_ID;
  const role: TranscriptCardRole =
    isPeopleCreation && (priorRole === "speaker" || speakerContext) ? "speaker" : transcriptCardRole(envelope);
  if (priorRole && priorRole !== role) {
    throw new ValidationError("A transcript proposal cannot switch between an Event and a speaker mapping", {
      field: "entityKind",
    });
  }
  if (isPeopleCreation && role === "speaker") {
    if (!speakerContext) throw new ValidationError("Speaker context is required", { field: "context" });
    const person = z
      .object({ name: z.string(), relationship: z.string().optional() })
      .strict()
      .safeParse(envelope.properties);
    if (!person.success || envelope.relations !== undefined || envelope.operations !== undefined)
      throw new ValidationError("Invalid speaker person proposal", { field: "properties" });
  }

  const transcriptId = await requireSourceTranscriptId(client, config, proposal);
  const transcriptsDatabaseId = await requireDatabaseIdByModuleId(client, TRANSCRIPTS_MODULE_ID);
  const relationPropertyId = await requireRelationPropertyId(
    client,
    transcriptsDatabaseId,
    role === "speaker" ? TRANSCRIPT_SPEAKERS_PROPERTY_KEY : TRANSCRIPT_EVENT_PROPERTY_KEY,
  );
  switch (envelope.entityKind) {
    case "database": {
      const expectedDatabaseId = await requireDatabaseIdByModuleId(
        client,
        role === "speaker" ? PEOPLE_MODULE_ID : EVENTS_MODULE_ID,
      );
      if (envelope.target !== expectedDatabaseId) {
        throw new ValidationError("Invalid transcript proposal target", { field: "target" });
      }
      // The Event the confirm creates must pass the Events rules, so a revised start and end that confirm would
      // refuse are refused now (issue #1818). The Events time transform runs first, as it does on the write.
      if (role === "event") {
        // The zone is read as every Inbox proposal preparation reads it: an invalid stored zone is a settings failure
        // and propagates, it is not a 400 on the date the user entered (docs/adr/2026-11-07-proposal-preparation-uses-trusted-tenant-timezone.md).
        const zone = eventDateIsInstant(envelope.properties.date) ? await readProposalTimezone(client) : undefined;
        assertEventCreateRules(deriveEventTimeProperties(null, envelope.properties, zone));
      }
      break;
    }
    case "relation":
      if (role === "event" && envelope.properties.propertyKey !== TRANSCRIPT_EVENT_PROPERTY_KEY) {
        throw new ValidationError(
          `A transcript proposal can only link through the '${TRANSCRIPT_EVENT_PROPERTY_KEY}' or '${TRANSCRIPT_SPEAKERS_PROPERTY_KEY}' relation`,
          { field: "properties" },
        );
      }
      // An occurrence that has no item yet cannot be checked as a target. `assertValidProposalEnvelope` has checked
      // that its series exists, and the item the confirm creates is a copy of the series Event with its edges, so the
      // series Event stands in for the relation's checks (issue gh-1850).
      await assertRelationCreatableWithClient(client, {
        relationPropertyId,
        callerItemId: transcriptId,
        targetItemId: parseOccurrenceId(envelope.target)?.seriesId ?? envelope.target,
        metadata: relationEnvelopeMetadata(envelope),
      });
      if (
        role === "speaker" &&
        speakerContext &&
        relationEnvelopeMetadata(envelope)?.speaker !== speakerContext.speaker
      ) {
        throw new ValidationError("Speaker proposal must keep its original speaker", { field: "properties" });
      }
      break;
    case "pageContent":
      throw new ValidationError("A transcript proposal cannot append page content", { field: "entityKind" });
    default: {
      const exhaustive: never = envelope.entityKind;
      throw new Error(`Unhandled proposal entityKind: ${String(exhaustive)}`);
    }
  }
  return {
    transcriptCardEdge: {
      role,
      transcriptId,
      relationPropertyId,
      ...(role === "speaker" && speakerContext ? { speaker: speakerContext.speaker } : {}),
    },
    targetDatabase,
  };
}

/**
 * `POST /api/proposals/:id/confirm` (issue #105): the sole cross-destination write path —
 * an agent proposes via `processingProposals`, only a user-context confirm may ever create
 * or amend a target database item or page block. Idempotent under retry: an
 * already-`confirmed` proposal is returned as-is rather than re-executing the destination
 * write (which would otherwise double-create a `database` item, or duplicate wall-clock
 * history entries on a `pageContent` block).
 *
 * `envelope.target` is re-validated against current destination state (issue #104's
 * `assertValidProposalEnvelope`) rather than trusting whatever passed validation when the
 * proposal was computed — the target database/page could have been deleted or had its
 * schema changed since.
 *
 * A v2 `pageContent` envelope (a Markdown `{ markdown, placement, heading? }`, issue #1681) is written by
 * `insertProposalPageContent` in this same transaction, before the card is locked `confirmed`: the page document is
 * created when the target has none, the placement is resolved on the page as it stands, and the blocks (the optional
 * heading first) get ids derived from the proposal id. A chosen heading that is gone is a `ConflictError` (409) and the
 * card stays `proposed`. Its blocks are authored `user`, like the old shape's.
 *
 * For an old-shape `pageContent`, the appended block's `id` is the proposal's own id, not a freshly
 * generated one: `putBlockWithClient`'s block upsert is itself idempotent on a given id, so
 * a confirm retried after a crash between the block write and the `confirmed` lock below
 * (both in the same transaction here, but a caller retrying after an earlier failed attempt
 * could still see this ordering) overwrites the same block rather than leaving an orphaned
 * duplicate.
 *
 * `credential` (issue #123) is the confirming human's separately-supplied secret for an MCP
 * server proposal — accepted only when `envelope.target` is the `mcpServers` database (a
 * `ValidationError` otherwise, so a credential can never land against an unrelated target by
 * mistake), and stored via `storeCredential` in the same transaction as the item create,
 * immediately before the row is locked `confirmed` below: since `createItemWithClient` and
 * `storeCredential` both run inside this function's caller-supplied transaction, either both
 * persist or neither does — a `storeCredential` failure rolls back the item create too,
 * satisfying "stores server and encrypted credential or neither." Not every server needs one
 * (e.g. a local `stdio` command with no auth), so a proposal with no `credential` argument at
 * all is confirmed normally, item-only.
 *
 * For `'relation'` (issue #184) the write is the generic relation write behind
 * `PUT /api/items/:id/relations/:propertyKey/:targetItemId`, from the card's source item to
 * `envelope.target`, and the result is that existing item. When `envelope.target` is a synthetic occurrence id
 * (`<seriesId>@<date>`, issue gh-1850), the confirm first materializes it (`materializeEventOccurrence`) in the same
 * transaction, and the edge and the result are the occurrence's item, the new one or the one that already existed,
 * not `envelope.target`. A `kind = 'transcript'` card also
 * gets its Transcription<->Event edge: for `'relation'` that edge is the relation write itself;
 * for `'database'` it is written last, after the Event's envelope relations and its participants. Both run in the caller's one
 * transaction, so a failed edge write (e.g. `cardinality_violation` when the transcript is already
 * linked to another Event that is not in the Trash; an Event may hold many transcripts) leaves no Event, no
 * edge and the card still `proposed`. An edge from the transcript to an Event in the Trash is deleted in this
 * transaction right before the pairing edge is written (issue #1743, `releaseTrashedEventOfPairingCard`), so
 * it does not fail that write and comes back when the confirm rolls back.
 * A `'database'` envelope's `relations` (issue #1476) are written the same way, right after
 * the item, one edge per target id with the new item as caller; any failing edge aborts the item
 * and the earlier edges, and its error carries `details.field` = the relation key. An Event created
 * by a transcript card also gets, before the transcript edge, an Events `people` edge for every person
 * the transcript's `speakers` edges map at that moment except the tenant's own person
 * (`addSpeakersAsEventParticipants`, issue #1818); a failing write there rolls everything back too. A speaker-mapping transcript card (issue #185) writes its `speakers` edge with the
 * envelope's `{ speaker }` metadata as the relation write itself — the user-owned mapping only
 * ever exists once a human confirmed it. A `fileFromAttachment` step (issue #1703) moves an attachment
 * of the card's source Inbox item into Files inside the same transaction; `executeProposalSteps` does it.
 *
 * A visible required field of the card's editor schema that has no value (issue #1928, `assertRequiredFieldsHaveValues`)
 * is a `ValidationError` naming it, raised after the envelope validation and before any write; a card whose base
 * kind has no schema is not checked.
 *
 * What is written is what the card's editor shows (issue #1934, `normalizeEnvelopeForWrite`): the properties of the
 * fields the schema hides are left out of the created item (the time part of an all-day card as `timeFrom` and
 * `timeTo`, which an Event stores as null, and the time of day inside its `date`), and an MCP server card is written as `{ transport, url }`. A card whose
 * MCP server connection is `stdio` is a `ValidationError` on `transport`, raised before the envelope validation.
 *
 * A `kind = 'mailThread'` card (issue gh-2034) does not create its task with `createItemWithClient`: it calls
 * `confirmMailThreadCard`, which writes the task, its `Threads.tasks` edge and the thread's project and people through
 * `createThreadTask` in this same transaction. It writes no item origin and no origin note, because the card has no
 * Inbox item or transcript to take them from. A source Threads item that is in the Trash is a 409 `conflict` with
 * nothing written, and the card stays `proposed`.
 *
 * The reference hooks leave this card alone while its steps run (`runWhileConfirmingCard`, issue #1916).
 *
 * The edges the confirm writes between items that already existed (a link step, the edges an update step adds, the
 * edge of a transcript card) and the edges an update step deletes are recorded in the history entry of the confirmation
 * (`writtenRelations`, `removedRelations`; `proposalEdgeRecording.ts`), so the undo reverses only those
 * (`docs/adr/2026-11-14-the-undo-of-a-confirmation-reverses-only-the-edges-it-recorded.md`).
 *
 * `ifVersion` (issue #1852) is the `updatedAt` the caller last saw. It is checked after the card is locked, after
 * the answer for a card that is already `confirmed` (returned unchanged, whatever `ifVersion` says, so a replayed
 * decision succeeds) and after the refusal of any status other than `proposed`: an `ifVersion` that is not the
 * locked card's `updatedAt` throws the 409 `version_conflict` and nothing is written. Without it nothing is checked.
 */
export async function confirmProposalWithClient(
  client: PoolClient,
  config: ProposalActionConfig,
  proposalId: string,
  credential?: ConfirmProposalCredentialInput,
  actingUserId?: string,
  ifVersion?: string,
): Promise<ItemRow> {
  const proposal = await lockLiveProposal(client, config.processingProposalsDatabaseId, proposalId);
  const status = proposal.properties.status;
  if (status === "confirmed") return proposal;
  if (status !== "proposed") {
    throw incompatibleStatusError(`Cannot confirm a proposal in status '${String(status)}'`, status);
  }
  assertProposalVersion(proposal, ifVersion);
  // A step may archive an item this card refers to; the reference hooks must not invalidate the card being confirmed.
  return runWhileConfirmingCard(client, proposal.id, async () => {
    const envelope = parseStoredProposalEnvelope(proposal.properties.proposal, proposal.id);
    if (!envelope) throw new ValidationError("Proposal has no computed envelope to confirm", { field: "proposal" });
    if ("unknownKind" in envelope) throw unsupportedEntityKindError(envelope.entityKind);
    const markdownPageContent = envelope.entityKind === "pageContent" && Object.hasOwn(envelope.properties, "markdown");
    if (markdownPageContent && proposal.properties.kind === "transcript")
      throw new ValidationError("A transcript proposal cannot target page content", { field: "entityKind" });
    await assertCardIsNotStdioMcpServer(client, envelope);
    let validated: EnvelopeForCard;
    try {
      validated = await assertValidEnvelopeForCard(client, config, proposal, envelope);
    } catch (error) {
      // A heading removed since the card was computed is a conflict the client can answer with a new choice, not a
      // malformed proposal: 409, the card stays `proposed` and nothing is written.
      if (markdownPageContent && error instanceof ValidationError && isHeadingUnavailable(error)) {
        throw new ConflictError("The chosen heading no longer exists on the page", { field: "placement" });
      }
      throw error;
    }
    const { transcriptCardEdge, targetDatabase, mailThreadItemId } = validated;
    await assertRequiredFieldsHaveValues(client, proposal, envelope);
    const written = await normalizeEnvelopeForWrite(client, proposal, envelope, targetDatabase);

    let resultItemId: string;
    let resultLabel: string;
    let stepResults: Array<{ ref: string; itemId: string; databaseId: string }> = [];
    let blockIds: string[] = [];
    const addedRelations: Array<{
      edgeId: string;
      relationPropertyId: string;
      callerItemId: string;
      targetItemId: string;
    }> = [];
    /** The edges between existing items this confirm writes or deletes, stored in its history entry for the undo. */
    const recorder = createEdgeRecorder();
    const reusedFileRefs = new Set<string>();
    /** The item a `'relation'` envelope linked: its `target`, or the item its synthetic occurrence id became. */
    let linkedTargetId: string | null = null;
    if (mailThreadItemId !== undefined) {
      if (credential) {
        throw new ValidationError("A credential may only be supplied when confirming an MCP server proposal", {
          field: "credential",
        });
      }
      const task = await confirmMailThreadCard(client, mailThreadItemId, written.properties, actingUserId);
      resultItemId = task.id;
      stepResults = [{ ref: "primary", itemId: task.id, databaseId: task.databaseId }];
      resultLabel = await resolveResultLabel(client, task.databaseId, task);
    } else if (envelope.entityKind === "database") {
      if (credential) {
        if (targetDatabase?.ownerModuleId !== MCP_SERVERS_MODULE_ID) {
          throw new ValidationError("A credential may only be supplied when confirming an MCP server proposal", {
            field: "credential",
          });
        }
      }
      const origin = await resolveItemOriginSource(client, config, proposal, transcriptCardEdge?.transcriptId ?? null);
      // A multi-step envelope writes every active step; a single-step one keeps the direct path below.
      let created: ItemRow;
      let createdItemIds: string[];
      let resultDatabaseId = envelope.target;
      if (written.operations) {
        const executed = await executeProposalSteps(client, written.operations, {
          writer: CONFIRMING_USER_WRITER,
          actingUserId,
          sourceInboxItemId: origin.inboxItemId,
        });
        const [primaryItem] = await itemsStore.getItemsByIds(client, [executed.primaryItemId]);
        if (!primaryItem) throw new Error(`Primary step item ${executed.primaryItemId} disappeared during confirm`);
        created = primaryItem;
        resultDatabaseId = executed.primaryDatabaseId;
        createdItemIds = executed.createdItemIds;
        stepResults = executed.executedSteps;
        for (const file of executed.fileFromAttachments) if (!file.created) reusedFileRefs.add(file.ref);
        recorder.written.push(...executed.recordedEdges.written);
        recorder.removed.push(...executed.recordedEdges.removed);
      } else {
        created = await createItemWithClient(
          client,
          { databaseId: envelope.target, properties: written.properties },
          { writer: CONFIRMING_USER_WRITER, actingUserId },
        );
        createdItemIds = [created.id];
      }
      await insertItemOrigins(client, createdItemIds, origin);
      await insertInboxOriginNotes(client, createdItemIds, origin.inboxItemId, actingUserId);
      resultItemId = created.id;
      if (!envelope.operations) stepResults = [{ ref: "primary", itemId: created.id, databaseId: created.databaseId }];
      resultLabel = await resolveResultLabel(client, resultDatabaseId, created);
      if (credential) {
        await storeCredential(client, {
          itemId: created.id,
          credentialType: credential.credentialType,
          plaintext: credential.plaintext,
        });
      }
      // A 'database' envelope on a transcript card is its create-Event shape, or a new person for a speaker card.
      // The Event gets its envelope relations and its participants before the transcript's own edge (issue #1818).
      // A multi-step envelope's relations live on its steps and were written by them.
      if (!envelope.operations) {
        await writeEnvelopeRelations(client, envelope.target, created.id, envelope.relations, actingUserId);
      }
      if (transcriptCardEdge?.role === "event") {
        addedRelations.push(
          ...(await addSpeakersAsEventParticipants(
            client,
            { transcriptId: transcriptCardEdge.transcriptId, eventId: created.id },
            CONFIRMING_USER_WRITER,
            actingUserId,
          )),
        );
      }
      if (transcriptCardEdge) {
        await releaseTrashedEventOfPairingCard(client, transcriptCardEdge, actingUserId);
        await writeRecordedEdge(
          client,
          recorder,
          {
            relationPropertyId: transcriptCardEdge.relationPropertyId,
            callerItemId: transcriptCardEdge.transcriptId,
            targetItemId: created.id,
            ...(transcriptCardEdge.role === "speaker" ? { metadata: { speaker: transcriptCardEdge.speaker } } : {}),
          },
          CONFIRMING_USER_WRITER,
          actingUserId,
        );
      }
    } else if (envelope.entityKind === "relation") {
      // `assertValidEnvelopeForCard` above only accepts a 'relation' envelope on a transcript
      // card, through the Transcripts `event` or `speakers` property — so `transcriptCardEdge`
      // names this write.
      if (!transcriptCardEdge) throw new Error(`Relation proposal ${proposal.id} has no source item to link from`);
      // A synthetic occurrence id becomes its Events item here, in the confirm's own transaction (issue gh-1850); a
      // repeat finds the item the first call created, and a cancelled occurrence's item refuses the link below.
      const occurrence = parseOccurrenceId(envelope.target);
      linkedTargetId = occurrence
        ? (
            await materializeEventOccurrence(client, {
              ...occurrence,
              options: { writer: CONFIRMING_USER_WRITER, actingUserId },
            })
          ).item.id
        : envelope.target;
      await releaseTrashedEventOfPairingCard(client, transcriptCardEdge, actingUserId);
      await writeRecordedEdge(
        client,
        recorder,
        {
          relationPropertyId: transcriptCardEdge.relationPropertyId,
          callerItemId: transcriptCardEdge.transcriptId,
          targetItemId: linkedTargetId,
          metadata: relationEnvelopeMetadata(envelope),
        },
        CONFIRMING_USER_WRITER,
        actingUserId,
      );
      const [linked] = await itemsStore.getItemsByIds(client, [linkedTargetId]);
      resultItemId = linkedTargetId;
      const [transcript] = await itemsStore.getItemsByIds(client, [transcriptCardEdge.transcriptId]);
      if (!transcript) throw new Error("Source transcript disappeared during confirm");
      stepResults = [{ ref: "primary", itemId: transcript.id, databaseId: transcript.databaseId }];
      resultLabel = linked ? await resolveResultLabel(client, linked.databaseId, linked) : linkedTargetId;
    } else {
      if (markdownPageContent) {
        // Validated by `assertValidProposalEnvelope` above, so the parse cannot fail; it types the stored properties.
        const content = pageContentV2Schema.parse(envelope.properties);
        blockIds = await insertProposalPageContent(client, proposal.id, envelope.target, content);
      } else {
        // Safe to cast without a further runtime check here: `assertValidProposalEnvelope`
        // above already rejects a 'pageContent' envelope whose `flavour` isn't a non-empty
        // string, or whose `fields`/`children` (if present) aren't a plain object / string
        // array respectively.
        const { flavour, fields, children } = envelope.properties as {
          flavour: string;
          fields?: Record<string, unknown>;
          children?: string[];
        };
        const inserted = await putBlockWithClient(
          client,
          envelope.target,
          { id: proposal.id, flavour, fields, children },
          "user",
        );
        blockIds = inserted ? [proposal.id] : [];
      }
      const [targetPage] = await itemsStore.getItemsByIds(client, [envelope.target]);
      resultItemId = envelope.target;
      if (!targetPage) throw new Error("Target page disappeared during confirm");
      stepResults = [{ ref: "primary", itemId: targetPage.id, databaseId: targetPage.databaseId }];
      resultLabel = await resolveResultLabel(client, targetPage.databaseId, targetPage);
    }

    if (transcriptCardEdge?.role === "speaker") {
      const [transcript] = await itemsStore.getItemsByIds(client, [transcriptCardEdge.transcriptId]);
      if (!transcript) throw new Error("Source transcript disappeared during confirm");
      const eventProperty = await requireRelationPropertyId(
        client,
        transcript.databaseId,
        TRANSCRIPT_EVENT_PROPERTY_KEY,
      );
      const definition = await relationsStore.getRelationDefinitionByPropertyId(client, eventProperty);
      if (!definition) throw new NotFoundError("Transcript event relation not found");
      const events = await relationsStore.listRelationsForItem(client, definition.id, transcript.id);
      if (events.length > 1) throw new ConflictError("Transcript has multiple linked events");
      const event = events[0] ? relationsStore.otherSide(events[0], transcript.id) : null;
      if (event) {
        const eventsDatabase = await requireDatabaseIdByModuleId(client, EVENTS_MODULE_ID);
        const relationPropertyId = await requireRelationPropertyId(client, eventsDatabase, "people");
        const added = await createRelationIfAbsentWithClient(
          client,
          { relationPropertyId, callerItemId: event, targetItemId: resultItemId },
          undefined,
          CONFIRMING_USER_WRITER,
          actingUserId,
        );
        if (added.inserted)
          addedRelations.push({
            edgeId: added.edge.id,
            relationPropertyId,
            callerItemId: event,
            targetItemId: resultItemId,
          });
      }
    }

    const idsByRef = new Map(stepResults.map((step) => [step.ref, step.itemId]));
    const results: ConfirmationResult[] = [];
    for (const written of stepResults) {
      const [item] = await itemsStore.getItemsByIds(client, [written.itemId]);
      const database = await databasesStore.getDatabase(client, written.databaseId);
      if (!item || !database) throw new Error("Confirmed result item or database disappeared");
      const step = envelope.operations?.find((operation) => operation.ref === written.ref);
      const requestedRelations = step
        ? effectiveStepRelations(step)
        : envelope.entityKind === "relation"
          ? {}
          : (envelope.relations ?? {});
      const targets: Array<string | undefined> = [];
      if (linkedTargetId !== null) targets.push(linkedTargetId);
      const requests: Array<{ definitionId: string; target: string }> = [];
      const resolved = new Map<string, Array<string | undefined>>();
      const definitions = new Map<string, string>();
      for (const [key, values] of Object.entries(requestedRelations)) {
        const ids = values.map((value) => (typeof value === "string" ? value : idsByRef.get(value.ref)));
        resolved.set(key, ids);
        if (reusedFileRefs.has(written.ref)) {
          const property = await propertiesStore.getPropertyByKey(client, written.databaseId, key);
          const definition = property && (await relationsStore.getRelationDefinitionByPropertyId(client, property.id));
          if (!definition) throw new Error(`Missing confirmed relation definition for ${key}`);
          definitions.set(key, definition.id);
          for (const target of ids) if (target !== undefined) requests.push({ definitionId: definition.id, target });
        }
      }
      const retained = new Map<string, Set<string>>();
      if (requests.length > 0) {
        const { rows } = await client.query<{ definition_id: string; target_id: string }>(
          `SELECT r.relation_definition_id AS definition_id,
                  CASE WHEN r.item_a = $3::uuid THEN r.item_b ELSE r.item_a END AS target_id
           FROM item_relations r
           JOIN unnest($1::uuid[], $2::uuid[]) AS wanted(definition_id, target_id)
             ON wanted.definition_id = r.relation_definition_id
            AND ((r.item_a = $3::uuid AND r.item_b = wanted.target_id)
              OR (r.item_b = $3::uuid AND r.item_a = wanted.target_id))
           ORDER BY r.relation_definition_id, r.id FOR SHARE OF r`,
          [requests.map((request) => request.definitionId), requests.map((request) => request.target), item.id],
        );
        for (const row of rows) {
          const ids = retained.get(row.definition_id) ?? new Set<string>();
          ids.add(row.target_id);
          retained.set(row.definition_id, ids);
        }
      }
      for (const [key, ids] of resolved) {
        if (!reusedFileRefs.has(written.ref)) {
          targets.push(...ids);
          continue;
        }
        const definitionId = definitions.get(key);
        if (!definitionId) throw new Error(`Missing confirmed relation definition for ${key}`);
        const existing = retained.get(definitionId);
        for (const id of ids) if (id !== undefined && existing?.has(id)) targets.push(id);
      }
      const linked = await itemsStore.getItemsByIds(
        client,
        targets.filter((id): id is string => id !== undefined),
      );
      const linkedById = new Map(linked.map((item) => [item.id, item]));
      const linkLabels: string[] = [];
      for (const targetId of targets) {
        const target = targetId === undefined ? undefined : linkedById.get(targetId);
        if (target) linkLabels.push(await resolveResultLabel(client, target.databaseId, target));
      }
      const dateValue =
        database.key === "events" ? item.properties.date : database.key === "journal" ? item.properties.period : null;
      const date =
        typeof dateValue === "string" && /^\d{4}-\d{2}-\d{2}(?:$|T)/.test(dateValue) ? dateValue.slice(0, 10) : null;
      results.push({
        ref: written.ref,
        itemId: item.id,
        databaseKey: database.key,
        label: await resolveResultLabel(client, database.id, item),
        role: step?.role ?? "primary",
        date,
        linkLabels,
        followUp: null,
        updatedAt: item.updatedAt,
        blockIds: written.ref === "primary" ? blockIds : [],
      });
    }
    results.sort((a, b) => Number(b.role === "primary") - Number(a.role === "primary"));

    const updated = await updateItemWithClient(
      client,
      {
        databaseId: config.processingProposalsDatabaseId,
        itemId: proposal.id,
        propertiesPatch: {
          status: "confirmed",
          resultItemId,
          resultLabel,
          results,
          history: appendHistoryEntry(proposal.properties.history, "Confirmed by user.", "user", {
            ...(addedRelations.length ? { addedRelations } : {}),
            writtenRelations: recorder.written,
            removedRelations: recorder.removed,
          }),
        },
      },
      {
        allowedSystemKeys: ["status", "resultItemId", "resultLabel", "results", "history"],
        writer: CONFIRMING_USER_WRITER,
        actingUserId,
      },
    );
    publishInboxCardChange(client, proposal.id, "closed");
    // Issue #106's "proposal transition" invalidation trigger: confirm/reject/revise change
    // the source Inbox item's displayed status but never touch the Inbox item itself, so
    // nothing else would invalidate its Journal day's cached list.
    await enqueueJournalInboxRecomputeForProposal(client, proposal.id);
    return updated;
  });
}

/**
 * `POST /api/proposals/:id/reject` (issue #105): locks the proposal as `rejected` without
 * ever writing a destination. Idempotent under retry (an already-`rejected` proposal is
 * returned as-is); rejecting a `confirmed` proposal is refused, since its destination write
 * already happened and rejecting now could not undo it. `ifVersion` (issue #1852) is checked as in
 * `confirmProposalWithClient`: after the lock, the `rejected` answer and the `confirmed` refusal, and
 * before anything is written.
 */
export async function rejectProposalWithClient(
  client: PoolClient,
  config: ProposalActionConfig,
  proposalId: string,
  message?: string,
  ifVersion?: string,
): Promise<ItemRow> {
  const proposal = await lockLiveProposal(client, config.processingProposalsDatabaseId, proposalId);
  const status = proposal.properties.status;
  if (status === "rejected") return proposal;
  if (status === "confirmed") {
    throw incompatibleStatusError("Cannot reject a proposal that has already been confirmed", status);
  }
  assertProposalVersion(proposal, ifVersion);

  const updated = await updateItemWithClient(
    client,
    {
      databaseId: config.processingProposalsDatabaseId,
      itemId: proposal.id,
      propertiesPatch: {
        status: "rejected",
        history: appendHistoryEntry(proposal.properties.history, message ?? "Rejected by user.", "user", {
          kind: "rejected",
        }),
      },
    },
    { allowedSystemKeys: ["status", "history"] },
  );
  publishInboxCardChange(client, proposal.id, "closed");
  await enqueueJournalInboxRecomputeForProposal(client, proposal.id);
  return updated;
}

/** The start of the history message of a card that `settleSpeakerCardWithClient` closed. Only the text of the entry: nothing reads it back. */
const MANUAL_SETTLEMENT_MESSAGE_PREFIX = "Settled by a manual assignment";

/** What `settleSpeakerCardWithClient` did with the card: closed it as `confirmed` or `rejected`, or left it `untouched`. */
export type SpeakerCardSettlement = "confirmed" | "rejected" | "untouched";

/** A manual speaker assignment: `speaker` of `transcriptId` was assigned to `personId` by the user. */
export interface SpeakerAssignment {
  transcriptId: string;
  speaker: string;
  personId: string;
}

/**
 * Settles the card that asks who a transcript's speaker is after the user assigned that speaker to a
 * person by hand (issue #1770). Runs in the caller's transaction. It row-locks the card, which
 * serializes it with a concurrent confirm, reject or revise of the same card, and settles it only while its status is
 * `proposed` or `needsClarification`. A card that is `confirmed`, `rejected` or `invalid`, one in the
 * Trash and one that no longer exists are left untouched and answered `untouched`.
 *
 * A card whose stored proposal is exactly this person for this speaker key becomes `confirmed`, with
 * the person as its result in the shape `confirmProposalWithClient` stores for a speaker card; any other
 * open card becomes `rejected`. Either way the card's history gains an entry saying that a manual
 * assignment settled it. No edge is written here: the caller has written the `speakers` edge, and
 * the Event participant edge a confirm adds is the caller's as well. Throws when the stored
 * proposal is malformed, as `confirmProposalWithClient` does.
 */
export async function settleSpeakerCardWithClient(
  client: PoolClient,
  config: ProposalActionConfig,
  proposalId: string,
  assignment: SpeakerAssignment,
  actingUserId?: string,
): Promise<SpeakerCardSettlement> {
  const proposal = await itemsStore.lockItemById(client, config.processingProposalsDatabaseId, proposalId);
  if (!proposal || proposal.deletedAt) return "untouched";
  const status = proposal.properties.status;
  if (status !== "proposed" && status !== "needsClarification") return "untouched";

  const envelope = parseStoredProposalEnvelope(proposal.properties.proposal, proposal.id);
  const proposesThisAssignment =
    envelope !== null &&
    !("unknownKind" in envelope) &&
    envelope.entityKind === "relation" &&
    envelope.target === assignment.personId &&
    envelope.properties.propertyKey === TRANSCRIPT_SPEAKERS_PROPERTY_KEY &&
    isDeepStrictEqual(envelope.properties.metadata, { speaker: assignment.speaker });
  if (!proposesThisAssignment) {
    await updateItemWithClient(
      client,
      {
        databaseId: config.processingProposalsDatabaseId,
        itemId: proposal.id,
        propertiesPatch: {
          status: "rejected",
          history: appendHistoryEntry(
            proposal.properties.history,
            `${MANUAL_SETTLEMENT_MESSAGE_PREFIX}: the speaker was assigned to another person.`,
            "user",
          ),
        },
      },
      { allowedSystemKeys: ["status", "history"], writer: CONFIRMING_USER_WRITER, actingUserId },
    );
    publishInboxCardChange(client, proposal.id, "closed");
    await enqueueJournalInboxRecomputeForProposal(client, proposal.id);
    return "rejected";
  }

  const [transcript] = await itemsStore.getItemsByIds(client, [assignment.transcriptId]);
  const [person] = await itemsStore.getItemsByIds(client, [assignment.personId]);
  if (!transcript) throw new Error("Source transcript disappeared while its speaker card was settled");
  const transcripts = await databasesStore.getDatabase(client, transcript.databaseId);
  if (!transcripts) throw new Error("Transcripts database disappeared while a speaker card was settled");
  const personLabel = person ? await resolveResultLabel(client, person.databaseId, person) : assignment.personId;
  const results: ConfirmationResult[] = [
    {
      ref: "primary",
      itemId: transcript.id,
      databaseKey: transcripts.key,
      label: await resolveResultLabel(client, transcript.databaseId, transcript),
      role: "primary",
      date: null,
      linkLabels: [personLabel],
      followUp: null,
      updatedAt: transcript.updatedAt,
      blockIds: [],
    },
  ];
  await updateItemWithClient(
    client,
    {
      databaseId: config.processingProposalsDatabaseId,
      itemId: proposal.id,
      propertiesPatch: {
        status: "confirmed",
        resultItemId: assignment.personId,
        resultLabel: personLabel,
        results,
        history: appendHistoryEntry(
          proposal.properties.history,
          `${MANUAL_SETTLEMENT_MESSAGE_PREFIX}: the speaker was assigned to the proposed person.`,
          "user",
        ),
      },
    },
    {
      allowedSystemKeys: ["status", "resultItemId", "resultLabel", "results", "history"],
      writer: CONFIRMING_USER_WRITER,
      actingUserId,
    },
  );
  publishInboxCardChange(client, proposal.id, "closed");
  await enqueueJournalInboxRecomputeForProposal(client, proposal.id);
  return "confirmed";
}

/** The history entry text of a revise that carries no `message`, by who revised. */
const DEFAULT_REVISE_MESSAGES = { user: "Revised by user.", ai: "Revised by assistant." } as const;

/**
 * Who a revise is recorded as in the card's history. A `user` revise is the route's. An `ai` revise is a revision by
 * the assistant in an Inbox item thread (issue #1906): its entry has kind `threadRevision` and names the thread and
 * the assistant message whose turn made the revision.
 */
export type ProposalRevisionAuthor = { author: "user" } | { author: "ai"; threadId: string; messageId: string };

/**
 * `history` followed by the entry of a revise by `revisedBy`; `message` is its text, the default of that author when
 * absent. `reviseProposalFromThreadWithClient` (issue #1938) writes its entry the same way.
 */
export function appendRevisionEntry(history: unknown, message: string | undefined, revisedBy: ProposalRevisionAuthor) {
  return appendHistoryEntry(
    history,
    message ?? DEFAULT_REVISE_MESSAGES[revisedBy.author],
    revisedBy.author,
    revisedBy.author === "ai"
      ? { kind: "threadRevision", threadId: revisedBy.threadId, messageId: revisedBy.messageId }
      : undefined,
  );
}

/**
 * What `reviseProposalWithClient` takes: either a complete replacement envelope (all of `entityKind`, `target` and
 * `properties`, with an optional `message` for the history), or a `message` alone, which only a transcript card
 * accepts. A partial envelope does not type-check. `ifVersion` is the card's `updatedAt` as the caller read it.
 */
export type ReviseProposalInput = { ifVersion?: string } & (
  | {
      message?: string;
      entityKind: ProposalEntityKind;
      target: string;
      properties: Record<string, unknown>;
      relations?: ProposalEnvelope["relations"];
    }
  | {
      message: string;
      entityKind?: never;
      target?: never;
      properties?: never;
      relations?: never;
    }
);

/**
 * `POST /api/proposals/:id/revise` (issue #105): a chat-driven correction. With an envelope it always replaces
 * the complete envelope — including `entityKind`, so a revise can switch a proposal from
 * `database` to `pageContent` or vice versa atomically, or a transcript card from creating a
 * new Event to linking an existing one and back (issue #184) — never a partial patch onto the
 * existing one, since a partial merge of `target`/`properties` across different
 * `entityKind`s would produce a nonsensical envelope. The new envelope is checked against the
 * card as confirm would check it (`assertValidEnvelopeForCard`), so an invalid link target is
 * refused here with its canonical error rather than only at confirm. Refused on a locked (`confirmed`/
 * `rejected`) proposal, per the epic's "a locked card is never recomputed again"; allowed
 * from `needsClarification`/`invalid` as well as `proposed`, since a user resolving one of
 * those into a valid envelope is exactly how a proposal is meant to leave that state. An `invalid`
 * card whose `invalidReason` is `sourceDeleted` is refused (issue #1482): it can only be discarded,
 * or reopened by the tick once its source is restored (issue #1604). A fixable `invalid` card is
 * revised like any other, and its `invalidReason` is cleared in the same write.
 *
 * Without an envelope (issue #1870) only a `kind = 'transcript'` card accepts the call: the `message` is appended
 * to its history as an entry of the revising author (`revisedBy`: the user, or the assistant of an item thread) and
 * nothing else on the card changes (`recordTranscriptCardInstruction`); acting on the instruction is not done here,
 * but in `semprec-transcribe`, to which the same transaction enqueues the `transcriptCardRecompute` job (issue
 * gh-1940). A card that is locked, whose source Inbox item was deleted or whose stored `entityKind` this release
 * does not support is refused as above and enqueues nothing. Any other card is refused with `validation_failed` on `message`.
 *
 * `input.ifVersion` is handed to the card's update, so a card whose `updatedAt` differs is answered
 * `version_conflict` and nothing is written. The envelope is validated before that update, so an invalid
 * envelope on a stale card is refused as invalid. `actingUserId` addresses the realtime invalidation of the write.
 * `revisedBy` says who the history entry of the revise names (`ProposalRevisionAuthor`): the user by default, as for
 * the route, or the assistant of an item thread (issue #1906), whose entry has author `ai`, kind `threadRevision`
 * and the ids of its thread and message. The `reset` entry that lists dropped manual values keeps the author `user`
 * in both cases, and nothing else about the revise differs.
 *
 * The user's manual values (`userOverrides`, `userEditedKeys`, issue #1892) only fit the destination they were
 * typed for (issue #1924, `retainOverridesForEnvelope`): when the new envelope's `entityKind` or `target` differs
 * from the assistant's previous one they are all cleared. Otherwise only the values of the envelope's own
 * destination stay (`primary`, or the primary step of a multi-step envelope) whose key is a property of the target;
 * the values of any other step are dropped, and a value equal to the new assistant value leaves the overrides
 * without an entry. When a value was dropped, a history entry of kind `reset` listing the dropped `ref.key`s follows
 * the revise entry. The new envelope is stored as the assistant's output (`aiProposal`), and `proposal` holds the
 * effective envelope: the new envelope with the values that stay laid over it, validated as confirm validates it,
 * so a kept value is what confirm writes. A revision made in an Inbox item thread has rules of its own
 * (`reviseProposalFromThreadWithClient`, issue #1938).
 */
export async function reviseProposalWithClient(
  client: PoolClient,
  config: ProposalActionConfig,
  proposalId: string,
  input: ReviseProposalInput,
  actingUserId?: string,
  revisedBy: ProposalRevisionAuthor = { author: "user" },
): Promise<ItemRow> {
  const proposal = await lockLiveProposal(client, config.processingProposalsDatabaseId, proposalId);
  const status = proposal.properties.status;
  if (typeof status === "string" && LOCKED_PROPOSAL_STATUSES.has(status)) {
    throw new ValidationError(`Cannot revise a locked proposal (status '${status}')`, { field: "status" });
  }
  if (isFinalInvalid(proposal.properties)) {
    throw new ValidationError("Cannot revise a proposal whose source Inbox item was deleted", { field: "status" });
  }

  const storedUnknownKind = unknownStoredEntityKind(proposal.properties.proposal);
  if (storedUnknownKind !== null) throw unsupportedEntityKindError(storedUnknownKind);

  if (input.entityKind === undefined) {
    if (proposal.properties.kind !== "transcript") {
      throw new ValidationError("A message without a proposal can only be sent on a transcript card", {
        field: "message",
      });
    }
    return recordTranscriptCardInstruction(client, config, proposal, input, revisedBy, actingUserId);
  }

  const envelope: ProposalEnvelope = {
    entityKind: input.entityKind,
    target: input.target,
    properties: input.properties,
    ...(input.relations === undefined ? {} : { relations: input.relations }),
  };
  await assertValidEnvelopeForCard(client, config, proposal, envelope);

  // The user's manual values only fit the destination they were typed for (issue #1924).
  const retained = await retainValuesForRevise(client, proposal, envelope);
  const effective = retained.effective;
  if (retained.userEditedKeys.length > 0) await assertValidEnvelopeForCard(client, config, proposal, effective);
  const history = appendDroppedValuesEntry(
    appendRevisionEntry(proposal.properties.history, input.message, revisedBy),
    retained,
  );

  // A fixable invalid card leaves `invalid` here, so its reason goes with it in this same write.
  const clearedReason = status === "invalid" ? { invalidReason: null } : {};
  const updated = await updateItemWithClient(
    client,
    {
      databaseId: config.processingProposalsDatabaseId,
      itemId: proposal.id,
      propertiesPatch: {
        proposal: effective,
        referencedItemIds: referencedItemIdsOf(effective),
        ...aiProposalPatch(proposal.properties, envelope),
        userOverrides: retained.userOverrides,
        userEditedKeys: retained.userEditedKeys,
        status: "proposed",
        ...clearedReason,
        history,
      },
      ifVersion: input.ifVersion,
    },
    {
      allowedSystemKeys: [
        "proposal",
        "aiProposal",
        "aiVersion",
        "referencedItemIds",
        "userOverrides",
        "userEditedKeys",
        "status",
        "invalidReason",
        "history",
      ],
      actingUserId,
    },
  );
  await enqueueJournalInboxRecomputeForProposal(client, proposal.id);
  return updated;
}
