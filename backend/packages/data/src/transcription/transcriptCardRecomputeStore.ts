import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";
import { z } from "zod";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import { formatOccurrenceId } from "../calendar/eventOccurrenceId.js";
import { getTenantUserLocale } from "../auth/usersStore.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { publishInboxCardChange } from "../inbox/inboxCardsRealtime.js";
import { isFinalInvalid } from "../inbox/inboxTickAction.js";
import { LOCKED_PROPOSAL_STATUSES } from "../inbox/inboxTypesStore.js";
import { enqueueJournalInboxRecomputeForProposal } from "../inbox/journalInboxCompute.js";
import {
  assertValidEnvelopeForCard,
  requireSourceTranscriptId,
  unsupportedEntityKindError,
  type ProposalActionConfig,
} from "../inbox/proposalActions.js";
import {
  aiProposalPatch,
  parseStoredProposalEnvelope,
  readAiProposal,
  type ProposalEnvelope,
} from "../inbox/proposalEnvelope.js";
import { appendHistoryEntry, proposalHistoryEntrySchema } from "../inbox/proposalHistory.js";
import {
  composeEffectiveEnvelope,
  fieldOverridesOf,
  parseUserOverrides,
  retainOverridesForThreadRevision,
} from "../inbox/proposalOverrides.js";
import { referencedItemIdsOf } from "../inbox/proposalReferences.js";
import { appendDroppedValuesEntry } from "../inbox/proposalRetention.js";
import { PROCESSING_PROPOSALS_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { TRANSCRIPTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { getSystemTimezone } from "../systemSettings.js";
import { parseStoredMeetingNotes, renderMeetingNotes } from "./meetingNotesRendering.js";
import { resolveTranscriptDisplayName } from "./transcriptDisplayName.js";
import { transcriptEventCardContextSchema } from "./transcriptEventCardContext.js";
import { transcriptSpeakerCardContextSchema } from "./transcriptSpeakerCardContext.js";
import { TRANSCRIPT_MEETING_NOTES_COMPUTED_KEY } from "./transcriptionComputedKeys.js";
import { TRANSCRIPT_EVENT_PROPERTY_KEY } from "./transcriptEventMatch.js";
import { listTranscriptSpeakers, TRANSCRIPT_SPEAKERS_PROPERTY_KEY } from "./transcriptionSpeakerEdges.js";
import type { ItemRow } from "../types.js";
import type { TranscriptCardRecomputePayload } from "./transcriptCardRecompute.js";

/**
 * Guarded read and write of a transcript card's recompute from a user instruction. The job reads a
 * snapshot here, asks the gateway outside any transaction, and applies the answer here in one
 * transaction that row-locks the card. `proposalActions.ts` must not import this module.
 */

/** History entry texts are English literals, as the other proposal writers write theirs. */
const APPLIED_FALLBACK_MESSAGE = "Revised by assistant.";
const UNCHANGED_MESSAGE = "The instruction changed nothing.";
const DISCARDED_MESSAGE = "The instruction could not be applied: the answer did not fit this card.";
const FAILED_MESSAGE = "The instruction could not be applied: the recomputation failed.";

/** A row written before `aiVersion` existed counts as 0. */
function readAiVersion(properties: Record<string, unknown>): number {
  return typeof properties.aiVersion === "number" ? properties.aiVersion : 0;
}

const historySchema = z.array(proposalHistoryEntrySchema);

/** A malformed stored value counts as empty. */
function readHistory(properties: Record<string, unknown>) {
  const parsed = historySchema.safeParse(properties.history);
  return parsed.success ? parsed.data : [];
}

function instructionIsAnswered(properties: Record<string, unknown>, instructionEntryId: string): boolean {
  return readHistory(properties).some(
    (entry) => entry.kind === "threadRevision" && entry.instructionEntryId === instructionEntryId,
  );
}

const cardContextSchema = z.discriminatedUnion("role", [
  transcriptEventCardContextSchema,
  transcriptSpeakerCardContextSchema,
]);

/** `current` marks the target the card proposes now. */
export interface TranscriptCardChoice {
  id: string;
  name: string | null;
  /** Plain labels (`date`, `times`, `project`, `title`, ...); only present values. */
  details: Record<string, string>;
  current: boolean;
}

export interface TranscriptCardRecomputeSnapshot {
  proposalId: string;
  instructionEntryId: string;
  instruction: string;
  /** The write refuses a card that moved since. */
  aiVersion: number;
  role: "event" | "speaker";
  current: ProposalEnvelope | null;
  /** Of a `relation` envelope linking an item for this card: its role's relation, and for a speaker card the speaker key. */
  relationProperties: Record<string, unknown>;
  /** User-edited keys on the destination; the instruction may change them only by naming them. */
  editedFields: string[];
  choices: TranscriptCardChoice[];
  transcript: {
    displayName: string | null;
    notes: { title: string; summary: string; shortSummary: string } | null;
  };
  locale: string;
}

async function requireDatabaseId(client: PoolClient, moduleId: string): Promise<string> {
  const database = await databasesStore.getDatabaseByModuleId(client, moduleId);
  if (!database) throw new NotFoundError(`Database for module '${moduleId}' not found`);
  return database.id;
}

function candidateTargetIds(context: z.infer<typeof cardContextSchema>): string[] {
  if (context.role === "speaker") return context.alternatives.map((alternative) => alternative.personId);
  return context.candidates.map((candidate) =>
    "id" in candidate ? candidate.id : formatOccurrenceId(candidate.seriesId, candidate.occurrenceDate),
  );
}

function currentRelationTarget(current: ProposalEnvelope | null): string | null {
  return current?.entityKind === "relation" ? current.target : null;
}

/** A `relation` to a candidate or the current target, or the current new-item proposal edited in place. */
function assertChoiceFitsCard(
  context: z.infer<typeof cardContextSchema>,
  current: ProposalEnvelope | null,
  choice: { entityKind: "relation" | "database"; target: string },
): void {
  if (choice.entityKind === "relation") {
    const allowed = new Set(candidateTargetIds(context));
    const currentTarget = currentRelationTarget(current);
    if (currentTarget !== null) allowed.add(currentTarget);
    if (allowed.has(choice.target)) return;
    throw new ValidationError("The answer names a target that is not one of the card's candidates", {
      field: "target",
    });
  }
  if (current?.entityKind === "database" && current.target === choice.target) return;
  throw new ValidationError("The answer replaces the new item the card proposes with another one", {
    field: "target",
  });
}

const itemNameSchema = z.object({ name: z.string().nullish() });

function nameOf(item: { deletedAt: string | null; properties: Record<string, unknown> } | undefined): string | null {
  if (!item || item.deletedAt) return null;
  return itemNameSchema.safeParse(item.properties).data?.name ?? null;
}

async function readChoices(
  client: PoolClient,
  context: z.infer<typeof cardContextSchema>,
  current: ProposalEnvelope | null,
): Promise<TranscriptCardChoice[]> {
  const currentTarget = currentRelationTarget(current);
  const choices: TranscriptCardChoice[] = [];
  if (context.role === "speaker") {
    for (const alternative of context.alternatives) {
      choices.push({
        id: alternative.personId,
        name: alternative.name,
        details: alternative.title === null ? {} : { title: alternative.title },
        current: alternative.personId === currentTarget,
      });
    }
  } else {
    const seriesIds = context.candidates.flatMap((candidate) => ("seriesId" in candidate ? [candidate.seriesId] : []));
    const series = new Map((await itemsStore.getItemsByIds(client, seriesIds)).map((item) => [item.id, item]));
    for (const candidate of context.candidates) {
      if ("seriesId" in candidate) {
        const id = formatOccurrenceId(candidate.seriesId, candidate.occurrenceDate);
        choices.push({
          id,
          name: nameOf(series.get(candidate.seriesId)),
          details: { date: candidate.occurrenceDate, kind: "an occurrence of a recurring Event that has no item yet" },
          current: id === currentTarget,
        });
        continue;
      }
      const times = candidate.timeTo === null ? candidate.timeFrom : `${candidate.timeFrom}-${candidate.timeTo}`;
      choices.push({
        id: candidate.id,
        name: candidate.name,
        details: {
          date: candidate.endDate === null ? candidate.date : `${candidate.date} to ${candidate.endDate}`,
          times,
          ...(candidate.projectName === null ? {} : { project: candidate.projectName }),
        },
        current: candidate.id === currentTarget,
      });
    }
  }
  if (currentTarget !== null && !choices.some((choice) => choice.id === currentTarget)) {
    const [item] = await itemsStore.getItemsByIds(client, [currentTarget]);
    choices.push({ id: currentTarget, name: nameOf(item), details: {}, current: true });
  }
  return choices;
}

async function readLinkedEventName(client: PoolClient, transcriptsDatabaseId: string, transcriptId: string) {
  const property = await propertiesStore.getPropertyByKey(client, transcriptsDatabaseId, "event");
  const definition = property && (await relationsStore.getRelationDefinitionByPropertyId(client, property.id));
  if (!definition) return null;
  const [edge] = await relationsStore.listRelationsForItem(client, definition.id, transcriptId);
  if (!edge) return null;
  const [event] = await itemsStore.getItemsByIds(client, [relationsStore.otherSide(edge, transcriptId)]);
  return nameOf(event);
}

/** Only plain property keys of the destination (`primary.<key>`). */
function editedFieldsOf(properties: Record<string, unknown>): string[] {
  const keys = z.array(z.string()).safeParse(properties.userEditedKeys);
  if (!keys.success) return [];
  return keys.data.flatMap((key) => {
    const match = /^primary\.([^.]+)$/.exec(key);
    return match?.[1] === undefined ? [] : [match[1]];
  });
}

/**
 * The task runs it at repeatable read, without locks. `null` when there is nothing to do: the card is
 * gone, trashed, not a `transcript` card, settled, invalid because its source was deleted, or already
 * answers this instruction (so a retried job makes no second call). Throws `NotFoundError` for an
 * instruction entry the card does not hold.
 */
export async function readTranscriptCardRecomputeSnapshot(
  client: PoolClient,
  input: TranscriptCardRecomputePayload,
): Promise<TranscriptCardRecomputeSnapshot | null> {
  const proposalsDatabaseId = await requireDatabaseId(client, PROCESSING_PROPOSALS_MODULE_ID);
  const card = await itemsStore.getItemById(client, proposalsDatabaseId, input.proposalId);
  if (!card || card.deletedAt || card.properties.kind !== "transcript") return null;
  const status = card.properties.status;
  if ((typeof status === "string" && LOCKED_PROPOSAL_STATUSES.has(status)) || isFinalInvalid(card.properties))
    return null;
  if (instructionIsAnswered(card.properties, input.instructionEntryId)) return null;

  const entry = readHistory(card.properties).find((candidate) => candidate.id === input.instructionEntryId);
  if (!entry) throw new NotFoundError(`Processing proposal ${card.id} has no instruction entry for this job`);
  const context = cardContextSchema.parse(card.properties.context);
  const current = parseStoredProposalEnvelope(card.properties.proposal, card.id);
  if (current && "unknownKind" in current) throw unsupportedEntityKindError(current.entityKind);

  const transcriptId = await requireSourceTranscriptId(
    client,
    { processingProposalsDatabaseId: proposalsDatabaseId },
    card,
  );
  const transcriptsDatabaseId = await requireDatabaseId(client, TRANSCRIPTS_MODULE_ID);
  const transcript = await itemsStore.getItemById(client, transcriptsDatabaseId, transcriptId);
  if (!transcript || transcript.deletedAt) throw new NotFoundError(`Transcripts item '${transcriptId}' not found`);
  const locale = (await getTenantUserLocale(client)) ?? "cs";
  const notes = parseStoredMeetingNotes(transcript.computed[TRANSCRIPT_MEETING_NOTES_COMPUTED_KEY]);
  const rendered = notes
    ? await renderMeetingNotes(notes, await listTranscriptSpeakers(client, transcriptId, transcript), locale)
    : null;
  const date = transcript.properties.date;
  return {
    proposalId: card.id,
    instructionEntryId: input.instructionEntryId,
    instruction: entry.message,
    aiVersion: readAiVersion(card.properties),
    role: context.role,
    current,
    relationProperties:
      context.role === "speaker"
        ? { propertyKey: TRANSCRIPT_SPEAKERS_PROPERTY_KEY, metadata: { speaker: context.speaker } }
        : { propertyKey: TRANSCRIPT_EVENT_PROPERTY_KEY },
    editedFields: editedFieldsOf(card.properties),
    choices: await readChoices(client, context, current),
    transcript: {
      displayName: await resolveTranscriptDisplayName(
        {
          name: typeof transcript.properties.name === "string" ? transcript.properties.name : null,
          eventName: await readLinkedEventName(client, transcriptsDatabaseId, transcriptId),
          date: typeof date === "string" ? date : null,
        },
        await getSystemTimezone(client),
        locale,
      ),
      notes: rendered && {
        title: rendered.title,
        summary: rendered.summary,
        shortSummary: rendered.shortSummary,
      },
    },
    locale,
  };
}

/**
 * `entityKind` and `target` are `null` when the instruction cannot be satisfied with the card's
 * candidates. `explicitlyChangedKeys` are the user-edited fields the instruction names.
 */
export interface TranscriptCardAnswer {
  entityKind: "relation" | "database" | null;
  target: string | null;
  properties: Record<string, unknown>;
  explicitlyChangedKeys: string[];
  reason: string;
}

const REASON_MAX_CODE_POINTS = 300;

/** One trimmed line, cut by code point; `null` when blank. */
function boundedReason(reason: string): string | null {
  const text = Array.from(reason.replace(/\s+/g, " ").trim());
  return text.length === 0 ? null : text.slice(0, REASON_MAX_CODE_POINTS).join("");
}

/**
 * The card's `aiVersion` moved since the snapshot: another writer changed the assistant's proposal
 * while the model was asked. The job fails and retries against the card as it is.
 */
export class TranscriptCardChangedError extends Error {
  readonly code = "transcript_card_changed" as const;

  constructor(proposalId: string) {
    super(`Processing proposal ${proposalId} changed while its recompute was asked for`);
    this.name = "TranscriptCardChangedError";
  }
}

/** `skipped`: nothing written (locked, gone or already answered); the others each wrote one history entry. */
export type TranscriptCardRecomputeOutcome = "applied" | "unchanged" | "discarded" | "skipped";

interface LockedCard {
  config: ProposalActionConfig;
  card: ItemRow;
}

/** Re-checks under the row lock everything the snapshot decided on; `null` when any of it no longer holds. */
async function lockOpenTranscriptCard(
  client: PoolClient,
  input: TranscriptCardRecomputePayload,
): Promise<LockedCard | null> {
  const config = { processingProposalsDatabaseId: await requireDatabaseId(client, PROCESSING_PROPOSALS_MODULE_ID) };
  const card = await itemsStore.lockItemById(client, config.processingProposalsDatabaseId, input.proposalId);
  if (!card || card.deletedAt || card.properties.kind !== "transcript") return null;
  const status = card.properties.status;
  if ((typeof status === "string" && LOCKED_PROPOSAL_STATUSES.has(status)) || isFinalInvalid(card.properties))
    return null;
  if (instructionIsAnswered(card.properties, input.instructionEntryId)) return null;
  return { config, card };
}

async function writeAnswerEntry(
  client: PoolClient,
  { config, card }: LockedCard,
  instructionEntryId: string,
  message: string,
): Promise<void> {
  await updateItemWithClient(
    client,
    {
      databaseId: config.processingProposalsDatabaseId,
      itemId: card.id,
      propertiesPatch: {
        history: appendHistoryEntry(card.properties.history, message, "ai", {
          kind: "threadRevision",
          instructionEntryId,
        }),
      },
    },
    { allowedSystemKeys: ["history"] },
  );
  publishInboxCardChange(client, card.id, "updated");
}

/**
 * In the caller's transaction under the card's row lock. A locked or already answered card is
 * `skipped`; an `aiVersion` other than `expectedAiVersion` throws `TranscriptCardChangedError` before
 * any write.
 *
 * A `null` answer, one naming no target, or one failing the card's checks (the role rules refuse a
 * switch between an Event card and a speaker card) leaves the proposal and adds a `discarded` or
 * `unchanged` entry; an answer equal to the stored proposal is `unchanged` too.
 *
 * Otherwise the answer becomes `aiProposal` (`aiVersion` + 1) and `proposal` lays the manual values
 * over it as an Inbox thread revision does: a user-edited field keeps its value unless named in
 * `explicitlyChangedKeys`. A target change drops every manual value (listed in a `reset` entry). The
 * card's role, its own relation edges and the target databases are never touched.
 */
export async function applyTranscriptCardRecompute(
  client: PoolClient,
  input: TranscriptCardRecomputePayload & { expectedAiVersion: number; answer: TranscriptCardAnswer | null },
): Promise<TranscriptCardRecomputeOutcome> {
  const locked = await lockOpenTranscriptCard(client, input);
  if (!locked) return "skipped";
  const { config, card } = locked;
  if (readAiVersion(card.properties) !== input.expectedAiVersion) throw new TranscriptCardChangedError(card.id);
  const { answer } = input;
  if (answer === null) {
    await writeAnswerEntry(client, locked, input.instructionEntryId, DISCARDED_MESSAGE);
    return "discarded";
  }
  const reason = boundedReason(answer.reason);
  const unchangedMessage = reason === null ? UNCHANGED_MESSAGE : `${UNCHANGED_MESSAGE} ${reason}`;
  if (answer.entityKind === null || answer.target === null) {
    await writeAnswerEntry(client, locked, input.instructionEntryId, unchangedMessage);
    return "unchanged";
  }

  const context = cardContextSchema.parse(card.properties.context);
  const current = parseStoredProposalEnvelope(card.properties.proposal, card.id);
  if (current && "unknownKind" in current) throw unsupportedEntityKindError(current.entityKind);
  const previous = readAiProposal(card.properties, card.id);
  if (previous && "unknownKind" in previous) throw unsupportedEntityKindError(previous.entityKind);
  const overrides = parseUserOverrides(card.properties.userOverrides, card.id);

  // A manual key the answer does not name is left out of the revised properties, which
  // `retainOverridesForThreadRevision` reads as "not touched". The model cannot edit relations.
  const named = new Set(answer.explicitlyChangedKeys.map((key) => key.replace(/^primary\./, "")));
  const manualKeys = new Set(Object.keys(fieldOverridesOf(overrides, "primary")));
  const revised: ProposalEnvelope = {
    entityKind: answer.entityKind,
    target: answer.target,
    properties: Object.fromEntries(
      Object.entries(answer.properties).filter(([key]) => named.has(key) || !manualKeys.has(key)),
    ),
    ...(previous?.relations !== undefined &&
    previous.entityKind === answer.entityKind &&
    previous.target === answer.target
      ? { relations: previous.relations }
      : {}),
  };
  let composed: ReturnType<typeof retainOverridesForThreadRevision>;
  let effective: ProposalEnvelope;
  try {
    assertChoiceFitsCard(context, current, { entityKind: answer.entityKind, target: answer.target });
    composed = retainOverridesForThreadRevision(previous, revised, overrides);
    effective = composeEffectiveEnvelope(composed.aiProposal, composed.userOverrides);
    await assertValidEnvelopeForCard(client, config, card, effective);
  } catch (error) {
    // Only a refusal of the answer is a verdict on it; any other failure is the job's and retries it.
    if (!(error instanceof ValidationError)) throw error;
    await writeAnswerEntry(client, locked, input.instructionEntryId, DISCARDED_MESSAGE);
    return "discarded";
  }
  if (card.properties.status === "proposed" && isDeepStrictEqual(effective, current)) {
    await writeAnswerEntry(client, locked, input.instructionEntryId, unchangedMessage);
    return "unchanged";
  }

  await updateItemWithClient(
    client,
    {
      databaseId: config.processingProposalsDatabaseId,
      itemId: card.id,
      propertiesPatch: {
        proposal: effective,
        ...aiProposalPatch(card.properties, composed.aiProposal),
        referencedItemIds: referencedItemIdsOf(effective),
        userOverrides: composed.userOverrides,
        userEditedKeys: composed.userEditedKeys,
        status: "proposed",
        // A fixable invalid card leaves `invalid` here, so its reason goes with it in this same write.
        ...(card.properties.status === "invalid" ? { invalidReason: null } : {}),
        history: appendDroppedValuesEntry(
          appendHistoryEntry(card.properties.history, reason ?? APPLIED_FALLBACK_MESSAGE, "ai", {
            kind: "threadRevision",
            instructionEntryId: input.instructionEntryId,
          }),
          composed,
        ),
      },
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
    },
  );
  publishInboxCardChange(client, card.id, "updated");
  await enqueueJournalInboxRecomputeForProposal(client, card.id);
  return "applied";
}

/**
 * For a run that cannot succeed (attempts used up, or refused for good by the gateway): adds one
 * "could not be applied" entry under the row lock and skips a locked, gone or answered card.
 */
export async function recordTranscriptCardRecomputeFailure(
  client: PoolClient,
  input: TranscriptCardRecomputePayload,
): Promise<TranscriptCardRecomputeOutcome> {
  const locked = await lockOpenTranscriptCard(client, input);
  if (!locked) return "skipped";
  await writeAnswerEntry(client, locked, input.instructionEntryId, FAILED_MESSAGE);
  return "discarded";
}
