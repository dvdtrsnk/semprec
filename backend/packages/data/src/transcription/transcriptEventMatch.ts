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
import { referencedItemIdsOf } from "../inbox/proposalReferences.js";
import { PROCESSING_PROPOSALS_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { EVENTS_MODULE_ID, TRANSCRIPTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { getCalendarClock, type CalendarClock } from "../calendarTime.js";
import { formatOccurrenceId } from "../calendar/eventOccurrenceId.js";
import { expandEventOccurrences, readLiveEventSeries } from "../calendar/eventOccurrences.js";
import { eventRecurrenceOccursOn } from "../calendar/eventRecurrenceRule.js";
import { readEventSeries } from "../calendar/eventSeries.js";
import { createCalendarTimelineLookups } from "../calendar/timelineLookups.js";
import { getTenantUserLocale } from "../auth/usersStore.js";
import { ConflictError, NotFoundError, ValidationError } from "../errors.js";
import type { ItemRow } from "../types.js";
import { renderMeetingNotes, parseStoredMeetingNotes } from "./meetingNotesRendering.js";
import { transcriptEventCardContextSchema, type TranscriptEventCardContext } from "./transcriptEventCardContext.js";
import { presentText } from "./transcriptDisplayName.js";
import { renderTranscriptionLabel } from "./transcriptionLabels.js";
import { readRecordingEventDecision } from "./recordingIntake.js";
import { readTranscriptionSourceFileItemId } from "./transcriptionJob.js";
import { readTranscriptEventEdges, releaseTrashedEventEdges } from "./transcriptEventEdges.js";
import { listTranscriptSpeakers } from "./transcriptionSpeakerEdges.js";
import {
  TRANSCRIPT_DURATION_SECONDS_COMPUTED_KEY,
  TRANSCRIPT_MEETING_NOTES_COMPUTED_KEY,
  TRANSCRIPT_SEGMENTS_COMPUTED_KEY,
} from "./transcriptionComputedKeys.js";

/** A plain `event` is never matched against a recording. */
const MATCHABLE_EVENT_TYPES = ["standup", "meeting"];

export const TRANSCRIPT_EVENT_PROPERTY_KEY = "event";

/** A transcript's `date`: the recording's start as a UTC instant with a time of day. */
const DATE_WITH_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

export const PROCESSING_PROPOSALS_RELATION_CONTEXT: SystemRelationWriteContext = {
  ownerProcess: PROCESSING_PROPOSALS_MODULE_ID,
};

export interface MatchTranscriptToEventInput {
  transcriptId: string;
  /** The recording ends this long after the transcript's `date`. */
  durationSeconds: number;
}

/**
 * `alreadyLinked` ignores an edge to a trashed Event. `noEventChosen`: the explicit `noEvent` decision
 * stops the match whatever edge or card exists. Only `linked` and `suggested` write.
 */
export type TranscriptEventMatchOutcome =
  "linked" | "suggested" | "alreadyLinked" | "alreadySuggested" | "noEventChosen";

/** Every re-run for the same transcript converges on this one card. */
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

interface EventTimes {
  id: string;
  name: string | null;
  date: string | null;
  time_from: string | null;
  end_date: string | null;
  time_to: string | null;
}

interface EventTimeRow extends EventTimes {
  properties: Record<string, unknown>;
}

/**
 * `[start, end]` instants from `date`/`timeFrom` to `endDate ?? date`/`timeTo` in the tenant zone; an
 * Event without `timeTo` is a point at its start. These are user-owned free input, so they are parsed
 * here rather than cast in SQL, where one malformed value would fail the whole query. `null` for an
 * all-day Event, a value `wallClockToInstant` refuses, a `timeFrom` of `24:00`, or an end before the
 * start. Any other failure propagates.
 */
function readEventInterval(clock: CalendarClock, row: EventTimes): OverlappingEvent | null {
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
 * Ordered by interval start, then id. Overlap is strict (touching boundaries do not overlap). A
 * recurring series whose rule gives its own day is left out: that day's occurrence is found as virtual
 * or as its materialized Event, so the series would offer the day twice. A series whose rule skips its
 * own day stays a stored candidate.
 */
async function listOverlappingEvents(
  client: PoolClient,
  eventsDatabaseId: string,
  recording: { startMs: number; endMs: number },
  clock: CalendarClock,
): Promise<OverlappingEvent[]> {
  const { rows } = await client.query<EventTimeRow>(
    `SELECT id, properties, properties ->> 'name' AS name, properties ->> 'date' AS date,
            properties ->> 'timeFrom' AS time_from, properties ->> 'endDate' AS end_date,
            properties ->> 'timeTo' AS time_to
       FROM items
      WHERE database_id = $1 AND deleted_at IS NULL AND properties ->> 'type' = ANY($2::text[])`,
    [eventsDatabaseId, MATCHABLE_EVENT_TYPES],
  );
  return rows
    .filter((row) => !standsForItsFirstOccurrence(row.properties))
    .flatMap((row) => readEventInterval(clock, row) ?? [])
    .filter((event) => overlapsRecording(event, recording))
    .sort((a, b) => a.startMs - b.startMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function standsForItsFirstOccurrence(properties: Record<string, unknown>): boolean {
  const definition = readEventSeries(properties);
  return definition !== null && eventRecurrenceOccursOn(definition.rule, definition.startDate, definition.startDate);
}

/** Touching boundaries do not overlap. */
function overlapsRecording(
  interval: { startMs: number; endMs: number },
  recording: { startMs: number; endMs: number },
): boolean {
  return interval.startMs < recording.endMs && interval.endMs > recording.startMs;
}

/**
 * At most one per series and day, ordered by interval start, then series id. Occurrences are compared
 * exactly as stored Events (`readEventInterval`, strict overlap), so both candidate kinds follow one
 * rule. Only an occurrence with no item is virtual; a cancelled date (item trashed) gives no entry.
 */
async function listVirtualOccurrences(
  client: PoolClient,
  eventsDatabaseId: string,
  recording: { startMs: number; endMs: number },
  clock: CalendarClock,
): Promise<OccurrenceCandidate[]> {
  const to = clock.instantToWallClock(new Date(recording.endMs)).date;
  const series = (await readLiveEventSeries(client, eventsDatabaseId, to)).filter(
    (row) => typeof row.properties.type === "string" && MATCHABLE_EVENT_TYPES.includes(row.properties.type),
  );
  const entries = await expandEventOccurrences(client, eventsDatabaseId, series, {
    from: clock.instantToWallClock(new Date(recording.startMs)).date,
    to,
    timezone: clock.zone,
    lookups: createCalendarTimelineLookups(client),
  });
  return entries
    .flatMap((entry) => {
      const interval = entry.overridden
        ? null
        : readEventInterval(clock, {
            id: entry.id,
            name: entry.title,
            date: entry.date,
            time_from: entry.timeFrom,
            end_date: entry.endDate,
            time_to: entry.timeTo,
          });
      return interval !== null && overlapsRecording(interval, recording)
        ? [{ seriesId: entry.seriesId, occurrenceDate: entry.occurrenceDate, startMs: interval.startMs }]
        : [];
    })
    .sort((a, b) => a.startMs - b.startMs || (a.seriesId < b.seriesId ? -1 : a.seriesId > b.seriesId ? 1 : 0));
}

export async function listOverlappingEventIds(
  client: PoolClient,
  eventsDatabaseId: string,
  recording: { startMs: number; endMs: number },
  clock: CalendarClock,
): Promise<string[]> {
  return (await listOverlappingEvents(client, eventsDatabaseId, recording, clock)).map((event) => event.id);
}

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

/** A recurring Event's occurrence with no item yet; it becomes an Events item only when the card is confirmed. */
export interface TranscriptOccurrenceCandidate {
  seriesId: string;
  occurrenceDate: string;
}

export type TranscriptMatchCandidate = TranscriptEventCandidate | TranscriptOccurrenceCandidate;

interface OccurrenceCandidate extends TranscriptOccurrenceCandidate {
  startMs: number;
}

/**
 * Nothing written. Two or more stored Events, or any virtual occurrence (never linked directly, even
 * when it is the only candidate). Stored Events come first.
 */
export interface AmbiguousTranscriptEventMatch {
  outcome: "ambiguous";
  candidates: TranscriptMatchCandidate[];
}

function isStoredCandidate(candidate: TranscriptMatchCandidate): candidate is TranscriptEventCandidate {
  return "id" in candidate;
}

const itemNameSchema = z.object({ name: z.string().nullish() });

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
  if (events.length === 0) return [];
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

interface OpenMatch {
  eventPropertyId: string;
  eventsDatabaseId: string;
  processingProposalsDatabaseId: string;
  idempotencyKey: string;
  startMs: number;
  clock: CalendarClock;
  events: OverlappingEvent[];
  occurrences: OccurrenceCandidate[];
}

/**
 * Shared by `matchTranscriptToEvent` and `readEventRecommendationContext`. The `noEvent` decision is
 * checked first. Writes nothing (`readTranscriptEventEdges` may hold a trashed Event `FOR SHARE`); the
 * caller decides whether `transcript` is locked.
 */
async function readOpenMatch(
  client: PoolClient,
  transcript: ItemRow,
  durationSeconds: number,
): Promise<"noEventChosen" | "alreadyLinked" | "alreadySuggested" | OpenMatch> {
  const sourceFileItemId = readTranscriptionSourceFileItemId(transcript.properties.link);
  if (sourceFileItemId !== null && (await readRecordingEventDecision(client, sourceFileItemId)) !== null)
    return "noEventChosen";
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
  const recording = { startMs, endMs: startMs + durationSeconds * 1000 };
  const events = await listOverlappingEvents(client, eventsDatabaseId, recording, clock);
  const occurrences = await listVirtualOccurrences(client, eventsDatabaseId, recording, clock);
  return {
    eventPropertyId,
    eventsDatabaseId,
    processingProposalsDatabaseId,
    idempotencyKey,
    startMs,
    clock,
    events,
    occurrences,
  };
}

interface MeetingSpan {
  date: string;
  timeFrom: string;
  timeTo: string;
  endDate: string | null;
}

/**
 * Minutes precision; `endDate` only when the end is on another local day. An end not later than the
 * start on the wall clock (sub-minute recording, or DST repeated hour) is moved to one minute after it,
 * because the Events rules refuse a `timeTo` not later than `timeFrom`.
 */
function meetingSpan(clock: CalendarClock, startMs: number, durationSeconds: number): MeetingSpan {
  const start = clock.instantToWallClock(new Date(startMs));
  const recordedEnd = clock.instantToWallClock(new Date(startMs + durationSeconds * 1000));
  const end =
    recordedEnd.date === start.date && recordedEnd.time <= start.time
      ? clock.instantToWallClock(new Date(startMs + 60_000))
      : recordedEnd;
  return {
    date: start.date,
    timeFrom: start.time,
    timeTo: end.time,
    endDate: end.date === start.date ? null : end.date,
  };
}

async function newMeetingName(locale: string, date: string): Promise<string> {
  const [, month, day] = date.split("-").map(Number);
  return renderTranscriptionLabel(locale, "transcript.newMeeting.name", { day: day ?? 0, month: month ?? 0 });
}

/**
 * `null` without a recommendation, or for a missing, trashed or other-database Event, or one without a
 * live project. No card creation calls it today; it resolves the project for a new-meeting proposal
 * built from a recommendation.
 */
export async function readRecommendedEventProjectId(
  client: PoolClient,
  eventsDatabaseId: string,
  recommendedEventId: string | null,
): Promise<string | null> {
  if (recommendedEventId === null) return null;
  const [event] = await itemsStore.getItemsByIds(client, [recommendedEventId]);
  if (!event || event.databaseId !== eventsDatabaseId) return null;
  const projects = await readEventRelationTargets(client, eventsDatabaseId, "project", [event.id]);
  return projects.get(event.id)?.[0]?.id ?? null;
}

/**
 * A meeting named `name`, or after the recording's local day and month, with the recording's
 * wall-clock span in the tenant zone and the `project` relation when `projectId` is set. A blank `name`
 * counts as none; an empty name throws. A project that is not a live Projects item throws
 * `ValidationError` (via `assertValidProposalEnvelope`).
 */
export async function buildNewMeetingEnvelope(
  client: PoolClient,
  input: {
    eventsDatabaseId: string;
    startMs: number;
    durationSeconds: number;
    clock: CalendarClock;
    projectId: string | null;
    name: string | null;
    locale: string;
  },
): Promise<ProposalEnvelope> {
  const span = meetingSpan(input.clock, input.startMs, input.durationSeconds);
  const name = presentText(input.name) ?? (await newMeetingName(input.locale, span.date));
  if (presentText(name) === null) throw new Error("A proposed meeting needs a non-empty name");
  const envelope: ProposalEnvelope = {
    entityKind: "database",
    target: input.eventsDatabaseId,
    properties: {
      name,
      type: "meeting",
      date: span.date,
      timeFrom: span.timeFrom,
      timeTo: span.timeTo,
      ...(span.endDate === null ? {} : { endDate: span.endDate }),
    },
    ...(input.projectId === null ? {} : { relations: { project: [input.projectId] } }),
  };
  await assertValidProposalEnvelope(client, envelope);
  return envelope;
}

/**
 * The user's `name`, else the meeting-notes title, else `null` (then the meeting is named after the
 * day). Locale falls back to Czech without a tenant user.
 */
async function readProposedMeetingName(
  client: PoolClient,
  transcript: ItemRow,
): Promise<{ name: string | null; locale: string }> {
  const locale = (await getTenantUserLocale(client)) ?? "cs";
  const named = presentText(transcript.properties.name);
  if (named !== null) return { name: named, locale };
  const notes = parseStoredMeetingNotes(transcript.computed[TRANSCRIPT_MEETING_NOTES_COMPUTED_KEY]);
  if (!notes) return { name: null, locale };
  const rendered = await renderMeetingNotes(
    notes,
    await listTranscriptSpeakers(client, transcript.id, transcript),
    locale,
  );
  return { name: presentText(rendered.title), locale };
}

/** Announces the card after commit. `allowedSystemKeys` names every system key among `properties`. */
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
    {
      allowedSystemKeys: [
        "kind",
        "proposal",
        "aiProposal",
        "aiVersion",
        "referencedItemIds",
        "history",
        "context",
        "status",
      ],
    },
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
 * Pipeline step `match`: mechanical, no model call. Runs in the caller's transaction and row-locks the
 * transcript first, so concurrent runs serialize and every check still holds when the write lands.
 *
 * A re-run never writes a second edge or card. An edge to a trashed Event is no link; that Event is held
 * `FOR SHARE`, so its restore waits for this transaction. One stored candidate and no virtual one is
 * linked directly (a trashed Event's edge is deleted first: a transcript has one Event); none creates
 * the new-meeting card; otherwise nothing is written and the result is `ambiguous`, for the caller to
 * ask the model and call `createTranscriptEventCard` in this transaction. Only the card confirm
 * materializes an occurrence.
 */
export async function matchTranscriptToEvent(
  client: PoolClient,
  input: MatchTranscriptToEventInput,
): Promise<TranscriptEventMatchOutcome | AmbiguousTranscriptEventMatch> {
  const transcript = await lockTranscript(client, input.transcriptId);
  const open = await readOpenMatch(client, transcript, input.durationSeconds);
  if (typeof open === "string") return open;

  const [onlyCandidate] = open.events;
  if (open.events.length === 1 && onlyCandidate && open.occurrences.length === 0) {
    await releaseTrashedEventEdges(client, { eventPropertyId: open.eventPropertyId, transcriptId: transcript.id });
    await createRelationWithClient(client, {
      relationPropertyId: open.eventPropertyId,
      callerItemId: transcript.id,
      targetItemId: onlyCandidate.id,
    });
    return "linked";
  }
  if (open.events.length + open.occurrences.length > 0)
    return {
      outcome: "ambiguous",
      candidates: [
        ...(await toCandidates(client, open.eventsDatabaseId, open.events)),
        ...open.occurrences.map(({ seriesId, occurrenceDate }) => ({ seriesId, occurrenceDate })),
      ],
    };

  const envelope = await buildNewMeetingEnvelope(client, {
    eventsDatabaseId: open.eventsDatabaseId,
    startMs: open.startMs,
    durationSeconds: input.durationSeconds,
    clock: open.clock,
    projectId: null,
    ...(await readProposedMeetingName(client, transcript)),
  });
  await createTranscriptCard(client, {
    processingProposalsDatabaseId: open.processingProposalsDatabaseId,
    idempotencyKey: open.idempotencyKey,
    transcriptId: transcript.id,
    properties: {
      proposal: envelope,
      ...aiProposalPatch({}, envelope),
      referencedItemIds: referencedItemIdsOf(envelope),
      history: appendHistoryEntry(
        [],
        `${open.events.length} Events overlapped the recording's time interval, so none was linked; proposed a new Event.`,
      ),
      status: "proposed",
    },
  });
  return "suggested";
}

export interface EventRecommendationContext {
  candidates: Array<TranscriptEventCandidate & { participantNames: string[] }>;
  /** Speaker tokens replaced (`renderMeetingNotes`). */
  notes: { title: string; summary: string; shortSummary: string };
  locale: string;
}

/**
 * `null` when no paid call is due: the transcript converged, holds the `noEvent` decision, or fewer
 * than two stored Events overlap (a virtual occurrence is not a candidate of the call). Writes nothing.
 * Throws `NotFoundError` without stored `meetingNotes`, since the notes step runs before the match.
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

export interface EventRecommendation {
  eventId: string | null;
  reason: string;
}

const QUOTE_MIN_WORDS = 5;
const QUOTE_MAX_CHARACTERS = 120;

const recordedSegmentsSchema = z.array(z.object({ speaker: z.string(), text: z.string() }));

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
 * Creates the `proposed` card for an `ambiguous` match, in the caller's transaction right after it.
 * The model never writes the Event edge: the user confirms the card.
 *
 * The proposal is the `event` relation to the recommended Event when it is a stored candidate (no
 * project); else, with one virtual-occurrence candidate, the `event` relation to its synthetic id
 * `<seriesId>@<date>`, which the confirm materializes; else the new-meeting proposal without a
 * project. A `null` `eventId` keeps the reason; an id that is not a stored candidate drops the whole
 * answer.
 *
 * Uses the match's own idempotency key, so a transcript that already has the card throws
 * `ConflictError` without writing. The transcript is locked first.
 */
export async function createTranscriptEventCard(
  client: PoolClient,
  input: { transcriptId: string; candidates: TranscriptMatchCandidate[]; recommendation: EventRecommendation | null },
): Promise<{ cardId: string; recommendedEventId: string | null; reason: string | null }> {
  const transcript = await lockTranscript(client, input.transcriptId);
  const processingProposalsDatabaseId = await requireDatabaseId(client, PROCESSING_PROPOSALS_MODULE_ID);
  const idempotencyKey = transcriptSuggestionIdempotencyKey(transcript.id);
  if (await itemsStore.findIdempotentReplay(client, processingProposalsDatabaseId, idempotencyKey))
    throw new ConflictError(`Transcripts item '${transcript.id}' already has its suggestion card`);

  const { recommendation } = input;
  const answer =
    recommendation &&
    (recommendation.eventId === null ||
      input.candidates.some((candidate) => isStoredCandidate(candidate) && candidate.id === recommendation.eventId))
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
  const [onlyCandidate] = input.candidates;
  const onlyOccurrence =
    input.candidates.length === 1 && onlyCandidate && !isStoredCandidate(onlyCandidate) ? onlyCandidate : null;
  const proposedTarget =
    recommendedEventId ??
    (onlyOccurrence && formatOccurrenceId(onlyOccurrence.seriesId, onlyOccurrence.occurrenceDate));
  const envelope: ProposalEnvelope =
    proposedTarget === null
      ? await buildNewMeetingEnvelope(client, {
          eventsDatabaseId,
          startMs,
          durationSeconds: context.recording.durationSeconds,
          clock: await getCalendarClock(client),
          projectId: null,
          ...(await readProposedMeetingName(client, transcript)),
        })
      : {
          entityKind: "relation",
          target: proposedTarget,
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
      referencedItemIds: referencedItemIdsOf(envelope),
      context,
      history: appendHistoryEntry(
        [],
        onlyOccurrence
          ? "One occurrence of a recurring Event overlapped the recording, so it was not linked; proposed linking it, which creates the occurrence's Event when confirmed."
          : recommendedEventId === null
            ? `${overlapped}; none could be recommended from the recording's content; proposed a new Event.`
            : `${overlapped}; recommended one of them from the recording's content.`,
      ),
      status: "proposed",
    },
  });
  return { cardId, recommendedEventId, reason };
}
