import type { PoolClient } from "pg";
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
import { NotFoundError, ValidationError } from "../errors.js";
import { readTranscriptEventEdges, releaseTrashedEventEdges } from "./transcriptEventEdges.js";

/** Only these Events `type` values are matched against a recording; a plain `event` never is. */
const MATCHABLE_EVENT_TYPES = ["standup", "meeting"];

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
 * - `suggested`: zero or several candidates (Events whose time interval overlaps the recording), so a
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

interface EventInterval {
  id: string;
  startMs: number;
  endMs: number;
}

/**
 * The instants `[start, end]` of a stored Event, or `null` when the Event has no timed interval to
 * compare. The start is `date` at `timeFrom` and the end is `endDate ?? date` at `timeTo`, both
 * wall-clock values in the tenant zone (`clock`); an Event without `timeTo` is a point at its start.
 * All of them are user-owned free input, so they are parsed here rather than cast in SQL, where one
 * malformed value would fail the whole query. `null` covers: an all-day Event (no `timeFrom`); a
 * value `wallClockToInstant` refuses as a `ValidationError` (a malformed date or time); a `timeFrom`
 * of `24:00`, which ends a day rather than starting one; and an end before the start, which is no
 * interval. Any other failure propagates.
 */
function readEventInterval(
  clock: CalendarClock,
  row: { id: string; date: string | null; time_from: string | null; end_date: string | null; time_to: string | null },
): EventInterval | null {
  if (row.date === null || row.time_from === null || row.time_from === "24:00") return null;
  try {
    const startMs = clock.wallClockToInstant(row.date, row.time_from).toMillis();
    const endMs =
      row.time_to === null ? startMs : clock.wallClockToInstant(row.end_date ?? row.date, row.time_to).toMillis();
    return endMs < startMs ? null : { id: row.id, startMs, endMs };
  } catch (error) {
    if (error instanceof ValidationError) return null;
    throw error;
  }
}

/**
 * Ids of the live Events of a matchable `type` whose interval overlaps the recording `[startMs,
 * endMs]`, ordered by interval start and then id. The overlap is strict: an Event is a candidate when
 * its start is before `endMs` and its end is after `startMs`, so touching boundaries do not overlap.
 * An Event without `timeTo` is a point at its start, so it is a candidate only when that moment lies
 * strictly inside the recording. See `readEventInterval` for the Events that are left out.
 */
export async function listOverlappingEventIds(
  client: PoolClient,
  eventsDatabaseId: string,
  recording: { startMs: number; endMs: number },
  clock: CalendarClock,
): Promise<string[]> {
  const { rows } = await client.query<{
    id: string;
    date: string | null;
    time_from: string | null;
    end_date: string | null;
    time_to: string | null;
  }>(
    `SELECT id, properties ->> 'date' AS date, properties ->> 'timeFrom' AS time_from,
            properties ->> 'endDate' AS end_date, properties ->> 'timeTo' AS time_to
       FROM items
      WHERE database_id = $1 AND deleted_at IS NULL AND properties ->> 'type' = ANY($2::text[])`,
    [eventsDatabaseId, MATCHABLE_EVENT_TYPES],
  );
  return rows
    .flatMap((row) => readEventInterval(clock, row) ?? [])
    .filter((interval) => interval.startMs < recording.endMs && interval.endMs > recording.startMs)
    .sort((a, b) => a.startMs - b.startMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((interval) => interval.id);
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
 * recording (`listOverlappingEventIds`: the tenant zone, `date`/`timeFrom` to `endDate ?? date`/`timeTo`,
 * touching boundaries do not overlap), the recording being `Transcripts.date` to that plus the duration.
 * Exactly one candidate is linked directly, even when that Event already holds other transcripts: an
 * Event has many transcripts, and the database still allows a transcript only one Event, so an edge
 * to a trashed Event is deleted first, in this transaction (`releaseTrashedEventEdges`). Anything
 * else creates one `proposed` card with `sourceTranscript` pointing at the transcript and a
 * create-Event proposal whose `name` comes from the transcript and whose `date` is the recording's
 * date in the tenant zone (`YYYY-MM-DD`), and leaves an edge to a trashed Event as it is. The tenant
 * zone is read and validated once, in this transaction; an invalid zone propagates as a `ValidationError`.
 */
export async function matchTranscriptToEvent(
  client: PoolClient,
  input: MatchTranscriptToEventInput,
): Promise<TranscriptEventMatchOutcome> {
  const transcriptsDatabaseId = await requireDatabaseId(client, TRANSCRIPTS_MODULE_ID);
  const transcript = await itemsStore.lockItemById(client, transcriptsDatabaseId, input.transcriptId);
  if (!transcript || transcript.deletedAt)
    throw new NotFoundError(`Transcripts item '${input.transcriptId}' not found`, {
      resource: "item",
      itemId: input.transcriptId,
    });

  const eventPropertyId = await requirePropertyId(client, transcriptsDatabaseId, "event");
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
  const candidates = await listOverlappingEventIds(
    client,
    eventsDatabaseId,
    { startMs, endMs: startMs + input.durationSeconds * 1000 },
    clock,
  );

  const [onlyCandidate] = candidates;
  if (candidates.length === 1 && onlyCandidate) {
    await releaseTrashedEventEdges(client, { eventPropertyId, transcriptId: transcript.id });
    await createRelationWithClient(client, {
      relationPropertyId: eventPropertyId,
      callerItemId: transcript.id,
      targetItemId: onlyCandidate,
    });
    return "linked";
  }

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
  const card = await createItemWithClient(
    client,
    {
      databaseId: processingProposalsDatabaseId,
      idempotencyKey,
      properties: {
        kind: "transcript",
        proposal: envelope,
        ...aiProposalPatch({}, envelope),
        history: appendHistoryEntry(
          [],
          `${candidates.length} Events overlapped the recording's time interval, so none was linked; proposed a new Event.`,
        ),
        status: "proposed",
      },
    },
    { allowedSystemKeys: ["kind", "proposal", "aiProposal", "aiVersion", "history", "status"] },
  );
  const sourceTranscriptPropertyId = await requirePropertyId(client, processingProposalsDatabaseId, "sourceTranscript");
  await createRelationWithClient(
    client,
    { relationPropertyId: sourceTranscriptPropertyId, callerItemId: card.id, targetItemId: transcript.id },
    PROCESSING_PROPOSALS_RELATION_CONTEXT,
  );
  publishInboxCardChange(client, card.id, "created");
  return "suggested";
}
