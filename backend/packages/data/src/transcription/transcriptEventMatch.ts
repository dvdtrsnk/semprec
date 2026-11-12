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
import { PROCESSING_PROPOSALS_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { EVENTS_MODULE_ID, TRANSCRIPTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { wallClockToInstant } from "../calendarTime.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { getSystemTimezone } from "../systemSettings.js";
import { assertValidTimezone } from "../timezone.js";
import { readTranscriptEventEdges, releaseTrashedEventEdges } from "./transcriptEventEdges.js";

/** Only these Events `type` values are matched against a recording; a plain `event` never is. */
const MATCHABLE_EVENT_TYPES = ["standup", "meeting"];

/** How long before the recording started a matching Event may start: a meeting that began early, or a recording started late. */
const MATCH_WINDOW_LEAD_MS = 30 * 60 * 1000;

/**
 * An Events `date` carrying a time of day: a row written before issue #1598, or a transcript's `date`.
 * Since #1598 an Event stores a date-only `date` and its start in `timeFrom`.
 */
const DATE_WITH_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** A date-only Events `date`, whose start is its wall-clock `timeFrom` in the tenant zone (issue #1598). */
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The context a `transcript` card producer writes its card's `sourceTranscript` edge under. */
export const PROCESSING_PROPOSALS_RELATION_CONTEXT: SystemRelationWriteContext = {
  ownerProcess: PROCESSING_PROPOSALS_MODULE_ID,
};

export interface MatchTranscriptToEventInput {
  transcriptId: string;
  /** The recording's length, from step 1's checkpoint; the window ends this long after the transcript's `date`. */
  durationSeconds: number;
}

/**
 * - `linked`: exactly one candidate, now linked through the Transcripts <-> Events relation. The
 *   Event may already hold other transcripts: the parts of one meeting (issue #1464).
 * - `suggested`: zero or several candidates, so a `kind = 'transcript'` Processing proposal card
 *   was created instead.
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

function parseDateWithTime(value: unknown): number | null {
  if (typeof value !== "string" || !DATE_WITH_TIME_RE.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Live Events of a matchable `type` whose start lies inside `[startMs - 30 min, endMs]`, ordered by
 * id. An Event starts at its `date` when that carries a time of day (a row written before issue
 * #1598); otherwise a date-only `date` with a `timeFrom` starts at that wall-clock time in the tenant
 * zone (`wallClockToInstant`). An Event with neither has no start and is not a candidate. `date` and
 * `timeFrom` are user-owned free input, so they are parsed here rather than cast in SQL, where one
 * malformed value would fail the whole query: a value `wallClockToInstant` refuses as a
 * `ValidationError` leaves that Event out, and so does a `timeFrom` of `24:00`, which ends a day
 * rather than starting one. The tenant zone is read and validated once, in the caller's transaction,
 * when the first Event needs it; an invalid zone or any other failure propagates.
 */
async function listCandidateEventIds(
  client: PoolClient,
  eventsDatabaseId: string,
  startMs: number,
  endMs: number,
): Promise<string[]> {
  const { rows } = await client.query<{ id: string; date: string | null; time_from: string | null }>(
    `SELECT id, properties ->> 'date' AS date, properties ->> 'timeFrom' AS time_from FROM items
     WHERE database_id = $1 AND deleted_at IS NULL AND properties ->> 'type' = ANY($2::text[])
     ORDER BY id`,
    [eventsDatabaseId, MATCHABLE_EVENT_TYPES],
  );
  let zone: string | undefined;
  const candidates: string[] = [];
  for (const row of rows) {
    let at = parseDateWithTime(row.date);
    if (at === null && row.date !== null && DATE_ONLY_RE.test(row.date) && row.time_from !== null) {
      if (row.time_from === "24:00") continue;
      if (zone === undefined) {
        zone = await getSystemTimezone(client);
        assertValidTimezone(zone);
      }
      try {
        at = wallClockToInstant(row.date, row.time_from, zone).toMillis();
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        continue;
      }
    }
    if (at !== null && at >= startMs - MATCH_WINDOW_LEAD_MS && at <= endMs) candidates.push(row.id);
  }
  return candidates;
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
 * this transaction. Otherwise exactly one candidate is linked directly, even when that Event already
 * holds other transcripts: an Event has many transcripts, and the database still allows a transcript
 * only one Event, so an edge to a trashed Event is deleted first, in this transaction
 * (`releaseTrashedEventEdges`). Anything else creates one `proposed` card with `sourceTranscript`
 * pointing at the transcript and a create-Event proposal whose `name`/`date` come from the transcript,
 * and leaves an edge to a trashed Event as it is.
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

  const startMs = parseDateWithTime(transcript.properties.date);
  if (startMs === null)
    throw new NotFoundError(`Transcripts item '${transcript.id}' has no recording 'date' yet`, {
      resource: "item",
      itemId: transcript.id,
    });
  const eventsDatabaseId = await requireDatabaseId(client, EVENTS_MODULE_ID);
  const candidates = await listCandidateEventIds(
    client,
    eventsDatabaseId,
    startMs,
    startMs + input.durationSeconds * 1000,
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
    properties: { name: transcript.properties.name, type: "meeting", date: transcript.properties.date },
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
          `${candidates.length === 1 ? "1 Event" : `${candidates.length} Events`} matched the recording's time window, so none was linked; proposed a new Event.`,
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
  return "suggested";
}
