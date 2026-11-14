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
import { getTenantUserLocale } from "../auth/usersStore.js";
import { ConflictError, NotFoundError, ValidationError } from "../errors.js";
import type { ItemRow } from "../types.js";
import { renderMeetingNotes, parseStoredMeetingNotes } from "./meetingNotesRendering.js";
import { transcriptEventCardContextSchema, type TranscriptEventCardContext } from "./transcriptEventCardContext.js";
import { presentText } from "./transcriptDisplayName.js";
import { renderTranscriptionLabel } from "./transcriptionLabels.js";
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
export const TRANSCRIPT_EVENT_PROPERTY_KEY = "event";

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
 * - `linked`: exactly one candidate, a stored Event, now linked through the Transcripts <-> Events relation. The
 *   Event may already hold other transcripts: the parts of one meeting (issue #1464).
 * - `suggested`: no candidate (no Event or occurrence whose time interval overlaps the recording), so a
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

/** The stored values of an Event that `readEventInterval` reads. */
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
 * The stored Event with its instants `[start, end]`, or `null` when the Event has no timed interval
 * to compare. The start is `date` at `timeFrom` and the end is `endDate ?? date` at `timeTo`, both
 * wall-clock values in the tenant zone (`clock`); an Event without `timeTo` is a point at its start.
 * All of them are user-owned free input, so they are parsed here rather than cast in SQL, where one
 * malformed value would fail the whole query. `null` covers: an all-day Event (no `timeFrom`); a
 * value `wallClockToInstant` refuses as a `ValidationError` (a malformed date or time); a `timeFrom`
 * of `24:00`, which ends a day rather than starting one; and an end before the start, which is no
 * interval. Any other failure propagates.
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
 * The live Events of a matchable `type` whose interval overlaps the recording `[startMs, endMs]`,
 * ordered by interval start and then id. The overlap is strict: an Event is a candidate when its
 * start is before `endMs` and its end is after `startMs`, so touching boundaries do not overlap.
 * An Event without `timeTo` is a point at its start, so it is a candidate only when that moment lies
 * strictly inside the recording. See `readEventInterval` for the Events that are left out. A recurring
 * series (`readEventSeries`) whose own day is a day its rule gives (`standsForItsFirstOccurrence`) is left out
 * as well: its occurrence on that day is found by `listVirtualOccurrences` while it is virtual and, once
 * materialized, as the stored Event it is, so the series Event would offer the same day a second time. A series
 * whose own day its rule does not give has no occurrence there, so it stays a stored candidate, as it was
 * before occurrences were matched (issue #1813).
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

/**
 * Whether `properties` are those of a recurring series whose rule gives the series' own day, so that the occurrence
 * of that day (virtual, materialized or cancelled) stands in for the series Event and the series Event is not a
 * candidate itself. A series whose own day the rule skips has no occurrence on it: the Event that carries the rule is
 * then the only thing on that day and matches as any stored Event does.
 */
function standsForItsFirstOccurrence(properties: Record<string, unknown>): boolean {
  const definition = readEventSeries(properties);
  return definition !== null && eventRecurrenceOccursOn(definition.rule, definition.startDate, definition.startDate);
}

/** Whether `interval` starts before the recording ends and ends after it starts; touching boundaries do not overlap. */
function overlapsRecording(
  interval: { startMs: number; endMs: number },
  recording: { startMs: number; endMs: number },
): boolean {
  return interval.startMs < recording.endMs && interval.endMs > recording.startMs;
}

/**
 * The virtual occurrences, at most one per series and day, of the live recurring Events of a matchable `type`
 * that overlap the recording `[startMs, endMs]`, ordered by interval start, then series id. The series are
 * expanded over the recording's local days with `expandEventOccurrences` and each occurrence's interval is
 * read and compared exactly as a stored Event's is (`readEventInterval`, strict overlap), so the two kinds of
 * candidate follow one rule. Only an occurrence that has no item is virtual: one with an item is a stored
 * Event, found by `listOverlappingEvents`, and a cancelled date (its occurrence item is in the Trash) gives no
 * entry at all. Writes nothing.
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

/**
 * What the card's `candidates` hold for an occurrence of a recurring Event that has no item yet (issue gh-1850):
 * the series Event and the day. It becomes an Events item only when the user confirms the card.
 */
export interface TranscriptOccurrenceCandidate {
  seriesId: string;
  occurrenceDate: string;
}

/** A candidate of a match: a stored Event (`TranscriptEventCandidate`) or a virtual occurrence. */
export type TranscriptMatchCandidate = TranscriptEventCandidate | TranscriptOccurrenceCandidate;

/** A virtual occurrence with the instant its interval starts, which orders the candidates. */
interface OccurrenceCandidate extends TranscriptOccurrenceCandidate {
  startMs: number;
}

/**
 * `ambiguous`: no edge and no card was written; see `createTranscriptEventCard`. Two or more stored Events
 * overlapped the recording, or at least one virtual occurrence did: a virtual occurrence is never linked
 * directly, even when it is the only candidate. The stored Events come first, then the occurrences.
 */
export interface AmbiguousTranscriptEventMatch {
  outcome: "ambiguous";
  candidates: TranscriptMatchCandidate[];
}

/** Whether `candidate` is a stored Event rather than a virtual occurrence. */
function isStoredCandidate(candidate: TranscriptMatchCandidate): candidate is TranscriptEventCandidate {
  return "id" in candidate;
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

/** Where a match stands once the transcript is known not to be converged: everything the candidate rule read. */
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
 * The read half of a match, shared by `matchTranscriptToEvent` and `readEventRecommendationContext`:
 * `alreadyLinked` or `alreadySuggested` when the transcript has converged, otherwise the Events that
 * overlap the recording, stored or as a virtual occurrence. Writes nothing (`readTranscriptEventEdges` may hold an
 * Event in the Trash `FOR SHARE`); the caller decides whether `transcript` is locked.
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

/** The wall-clock span of a proposed meeting: the recording's start and end in the tenant zone. */
interface MeetingSpan {
  date: string;
  timeFrom: string;
  timeTo: string;
  endDate: string | null;
}

/**
 * The recording `[startMs, startMs + durationSeconds]` as the Events fields `date`, `timeFrom`, `timeTo`
 * and `endDate` in the tenant zone (`clock`), minutes precision. `endDate` is set only when the end falls
 * on another local day than the start. An end that is not later than the start on the wall clock (a
 * recording shorter than a minute, or one that ends in the repeated hour of a DST change) is moved to one
 * minute after the start, because the Events rules refuse a `timeTo` that is not later than `timeFrom`.
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

/** The recording's local day and month, e.g. "14. 10." or "14/10", for the proposed meeting's name. */
async function newMeetingName(locale: string, date: string): Promise<string> {
  const [, month, day] = date.split("-").map(Number);
  return renderTranscriptionLabel(locale, "transcript.newMeeting.name", { day: day ?? 0, month: month ?? 0 });
}

/**
 * The project of the Event a card recommends, or `null` when there is no recommendation, the Event is
 * missing, in the Trash or in another database, or has no live project. An Event has at most one project.
 * No card creation calls it today: a card with a recommendation links the existing Event through a
 * relation envelope (issue #1848), and a card without one has no Event to take a project from. It is the
 * resolver for a new-meeting proposal that is built from a recommendation.
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
 * The create-Event proposal of a card that links no Event (issues #1818 and #1830): a meeting named `name`
 * when that is given, otherwise after the recording's local day and month ("Schůzka 14. 10." / "Meeting 14/10",
 * rendered in `locale`), with the recording's wall-clock `date`, `timeFrom` and `timeTo` in the tenant zone
 * (`YYYY-MM-DD`, `HH:mm`), `endDate` only when the recording crosses local midnight, and the `project`
 * relation when `projectId` is set. A blank `name` counts as none; the name is never empty, and an empty one
 * throws. Checked with `assertValidProposalEnvelope`, so a project that is not a live Projects item of the
 * tenant throws `ValidationError` here.
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
 * The name and language of the meeting a card proposes for `transcript` (issue #1830): the transcript's own
 * `name` when the user entered one, otherwise the meeting-notes title with its speaker tokens replaced, otherwise
 * `null` (then `buildNewMeetingEnvelope` names the meeting after the recording's day and month). The locale is
 * `users.locale` of the tenant's user, Czech without one.
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
 * Step 6 of the transcription pipeline (`match`): mechanical, no model call. Runs inside the
 * caller's transaction and row-locks the transcript first, so concurrent runs for the same
 * transcript serialize and every check below still holds when the write lands.
 *
 * A transcript that already has an edge to an Event that is not in the Trash, or already has its
 * suggestion card (found by `transcriptSuggestionIdempotencyKey`, whatever that card's status or
 * deletion), is left as it is — a re-run never writes a second edge or a second card. An edge to an
 * Event in the Trash is no link (issue #1743): the match goes on as for a transcript without an
 * Event. `readTranscriptEventEdges` holds that Event's row `FOR SHARE`, so a restore of it waits for
 * this transaction. Otherwise the candidates are the stored Events whose time interval overlaps the
 * recording (`listOverlappingEvents`: the tenant zone, `date`/`timeFrom` to `endDate ?? date`/`timeTo`,
 * touching boundaries do not overlap), the recording being `Transcripts.date` to that plus the duration,
 * and the virtual occurrences of recurring Events that overlap it (`listVirtualOccurrences`, issue gh-1850).
 * Exactly one stored candidate and no virtual one is linked directly, even when that Event already holds
 * other transcripts: an Event has many transcripts, and the database still allows a transcript only one
 * Event, so an edge to a trashed Event is deleted first, in this transaction (`releaseTrashedEventEdges`).
 * With no candidate it creates one `proposed` card with `sourceTranscript` pointing at the transcript and the
 * new-meeting proposal of `buildNewMeetingEnvelope` (no project: the card recommends no Event; named after
 * the transcript's own name, else its notes title, else the recording's day and month), and
 * leaves an edge to a trashed Event as it is. With two or more stored candidates, or any virtual occurrence,
 * it writes nothing and returns them as `ambiguous` (the stored Events first, then the occurrences), so the
 * caller can ask which one the recording belongs to and then call `createTranscriptEventCard` in this
 * transaction (issue #1848). The worker never materializes an occurrence: that happens when the user
 * confirms the card. The tenant zone is read and validated once, in this transaction; an invalid zone
 * propagates as a `ValidationError`.
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
 * stored Events overlap the recording, so no call is due (a virtual occurrence is not a candidate of the call);
 * otherwise the candidates, the rendered meeting notes and the locale. Writes nothing. A transcript without stored `meetingNotes` throws
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
 * Creates the one `proposed` card of a recording that `matchTranscriptToEvent` returned `ambiguous` for
 * (issues #1848 and gh-1850), in the caller's transaction, right after that call. The model never writes the
 * Event edge: the card is for the user to confirm.
 *
 * The proposal is, in this order: the `event` relation to the recommended Event, when the recommendation's
 * `eventId` is one of the stored `candidates` (it links the existing Event, so it proposes no project; a
 * virtual occurrence is never recommended); else, when the one candidate is a virtual occurrence, the `event`
 * relation to its synthetic id `<seriesId>@<date>` (`formatOccurrenceId`), which the confirm turns into an
 * Events item; else the new-meeting proposal of `buildNewMeetingEnvelope` without a project, because there is
 * no recommended Event to take one from. A `null` `eventId` keeps the model's reason with
 * `recommendedEventId` `null`; an id that is not a stored candidate drops the whole answer, so both are
 * `null`; a blank reason is `null`.
 *
 * The card is created under the idempotency key of `matchTranscriptToEvent`'s own card, with the display data
 * only in `context` (`transcriptEventCardContextSchema`), whose `candidates` are the given ones. A transcript
 * that already has that card throws `ConflictError` without writing: `matchTranscriptToEvent` reports
 * `alreadySuggested` for it first. The transcript is locked first. Returns the card id with the
 * recommendation as stored.
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
