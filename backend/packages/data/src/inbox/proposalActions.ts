import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { PoolClient } from "pg";
import { deriveEventTimeProperties, eventDateIsInstant } from "../calendar/eventTime.js";
import { readProposalTimezone } from "./proposalComputedUpdates.js";
import { assertEventCreateRules } from "../calendar/eventValidationHook.js";
import { parseOccurrenceId } from "../calendar/eventOccurrenceId.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import { assertRelationCreatableWithClient } from "../chokePoint/relationOps.js";
import { carryPageSections } from "./proposalPageSections.js";
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
import { requireRelationPropertyId } from "./proposalItemOrigin.js";
import { MAIL_THREAD_CARD_KIND, assertValidMailThreadCard } from "./mailThreadCard.js";
import { assertRecordingEnvelopeFitsCard } from "./recordingCardValidation.js";
import { relationEnvelopeMetadata } from "./proposalEnvelopeRelations.js";
import { carryNewOptions } from "./proposalNewOptions.js";
import type { RecordingCardProperties } from "./recordingCardEnvelope.js";
export {
  updateProposalValuesWithClient,
  type UpdateProposalValuesInput,
  type UpdateProposalValuesResult,
} from "./proposalValueUpdates.js";
export { reviseProposalFromThreadWithClient, type ReviseProposalFromThreadInput } from "./proposalThreadRevision.js";
export { resetProposalOverridesWithClient, type ResetProposalOverridesInput } from "./proposalReset.js";
export { reopenProposalWithClient, type ReopenProposalInput, type ReopenProposalResult } from "./proposalReopen.js";
export { recomputeProposalWithClient, type RecomputeProposalInput } from "./proposalRecompute.js";
export { confirmProposalWithClient } from "./proposalConfirm.js";
import { recordTranscriptCardInstruction } from "./transcriptCardInstruction.js";
export type { ProposalWarning } from "./editorSchema.js";
import { appendDroppedValuesEntry, retainValuesForRevise } from "./proposalRetention.js";
import { enqueueJournalInboxRecomputeForProposal } from "./journalInboxCompute.js";
import { referencedItemIdsOf } from "./proposalReferences.js";
import { publishInboxCardChange } from "./inboxCardsRealtime.js";
import { EVENTS_MODULE_ID, PEOPLE_MODULE_ID, TRANSCRIPTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { releaseTrashedEventEdges } from "../transcription/transcriptEventEdges.js";
import { transcriptSpeakerCardContextSchema } from "../transcription/transcriptSpeakerCardContext.js";
import { TRANSCRIPT_SPEAKERS_PROPERTY_KEY } from "../transcription/transcriptionSpeakerEdges.js";
import type { CredentialType } from "../credentials/externalCredentialsStore.js";
import { ConflictError, NotFoundError, ValidationError } from "../errors.js";
import type { DatabaseRow, ItemRow } from "../types.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";

/** Confirming is a person's decision, so every write in its transaction is a `user` write. */
export const CONFIRMING_USER_WRITER: WriterIdentity = { writerKind: "user" };

export interface ProposalActionConfig {
  processingProposalsDatabaseId: string;
}

/**
 * A human-supplied secret for an MCP server proposal: never part of the envelope, accepted only by confirm (never by
 * an AI-visible revise). Optional, since not every server needs one.
 */
export interface ConfirmProposalCredentialInput {
  credentialType: CredentialType;
  plaintext: string;
}

/** Row-locks the proposal (serializing confirm/reject/revise on the same row) and rejects a missing or deleted one. */
export async function lockLiveProposal(client: PoolClient, databaseId: string, proposalId: string): Promise<ItemRow> {
  const proposal = await itemsStore.lockItemById(client, databaseId, proposalId);
  if (!proposal || proposal.deletedAt) throw new NotFoundError(`Processing proposal ${proposalId} not found`);
  return proposal;
}

/** The target item's title, falling back to its id when there is no title property or value. */
export async function resolveResultLabel(client: PoolClient, databaseId: string, item: ItemRow): Promise<string> {
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
  version: z.string(),
  blockIds: z.array(z.string()),
});
export type ConfirmationResult = z.infer<typeof confirmationResultSchema>;

export function readConfirmationResults(properties: Record<string, unknown>): ConfirmationResult[] {
  return z.array(confirmationResultSchema).parse(properties.results ?? []);
}

export const TRANSCRIPT_EVENT_PROPERTY_KEY = "event";

/**
 * A transcript card proposes the transcript's Event (create, or link via Transcripts `event`) or one speaker-to-person
 * mapping (via `speakers`, metadata naming the speaker key). A card keeps its role for life.
 */
type TranscriptCardRole = "event" | "speaker";

interface TranscriptCardEdge {
  role: TranscriptCardRole;
  transcriptId: string;
  relationPropertyId: string;
  speaker?: string;
}

