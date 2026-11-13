import type { PoolClient } from "pg";
import { z } from "zod";
import { loadModuleCatalogs, resolveCatalogLabel, type ModuleCatalogs } from "@semprec/module-registry";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getItemById, getItemsByIds } from "../chokePoint/itemsStore.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { getRelationDefinitionByPropertyId, listRelationsForItem, otherSide } from "../chokePoint/relationsStore.js";
import { getValueLinksForItems, type ValueLinkEntry, type ValueLinkSource } from "../chokePoint/valueLinkReads.js";
import { getBlob } from "../blobs/blobsStore.js";
import { NotFoundError } from "../errors.js";
import { parseStoredProposalEnvelope } from "../inbox/proposalEnvelope.js";
import { getItemAutomation } from "../library/itemAutomationStore.js";
import { toManifestLocale } from "../manifest/catalogResolution.js";
import { PROCESSING_PROPOSALS_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { EVENTS_MODULE_ID, FILES_MODULE_ID, TRANSCRIPTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { readBlobId } from "./transcriptionActions.js";
import { readTranscriptionSourceFileItemId } from "./transcriptionJob.js";
import { transcriptSpeakerCardContextSchema } from "./transcriptSpeakerCardContext.js";
import { listTranscriptSpeakers, type TranscriptSpeaker } from "./transcriptionSpeakerEdges.js";
import { parseStoredMeetingNotes, renderMeetingNotes } from "./meetingNotesRendering.js";
import { listTranscriptActionItems } from "./transcriptActionItems.js";
import { resolveTranscriptDisplayName, resolveTranscriptSuggestedName } from "./transcriptDisplayName.js";
import { getSystemTimezone } from "../systemSettings.js";
import { TRANSCRIPT_MEETING_NOTES_COMPUTED_KEY } from "./transcriptionComputedKeys.js";

const segmentsSchema = z.array(
  z.object({ speaker: z.string(), text: z.string(), startsAt: z.number(), endsAt: z.number() }),
);
let catalogsPromise: Promise<ModuleCatalogs> | undefined;
export async function labelTranscriptSpeakers(speakers: TranscriptSpeaker[], locale: string) {
  catalogsPromise ??= loadModuleCatalogs(import.meta.url).catch((error: unknown) => {
    catalogsPromise = undefined;
    throw error;
  });
  const catalogs = await catalogsPromise;
  const template = resolveCatalogLabel(
    null,
    catalogs[toManifestLocale(locale)],
    catalogs.en,
    "transcript.speaker.unmappedLabel",
  );
  return speakers.map((entry) => ({
    ...entry,
    label: entry.person?.name ?? template.replace("{ordinal}", String(entry.ordinal)),
    personId: entry.person?.id ?? null,
  }));
}

/**
 * The link state of one context value: the `valueKind` and `sources` of the property's value link as
 * `getValueLinksForItems` returns them, or `own` with no source for a property without a link.
 */
interface TranscriptContextLinkState {
  valueKind: "own" | ValueLinkEntry["valueKind"];
  sources: ValueLinkSource[];
}

/** A live item a transcript's context relation points to, with its name and the property's link state. */
interface TranscriptContextValue extends TranscriptContextLinkState {
  id: string;
  name: string | null;
}

const contextItemSchema = z.object({ name: z.string().nullish() });

/**
 * The transcript's project, company and people (issue #1697): the live items its `project`,
 * `company` and `people` relations point to, each with the link state of its property. `project` and
 * `company` are `null` without a live item; `people` is ordered by name, then by id. A relation the
 * tenant's Transcripts database does not have reads as no value.
 */
async function readTranscriptContext(client: PoolClient, transcriptsDatabaseId: string, transcriptId: string) {
  const links = (await getValueLinksForItems(client, [transcriptId])).get(transcriptId) ?? {};
  const readValues = async (propertyKey: "project" | "company" | "people"): Promise<TranscriptContextValue[]> => {
    const property = await getPropertyByKey(client, transcriptsDatabaseId, propertyKey);
    const definition = property && (await getRelationDefinitionByPropertyId(client, property.id));
    const edges = definition ? await listRelationsForItem(client, definition.id, transcriptId) : [];
    const items = await getItemsByIds(
      client,
      edges.map((edge) => otherSide(edge, transcriptId)),
    );
    const entry = links[propertyKey];
    const state: TranscriptContextLinkState = entry
      ? { valueKind: entry.valueKind, sources: entry.sources }
      : { valueKind: "own", sources: [] };
    // U+0000 cannot occur in a stored name, so it separates the name from the id in the sort key.
    const order = (value: TranscriptContextValue): string => `${value.name ?? ""}\u0000${value.id}`;
    return items
      .map((item) => ({ id: item.id, name: contextItemSchema.parse(item.properties).name ?? null, ...state }))
      .sort((a, b) => (order(a) < order(b) ? -1 : 1));
  };
  const [project] = await readValues("project");
  const [company] = await readValues("company");
  const people = await readValues("people");
  return {
    project: project ?? null,
    company: company ?? null,
    people: people.map(({ id, ...person }) => ({ personId: id, ...person })),
  };
}

export async function readTranscriptDetail(client: PoolClient, transcriptId: string, locale: string) {
  const transcripts = await getDatabaseByModuleId(client, TRANSCRIPTS_MODULE_ID);
  const transcript = transcripts && (await getItemById(client, transcripts.id, transcriptId));
  if (!transcript || transcript.deletedAt || !transcripts) throw new NotFoundError("Transcript not found");
  const segments = segmentsSchema.parse(transcript.computed.segments ?? []);
  const transcriptSpeakers = await listTranscriptSpeakers(client, transcriptId, transcript);
  const labels = await labelTranscriptSpeakers(transcriptSpeakers, locale);
  const speakers = labels.map(({ speaker, ordinal, label, personId }) => {
    const first = segments.find((segment) => segment.speaker === speaker);
    if (!first) throw new Error("Speaker has no segment");
    return { speaker, ordinal, label, personId, firstStartsAt: first.startsAt };
  });
  const renderedSegments = segments.map((segment, index) => {
    const speaker = speakers.find((entry) => entry.speaker === segment.speaker);
    if (!speaker) throw new Error("Segment has no speaker");
    return { ...segment, index, label: speaker.label };
  });
  const property = await getPropertyByKey(client, transcripts.id, "event");
  const definition = property && (await getRelationDefinitionByPropertyId(client, property.id));
  const eventEdges = definition ? await listRelationsForItem(client, definition.id, transcriptId) : [];
  const events = await getDatabaseByModuleId(client, EVENTS_MODULE_ID);
  const eventItem =
    events && eventEdges[0] ? await getItemById(client, events.id, otherSide(eventEdges[0], transcriptId)) : null;
  const eventProperties =
    eventItem && !eventItem.deletedAt
      ? z.object({ name: z.string().nullish(), date: z.string().nullish() }).parse(eventItem.properties)
      : null;
  const event =
    eventItem && eventProperties
      ? { id: eventItem.id, name: eventProperties.name ?? null, date: eventProperties.date ?? null }
      : null;
  const fileId = readTranscriptionSourceFileItemId(transcript.properties.link);
  const files = fileId && (await getDatabaseByModuleId(client, FILES_MODULE_ID));
  const file = files && fileId ? await getItemById(client, files.id, fileId) : null;
  const blobId = file ? readBlobId(file.properties) : undefined;
  const blob = blobId ? await getBlob(client, blobId) : null;
  const playback = blob ? { blobId: blob.id, mimeType: blob.mimeType } : null;
  const automationRow = await getItemAutomation(client, transcriptId);
  const automation = automationRow
    ? {
        status: automationRow.status,
        attempts: automationRow.attempts,
        lastAttemptAt: automationRow.lastAttemptAt,
        errorCode: automationRow.errorCode,
      }
    : null;
  const proposals = await getDatabaseByModuleId(client, PROCESSING_PROPOSALS_MODULE_ID);
  const sourceProperty = proposals && (await getPropertyByKey(client, proposals.id, "sourceTranscript"));
  const sourceDefinition = sourceProperty && (await getRelationDefinitionByPropertyId(client, sourceProperty.id));
  const edges = sourceDefinition ? await listRelationsForItem(client, sourceDefinition.id, transcriptId) : [];
  const questions: Array<{ proposalId: string; speaker: string; ordinal: number }> = [];
  for (const edge of edges) {
    const card = proposals && (await getItemById(client, proposals.id, otherSide(edge, transcriptId)));
    if (
      !card ||
      card.deletedAt ||
      card.properties.kind !== "transcript" ||
      (card.properties.status !== "proposed" && card.properties.status !== "needsClarification")
    )
      continue;
    const envelope = parseStoredProposalEnvelope(card.properties.proposal, card.id);
    let speaker: string | null = null;
    if (
      envelope &&
      !("unknownKind" in envelope) &&
      envelope.entityKind === "relation" &&
      envelope.properties.propertyKey === "speakers"
    ) {
      speaker = z.object({ speaker: z.string().min(1) }).parse(envelope.properties.metadata).speaker;
    } else if (z.object({ role: z.literal("speaker") }).safeParse(card.properties.context).success) {
      speaker = transcriptSpeakerCardContextSchema.parse(card.properties.context).speaker;
    }
    if (speaker === null) continue;
    const found = speakers.find((entry) => entry.speaker === speaker);
    if (!found) throw new Error("Speaker proposal references an absent segment speaker");
    questions.push({ proposalId: card.id, speaker: found.speaker, ordinal: found.ordinal });
  }
  questions.sort((a, b) => a.ordinal - b.ordinal || a.proposalId.localeCompare(b.proposalId));
  const properties = z
    .object({ name: z.string().nullish(), date: z.string().nullish(), notes: z.string().nullish() })
    .parse(transcript.properties);
  const computed = z
    .object({
      durationSeconds: z.number().nullish(),
      finalizedAt: z.string().nullish(),
      language: z.string().nullish(),
    })
    .parse(transcript.computed);
  // Issue #1695: rendered from the stored notes and the current speaker edges on every read.
  const storedNotes = parseStoredMeetingNotes(transcript.computed[TRANSCRIPT_MEETING_NOTES_COMPUTED_KEY]);
  const meetingNotes = storedNotes
    ? {
        ...(await renderMeetingNotes(storedNotes, transcriptSpeakers, locale)),
        // Issue #1767: each action item also carries its state, its live task and whether it is the reader's own.
        actionItems: await listTranscriptActionItems(client, transcript.id, locale),
      }
    : null;
  const nameFacts = { name: properties.name, eventName: event?.name };
  return {
    id: transcript.id,
    // Issue #1830: the user's name, else the live Event's name, else "Recording D. M. HH:MM".
    displayName: await resolveTranscriptDisplayName(
      { ...nameFacts, date: properties.date },
      await getSystemTimezone(client),
      locale,
    ),
    suggestedName: resolveTranscriptSuggestedName({ ...nameFacts, generatedTitle: meetingNotes?.title }),
    date: properties.date ?? null,
    durationSeconds: computed.durationSeconds ?? null,
    finalizedAt: computed.finalizedAt ?? null,
    language: computed.language ?? null,
    speakerCount: speakers.length,
    speakers,
    segments: renderedSegments,
    meetingNotes,
    notes: properties.notes ?? null,
    event,
    context: await readTranscriptContext(client, transcripts.id, transcriptId),
    playback,
    automation,
    openQuestions: { count: questions.length, first: questions[0] ?? null },
  };
}
