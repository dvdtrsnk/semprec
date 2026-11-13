import type { PoolClient } from "pg";
import { z } from "zod";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import type { SystemRelationWriteContext } from "../chokePoint/relationEdgeContext.js";
import {
  aiProposalPatch,
  appendHistoryEntry,
  assertValidProposalEnvelope,
  type ProposalEnvelope,
} from "../inbox/inboxTickAction.js";
import { publishInboxCardChange } from "../inbox/inboxCardsRealtime.js";
import { PROCESSING_PROPOSALS_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { EVENTS_MODULE_ID, TRANSCRIPTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { getCalendarClock, type CalendarClock } from "../calendarTime.js";
import { getTenantUserLocale } from "../auth/usersStore.js";
import { ConflictError, NotFoundError, ValidationError } from "../errors.js";
import type { ItemRow } from "../types.js";
import { renderMeetingNotes, parseStoredMeetingNotes } from "./meetingNotesRendering.js";
import { transcriptEventCardContextSchema, type TranscriptEventCardContext } from "./transcriptEventCardContext.js";
import { readTranscriptEventEdges, releaseTrashedEventEdges } from "./transcriptEventEdges.js";
import { listTranscriptSpeakers } from "./transcriptionSpeakerEdges.js";
import {
  TRANSCRIPT_DURATION_SECONDS_COMPUTED_KEY,
  TRANSCRIPT_MEETING_NOTES_COMPUTED_KEY,
  TRANSCRIPT_SEGMENTS_COMPUTED_KEY,
} from "./transcriptionComputedKeys.js";

/** Only these Events `type` values are matched against a recording; a plain `event` never is. */
const MATCHABLE_EVENT_TYPES = ["standup", "meeting"];

/** The Transcripts relation to the Event a recording belongs to. */
const TRANSCRIPT_EVENT_PROPERTY_KEY = "event";

/** A transcript's `date`: the recording's start as a UTC instant with a time of day. */
const DATE_WITH_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** The context a `transcript` card producer writes its card's `sourceTranscript` edge under. */
export const PROCESSING_PROPOSALS_RELATION_CONTEXT: SystemRelationWriteContext = {
  ownerProcess: PROCESSING_PROPOSALS_MODULE_ID,
};

export interface MatchTranscriptToEventInput {
  transcriptId: string;
  /** The recording's length, from step 1's checkpoint; the recording ends this long after the transcript's `date`. */
  durationSeconds: number;
}

/**
 * - `linked`: exactly one candidate, now linked through the Transcripts <-> Events relation. The
 *   Event may already hold other transcripts: the parts of one meeting (issue #1464).
 * - `suggested`: no candidate (no Event whose time interval overlaps the recording), so a
 *   `kind = 'transcript'` Processing proposal card was created instead.
 * - `alreadyLinked`: the transcript already has an edge to an Event that is not in the Trash; nothing
 *   was written. An edge to an Event in the Trash does not count (issue #1743).
 * - `alreadySuggested`: the transcript already has its suggestion card; nothing was written.
 */
export type TranscriptEventMatchOutcome = "linked" | "suggested" | "alreadyLinked" | "alreadySuggested";

/** The idempotency key of a transcript's one suggestion card: every re-run for the same transcript converges on it. */
function transcriptSuggestionIdempotencyKey(transcriptId: string): string {
  return `transcript-suggestion:${transcriptId}`;
}

async function requireDatabaseId(client: PoolClient, moduleId: string): Promise<string> {
  const database = await getDatabaseByModuleId(client, moduleId);
  if (!database) throw new NotFoundError(`Database for module '${moduleId}' not found`);
  return database.id;
}

async function requirePropertyId(client: PoolClient, databaseId: string, key: string): Promise<string> {
  const property = await propertiesStore.getPropertyByKey(client, databaseId, key);
  if (!property) throw new NotFoundError(`Property '${key}' not found on database ${databaseId}`);
  return property.id;
}

function parseRecordingStart(value: unknown): number | null {
  if (typeof value !== "string" || !DATE_WITH_TIME_RE.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** A live Event that overlaps the recording, with the stored values the card shows and the interval it was matched on. */
interface OverlappingEvent {
  id: string;
  name: string;
  date: string;
  timeFrom: string;
  timeTo: string | null;
  endDate: string | null;
  startMs: number;
  endMs: number;
}

interface EventTimeRow {
  id: string;
  name: string | null;
  date: string | null;
  time_from: string | null;
  end_date: string | null;
  time_to: string | null;
}

/**
 * The stored Event with its instants `[start, end]`, or `null` when the Event has no timed interval
 * to compare. The start is `date` at `timeFrom` and the end is `endDate ?? date` at `timeTo`, both
 * wall-clock values in the tenant zone (`clock`); an Event without `timeTo` is a point at its start.
 * All of them are user-owned free input, so they are parsed here rather than cast in SQL, where one
 * malformed value would fail the whole query. `null` covers: an all-day Event (no `timeFrom`); a
 * value `wallClockToInstant` refuses as a `ValidationError` (a malformed date or time); a `timeFrom`
 * of `24:00`, which ends a day rather than starting one; and an end before the start, which is no
 * interval. Any other failure propagates.
 */
function readEventInterval(clock: CalendarClock, row: EventTimeRow): OverlappingEvent | null {
  if (row.date === null || row.time_from === null || row.time_from === "24:00") return null;
  try {
    const startMs = clock.wallClockToInstant(row.date, row.time_from).toMillis();
    const endMs =
      row.time_to === null ? startMs : clock.wallClockToInstant(row.end_date ?? row.date, row.time_to).toMillis();
    return endMs < startMs
      ? null
      : {
          id: row.id,
          name: row.name ?? "",
          date: row.date,
          timeFrom: row.time_from,
          timeTo: row.time_to,
          endDate: row.end_date,
          startMs,
          endMs,
        };
  } catch (error) {
    if (error instanceof ValidationError) return null;
    throw error;
  }
}

/**
 * The live Events of a matchable `type` whose interval overlaps the recording `[startMs, endMs]`,
 * ordered by interval start and then id. The overlap is strict: an Event is a candidate when its
 * start is before `endMs` and its end is after `startMs`, so touching boundaries do not overlap.
 * An Event without `timeTo` is a point at its start, so it is a candidate only when that moment lies
 * strictly inside the recording. See `readEventInterval` for the Events that are left out.
 */
async function listOverlappingEvents(
  client: PoolClient,
  eventsDatabaseId: string,
  recording: { startMs: number; endMs: number },
  clock: CalendarClock,
): Promise<OverlappingEvent[]> {
  const { rows } = await client.query<EventTimeRow>(
    `SELECT id, properties ->> 'name' AS name, properties ->> 'date' AS date,
            properties ->> 'timeFrom' AS time_from, properties ->> 'endDate' AS end_date,
            properties ->> 'timeTo' AS time_to
       FROM items
      WHERE database_id = $1 AND deleted_at IS NULL AND properties ->> 'type' = ANY($2::text[])`,
    [eventsDatabaseId, MATCHABLE_EVENT_TYPES],
  );
  return rows
    .flatMap((row) => readEventInterval(clock, row) ?? [])
    .filter((event) => event.startMs < recording.endMs && event.endMs > recording.startMs)
    .sort((a, b) => a.startMs - b.startMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The ids of `listOverlappingEvents`, in its order. */
export async function listOverlappingEventIds(
  client: PoolClient,
  eventsDatabaseId: string,
  recording: { startMs: number; endMs: number },
  clock: CalendarClock,
): Promise<string[]> {
  return (await listOverlappingEvents(client, eventsDatabaseId, recording, clock)).map((event) => event.id);
}

/** What a client and the recommendation call know about one Event that overlaps a recording. */
export interface TranscriptEventCandidate {
  id: string;
  name: string;
  date: string;
  timeFrom: string;
  timeTo: string | null;
  endDate: string | null;
  projectId: string | null;
  projectName: string | null;
}

/** `ambiguous`: two or more candidates, so no edge and no card was written; see `createTranscriptEventCard`. */
export interface AmbiguousTranscriptEventMatch {
  outcome: "ambiguous";
  candidates: TranscriptEventCandidate[];
}

const itemNameSchema = z.object({ name: z.string().nullish() });

/** The live items `relationKey` (a relation property of the Events database) points to, per Event id. */
async function readEventRelationTargets(
  client: PoolClient,
  eventsDatabaseId: string,
  relationKey: string,
  eventIds: string[],
): Promise<Map<string, ItemRow[]>> {
  const definition = await relationsStore.getRelationDefinitionByPropertyId(
    client,
    await requirePropertyId(client, eventsDatabaseId, relationKey),
  );
  if (!definition) throw new NotFoundError(`Relation definition for Events '${relationKey}' not found`);
  const edges = await relationsStore.listRelationsForItems(client, definition.id, eventIds);
  const eventIdSet = new Set(eventIds);
  const targets = new Map(
    (
      await itemsStore.getItemsByIds(
        client,
        edges.flatMap((edge) => [edge.itemA, edge.itemB]).filter((id) => !eventIdSet.has(id)),
      )
    ).map((item) => [item.id, item]),
  );
  return new Map(
    eventIds.map((eventId) => [
      eventId,
      edges.flatMap((edge) => {
        if (edge.itemA !== eventId && edge.itemB !== eventId) return [];
        const target = targets.get(relationsStore.otherSide(edge, eventId));
        return target ? [target] : [];
      }),
    ]),
  );
}

async function toCandidates(
  client: PoolClient,
  eventsDatabaseId: string,
  events: OverlappingEvent[],
): Promise<TranscriptEventCandidate[]> {
  const projects = await readEventRelationTargets(
    client,
    eventsDatabaseId,
    "project",
    events.map((event) => event.id),
  );
  return events.map((event) => {
    const [project] = projects.get(event.id) ?? [];
    return {
      id: event.id,
      name: event.name,
      date: event.date,
      timeFrom: event.timeFrom,
      timeTo: event.timeTo,
      endDate: event.endDate,
      projectId: project?.id ?? null,
      projectName: project ? (itemNameSchema.parse(project.properties).name ?? null) : null,
    };
  });
}

/** Where a match stands once the transcript is known not to be converged: everything the candidate rule read. */
interface OpenMatch {
  eventPropertyId: string;
  eventsDatabaseId: string;
  processingProposalsDatabaseId: string;
  idempotencyKey: string;
  startMs: number;
  clock: CalendarClock;
  events: OverlappingEvent[];
}

/**
 * The read half of a match, shared by `matchTranscriptToEvent` and `readEventRecommendationContext`:
 * `alreadyLinked` or `alreadySuggested` when the transcript has converged, otherwise the Events that
 * overlap the recording. Writes nothing (`readTranscriptEventEdges` may hold an Event in the Trash
 * `FOR SHARE`); the caller decides whether `transcript` is locked.
 */
async function readOpenMatch(
  client: PoolClient,
  transcript: ItemRow,
  durationSeconds: number,
): Promise<"alreadyLinked" | "alreadySuggested" | OpenMatch> {
  const transcriptsDatabaseId = await requireDatabaseId(client, TRANSCRIPTS_MODULE_ID);
  const eventPropertyId = await requirePropertyId(client, transcriptsDatabaseId, TRANSCRIPT_EVENT_PROPERTY_KEY);
  const eventRelation = await relationsStore.getRelationDefinitionByPropertyId(client, eventPropertyId);
  if (!eventRelation) throw new NotFoundError(`Relation definition for Transcripts 'event' not found`);
  const eventEdges = await readTranscriptEventEdges(client, eventRelation.id, transcript.id);
  if (eventEdges.liveEventIds.length > 0) return "alreadyLinked";

  const processingProposalsDatabaseId = await requireDatabaseId(client, PROCESSING_PROPOSALS_MODULE_ID);
  const idempotencyKey = transcriptSuggestionIdempotencyKey(transcript.id);
  if (await itemsStore.findIdempotentReplay(client, processingProposalsDatabaseId, idempotencyKey))
    return "alreadySuggested";

  const startMs = parseRecordingStart(transcript.properties.date);
  if (startMs === null)
    throw new NotFoundError(`Transcripts item '${transcript.id}' has no recording 'date' yet`, {
      resource: "item",
      itemId: transcript.id,
    });
  const eventsDatabaseId = await requireDatabaseId(client, EVENTS_MODULE_ID);
  const clock = await getCalendarClock(client);
  const events = await listOverlappingEvents(
    client,
    eventsDatabaseId,
    { startMs, endMs: startMs + durationSeconds * 1000 },
    clock,
  );
  return { eventPropertyId, eventsDatabaseId, processingProposalsDatabaseId, idempotencyKey, startMs, clock, events };
}

/** The create-Event proposal of a card that links no Event: the transcript's name and the recording's date in the tenant zone. */
async function newEventEnvelope(
  client: PoolClient,
  transcript: ItemRow,
  eventsDatabaseId: string,
  startMs: number,
  clock: CalendarClock,
): Promise<ProposalEnvelope> {
  const envelope: ProposalEnvelope = {
    entityKind: "database",
    target: eventsDatabaseId,
    properties: {
      name: transcript.properties.name,
      type: "meeting",
      date: clock.instantToWallClock(new Date(startMs)).date,
    },
  };
  await assertValidProposalEnvelope(client, envelope);
  return envelope;
}

/**
 * Creates a `transcript` card with `sourceTranscript` pointing at the transcript and announces it
 * (after commit). `properties` are the producer's own; `allowedSystemKeys` names every system key
 * among them.
 */
async function createTranscriptCard(
  client: PoolClient,
  input: {
    processingProposalsDatabaseId: string;
    idempotencyKey: string;
    transcriptId: string;
    properties: Record<string, unknown>;
  },
): Promise<string> {
  const card = await createItemWithClient(
    client,
    {
      databaseId: input.processingProposalsDatabaseId,
      idempotencyKey: input.idempotencyKey,
      properties: { kind: "transcript", ...input.properties },
    },
    { allowedSystemKeys: ["kind", "proposal", "aiProposal", "aiVersion", "history", "context", "status"] },
  );
  const sourceTranscriptPropertyId = await requirePropertyId(
    client,
    input.processingProposalsDatabaseId,
    "sourceTranscript",
  );
  await createRelationWithClient(
    client,
    { relationPropertyId: sourceTranscriptPropertyId, callerItemId: card.id, targetItemId: input.transcriptId },
    PROCESSING_PROPOSALS_RELATION_CONTEXT,
  );
  publishInboxCardChange(client, card.id, "created");
  return card.id;
}

async function lockTranscript(client: PoolClient, transcriptId: string): Promise<ItemRow> {
  const transcriptsDatabaseId = await requireDatabaseId(client, TRANSCRIPTS_MODULE_ID);
  const transcript = await itemsStore.lockItemById(client, transcriptsDatabaseId, transcriptId);
  if (!transcript || transcript.deletedAt)
    throw new NotFoundError(`Transcripts item '${transcriptId}' not found`, {
      resource: "item",
      itemId: transcriptId,
    });
  return transcript;
}

/**
 * Step 6 of the transcription pipeline (`match`): mechanical, no model call. Runs inside the
 * caller's transaction and row-locks the transcript first, so concurrent runs for the same
 * transcript serialize and every check below still holds when the write lands.
 *
 * A transcript that already has an edge to an Event that is not in the Trash, or already has its
 * suggestion card (found by `transcriptSuggestionIdempotencyKey`, whatever that card's status or
 * deletion), is left as it is — a re-run never writes a second edge or a second card. An edge to an
 * Event in the Trash is no link (issue #1743): the match goes on as for a transcript without an
 * Event. `readTranscriptEventEdges` holds that Event's row `FOR SHARE`, so a restore of it waits for
 * this transaction. Otherwise the candidates are the Events whose time interval overlaps the
 * recording (`listOverlappingEvents`: the tenant zone, `date`/`timeFrom` to `endDate ?? date`/`timeTo`,
 * touching boundaries do not overlap), the recording being `Transcripts.date` to that plus the duration.
 * Exactly one candidate is linked directly, even when that Event already holds other transcripts: an
 * Event has many transcripts, and the database still allows a transcript only one Event, so an edge
 * to a trashed Event is deleted first, in this transaction (`releaseTrashedEventEdges`). With no
 * candidate it creates one `proposed` card with `sourceTranscript` pointing at the transcript and a
 * create-Event proposal whose `name` comes from the transcript and whose `date` is the recording's
 * date in the tenant zone (`YYYY-MM-DD`), and leaves an edge to a trashed Event as it is. With two or
 * more candidates it writes nothing and returns them as `ambiguous`, so the caller can ask which one
 * the recording belongs to and then call `createTranscriptEventCard` in this transaction (issue
 * #1848). The tenant zone is read and validated once, in this transaction; an invalid zone propagates
 * as a `ValidationError`.
 */
export async function matchTranscriptToEvent(
  client: PoolClient,
  input: MatchTranscriptToEventInput,
): Promise<TranscriptEventMatchOutcome | AmbiguousTranscriptEventMatch> {
  const transcript = await lockTranscript(client, input.transcriptId);
  const open = await readOpenMatch(client, transcript, input.durationSeconds);
  if (typeof open === "string") return open;

  const [onlyCandidate] = open.events;
  if (open.events.length === 1 && onlyCandidate) {
    await releaseTrashedEventEdges(client, { eventPropertyId: open.eventPropertyId, transcriptId: transcript.id });
    await createRelationWithClient(client, {
      relationPropertyId: open.eventPropertyId,
      callerItemId: transcript.id,
      targetItemId: onlyCandidate.id,
    });
    return "linked";
  }
  if (open.events.length > 1)
    return { outcome: "ambiguous", candidates: await toCandidates(client, open.eventsDatabaseId, open.events) };

  const envelope = await newEventEnvelope(client, transcript, open.eventsDatabaseId, open.startMs, open.clock);
  await createTranscriptCard(client, {
    processingProposalsDatabaseId: open.processingProposalsDatabaseId,
    idempotencyKey: open.idempotencyKey,
    transcriptId: transcript.id,
    properties: {
      proposal: envelope,
      ...aiProposalPatch({}, envelope),
      history: appendHistoryEntry(
        [],
        `${open.events.length} Events overlapped the recording's time interval, so none was linked; proposed a new Event.`,
      ),
      status: "proposed",
    },
  });
  return "suggested";
}

/** What the recommendation call needs: the overlapping Events with their participants, the meeting notes and the UI language. */
export interface EventRecommendationContext {
  candidates: Array<TranscriptEventCandidate & { participantNames: string[] }>;
  /** The meeting notes with their speaker tokens replaced (`renderMeetingNotes`). */
  notes: { title: string; summary: string; shortSummary: string };
  /** `users.locale` of the tenant's user, the language of the reason. */
  locale: string;
}

/**
 * The read half of step 6 for a transcript that may need the recommendation call (issue #1848):
 * `null` when the transcript has converged (an edge to a live Event, or its card) or fewer than two
 * Events overlap the recording, so no call is due; otherwise the candidates, the rendered meeting
 * notes and the locale. Writes nothing. A transcript without stored `meetingNotes` throws
 * `NotFoundError`, since step 5 stores them before step 6.
 */
export async function readEventRecommendationContext(
  client: PoolClient,
  input: MatchTranscriptToEventInput,
): Promise<EventRecommendationContext | null> {
  const transcriptsDatabaseId = await requireDatabaseId(client, TRANSCRIPTS_MODULE_ID);
  const transcript = await itemsStore.getItemById(client, transcriptsDatabaseId, input.transcriptId);
  if (!transcript || transcript.deletedAt)
    throw new NotFoundError(`Transcripts item '${input.transcriptId}' not found`, {
      resource: "item",
      itemId: input.transcriptId,
    });
  const open = await readOpenMatch(client, transcript, input.durationSeconds);
  if (typeof open === "string" || open.events.length < 2) return null;

  const notes = parseStoredMeetingNotes(transcript.computed[TRANSCRIPT_MEETING_NOTES_COMPUTED_KEY]);
  if (!notes)
    throw new NotFoundError(
      `Transcripts item '${transcript.id}' has no '${TRANSCRIPT_MEETING_NOTES_COMPUTED_KEY}' yet`,
      { resource: "item", itemId: transcript.id },
    );
  const locale = (await getTenantUserLocale(client)) ?? "cs";
  const rendered = await renderMeetingNotes(
    notes,
    await listTranscriptSpeakers(client, transcript.id, transcript),
    locale,
  );
  const candidates = await toCandidates(client, open.eventsDatabaseId, open.events);
  const participants = await readEventRelationTargets(
    client,
    open.eventsDatabaseId,
    "people",
    candidates.map((candidate) => candidate.id),
  );
  return {
    candidates: candidates.map((candidate) => ({
      ...candidate,
      participantNames: (participants.get(candidate.id) ?? [])
        .flatMap((person) => itemNameSchema.parse(person.properties).name ?? [])
        .filter((name) => name.length > 0)
        .sort(),
    })),
    notes: { title: rendered.title, summary: rendered.summary, shortSummary: rendered.shortSummary },
    locale,
  };
}

/** The model's answer to which overlapping Event a recording belongs to. */
export interface EventRecommendation {
  eventId: string | null;
  reason: string;
}

/** A recording quote needs at least this many words to be worth showing. */
const QUOTE_MIN_WORDS = 5;
/** A recording quote is shortened to this many characters. */
const QUOTE_MAX_CHARACTERS = 120;

const recordedSegmentsSchema = z.array(z.object({ speaker: z.string(), text: z.string() }));

/** The deterministic facts about a recording the card shows: how long it is, how many speakers and one quote. */
function readRecordingFacts(transcript: ItemRow): TranscriptEventCardContext["recording"] {
  const segments = recordedSegmentsSchema.safeParse(transcript.computed[TRANSCRIPT_SEGMENTS_COMPUTED_KEY]);
  const durationSeconds = z.number().safeParse(transcript.computed[TRANSCRIPT_DURATION_SECONDS_COMPUTED_KEY]);
  if (!segments.success || !durationSeconds.success)
    throw new NotFoundError(`Transcripts item '${transcript.id}' has no segments and duration yet`, {
      resource: "item",
      itemId: transcript.id,
    });
  const quoted = segments.data.findIndex(
    (segment) => segment.text.trim().split(/\s+/).filter(Boolean).length >= QUOTE_MIN_WORDS,
  );
  const quote = segments.data[quoted];
  return {
    durationSeconds: durationSeconds.data,
    speakerCount: new Set(segments.data.map((segment) => segment.speaker)).size,
    // Sliced by code point: a cut inside a surrogate pair would leave a lone surrogate that jsonb refuses.
    quote: quote
      ? { segmentIndex: quoted, text: Array.from(quote.text.trim()).slice(0, QUOTE_MAX_CHARACTERS).join("") }
      : null,
  };
}

/**
 * Creates the one `proposed` card of a recording that overlapped two or more Events (issue #1848),
 * in the caller's transaction, right after `matchTranscriptToEvent` returned `ambiguous` for it.
 * The model never writes the Event edge: the card is for the user to confirm. A recommendation is
 * used only when its `eventId` is one of `candidates`; the card then proposes the `event` relation
 * to that Event, otherwise the create-Event proposal of a card without candidates. A `null`
 * `eventId` keeps the model's reason with `recommendedEventId` `null`; an id that is not a
 * candidate drops the whole answer, so both are `null`; a blank reason is `null`. The card is
 * created under the idempotency key of `matchTranscriptToEvent`'s own card, with the display data
 * only in `context` (`transcriptEventCardContextSchema`), and a transcript that already has that
 * card throws `ConflictError` without writing: `matchTranscriptToEvent` reports `alreadySuggested`
 * for it first. The transcript is locked first. Returns the card id with the recommendation as
 * stored.
 */
export async function createTranscriptEventCard(
  client: PoolClient,
  input: { transcriptId: string; candidates: TranscriptEventCandidate[]; recommendation: EventRecommendation | null },
): Promise<{ cardId: string; recommendedEventId: string | null; reason: string | null }> {
  const transcript = await lockTranscript(client, input.transcriptId);
  const processingProposalsDatabaseId = await requireDatabaseId(client, PROCESSING_PROPOSALS_MODULE_ID);
  const idempotencyKey = transcriptSuggestionIdempotencyKey(transcript.id);
  if (await itemsStore.findIdempotentReplay(client, processingProposalsDatabaseId, idempotencyKey))
    throw new ConflictError(`Transcripts item '${transcript.id}' already has its suggestion card`);

  const { recommendation } = input;
  const answer =
    recommendation &&
    (recommendation.eventId === null || input.candidates.some((candidate) => candidate.id === recommendation.eventId))
      ? recommendation
      : null;
  const recommendedEventId = answer?.eventId ?? null;
  const reason = answer?.reason.trim() || null;
  const context = transcriptEventCardContextSchema.parse({
    role: "event",
    candidates: input.candidates,
    reason,
    recommendedEventId,
    recording: readRecordingFacts(transcript),
  });

  const eventsDatabaseId = await requireDatabaseId(client, EVENTS_MODULE_ID);
  const startMs = parseRecordingStart(transcript.properties.date);
  if (startMs === null)
    throw new NotFoundError(`Transcripts item '${transcript.id}' has no recording 'date' yet`, {
      resource: "item",
      itemId: transcript.id,
    });
  const envelope: ProposalEnvelope =
    recommendedEventId === null
      ? await newEventEnvelope(client, transcript, eventsDatabaseId, startMs, await getCalendarClock(client))
      : {
          entityKind: "relation",
          target: recommendedEventId,
          properties: { propertyKey: TRANSCRIPT_EVENT_PROPERTY_KEY },
        };
  await assertValidProposalEnvelope(client, envelope);
  const overlapped = `${input.candidates.length} Events overlapped the recording's time interval, so none was linked`;
  const cardId = await createTranscriptCard(client, {
    processingProposalsDatabaseId,
    idempotencyKey,
    transcriptId: transcript.id,
    properties: {
      proposal: envelope,
      ...aiProposalPatch({}, envelope),
      context,
      history: appendHistoryEntry(
        [],
        recommendedEventId === null
          ? `${overlapped}; none could be recommended from the recording's content; proposed a new Event.`
          : `${overlapped}; recommended one of them from the recording's content.`,
      ),
      status: "proposed",
    },
  });
  return { cardId, recommendedEventId, reason };
}