/** What `assertValidEnvelopeForCard` resolved; confirm's credential guard reuses `targetDatabase` instead of re-reading it. */
export interface EnvelopeForCard {
  transcriptCardEdge: TranscriptCardEdge | null;
  targetDatabase: DatabaseRow | null;
  /** A `mailThread` card's `sourceThread` Threads item. */
  mailThreadItemId?: string;
  /** A `transcription` card's source Inbox item and validated parameters. */
  recording?: { sourceInboxItemId: string; properties: RecordingCardProperties };
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

export async function requireDatabaseIdByModuleId(client: PoolClient, moduleId: string): Promise<string> {
  const database = await databasesStore.getDatabaseByModuleId(client, moduleId);
  if (!database) throw new NotFoundError(`Database for module '${moduleId}' not found`);
  return database.id;
}

/**
 * Before a pairing card writes its transcript's Event edge, deletes that transcript's edge to a trashed Event, as the
 * confirming user. The relation allows one Event, so the new edge would otherwise be a `cardinality_violation`.
 */
export async function releaseTrashedEventOfPairingCard(
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

/** The transcript of a transcript card, via its `sourceTranscript` edge. */
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
 * Validates an envelope against its card, on top of `assertValidProposalEnvelope`. A `'relation'` envelope needs a
 * source item, which only transcript cards have. A transcript card may create or link an Event, map a speaker to a
 * person or create a person, but never switch role (`transcriptCardRole`). Links are checked against relation
 * integrity, ownership and metadata rules with the write's own errors; a create-Event envelope must pass
 * `assertEventCreateRules`. `journalEntry` is valid only on inbox cards. A `mailThread` card must carry a Tasks
 * `database` envelope (`assertValidMailThreadCard`, checked first) and a `sourceThread` edge.
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
  if (envelope.entityKind === "transcription") {
    const { sourceInboxItemId, properties } = await assertRecordingEnvelopeFitsCard(client, config, proposal, envelope);
    return { transcriptCardEdge: null, targetDatabase, recording: { sourceInboxItemId, properties } };
  }
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
      // The Event the confirm creates must pass the Events rules, so a start and end confirm would refuse are refused
      // now. The Events time transform runs first, as on the write.
      if (role === "event") {
        // An invalid stored zone is a settings failure and propagates, not a 400 on the user's date.
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
      // An occurrence with no item yet cannot be checked as a target; its series Event stands in, since the created
      // item copies it with its edges.
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
    case "journalEntry":
      throw new ValidationError("A transcript proposal cannot hold a journal entry", { field: "entityKind" });
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
 * `POST /api/proposals/:id/reject`: marks the card `rejected` without writing a destination. An already `rejected`
 * card is returned as is; a `confirmed` one is refused, since its write cannot be undone by rejecting. `ifVersion` is
 * checked as in `confirmProposalWithClient`.
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

/** Only the text of the entry: nothing reads it back. */
const MANUAL_SETTLEMENT_MESSAGE_PREFIX = "Settled by a manual assignment";

export type SpeakerCardSettlement = "confirmed" | "rejected" | "untouched";

export interface SpeakerAssignment {
  transcriptId: string;
  speaker: string;
  personId: string;
}

/**
 * Settles a speaker card after a manual speaker assignment, under its row lock. Only `proposed`/`needsClarification`
 * cards change: an exact match becomes `confirmed`, anything else `rejected`. The caller writes the edges.
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
      version: transcript.version,
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

const DEFAULT_REVISE_MESSAGES = { user: "Revised by user.", ai: "Revised by assistant." } as const;

/** A `user` revise is the route's; an `ai` revise comes from an Inbox item thread and names its thread and message. */
export type ProposalRevisionAuthor = { author: "user" } | { author: "ai"; threadId: string; messageId: string };

/** `history` plus a revise entry by `revisedBy`; `message` defaults per author. */
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
 * A complete replacement envelope (with an optional history `message`), or a `message` alone, which only a transcript
 * card accepts. A partial envelope does not type-check.
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
 * `POST /api/proposals/:id/revise`: replaces the complete envelope (including `entityKind`), never a partial patch,
 * since merging across kinds would be nonsensical; checked as confirm checks it. Refused on locked cards and on
 * `sourceDeleted` cards; a fixable `invalid` card's reason is cleared in the same write. Without an envelope only a
 * transcript card accepts the call (`recordTranscriptCardInstruction`). A stale `ifVersion` is `version_conflict`,
 * checked after validation. Manual values follow `retainOverridesForEnvelope` (dropped ones get a `reset` entry,
 * always authored `user`); the new envelope becomes `aiProposal` and `proposal` the effective one.
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

  // The caller supplies properties and relations only, so page sections and still-named new options are carried over.
  const previousEnvelope = proposal.properties.aiProposal ?? proposal.properties.proposal;
  const envelope = carryNewOptions(
    previousEnvelope,
    carryPageSections(previousEnvelope, {
      entityKind: input.entityKind,
      target: input.target,
      properties: input.properties,
      ...(input.relations === undefined ? {} : { relations: input.relations }),
    }),
  );
  await assertValidEnvelopeForCard(client, config, proposal, envelope);

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
