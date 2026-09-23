import type { PoolClient } from "pg";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import {
  createItemWithClient,
  createRelationWithClient,
  type SystemRelationWriteContext,
} from "../chokePoint/chokePoint.js";
import { appendHistoryEntry, assertValidProposalEnvelope, type ProposalEnvelope } from "../inbox/inboxTickAction.js";
import { PROCESSING_PROPOSALS_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { EVENTS_MODULE_ID, TRANSCRIPTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { NotFoundError } from "../errors.js";

/** Only these Events `type` values are matched against a recording; a plain `event` never is. */
const MATCHABLE_EVENT_TYPES = ["standup", "meeting"];

/** How long before the recording started a matching Event may start: a meeting that began early, or a recording started late. */
const MATCH_WINDOW_LEAD_MS = 30 * 60 * 1000;

/** An Events `date` carrying a time of day; a date-only value has no time to fall inside the window. */
const DATE_WITH_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

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
 * - `linked`: exactly one candidate, now linked through the Transcripts <-> Events 1:1 relation.
 * - `suggested`: zero or several candidates (or a single one already linked to another
 *   transcript), so a `kind = 'transcript'` Processing proposal card was created instead.
 * - `alreadyLinked` / `alreadySuggested`: an earlier run already reached one of the above;
 *   nothing was written.
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
 * Live Events of a matchable `type` whose `date` lies inside `[startMs - 30 min, endMs]`,
 * ordered by id. `date` is user-owned free input, so it is parsed here rather than cast in SQL,
 * where one malformed value would fail the whole query.
 */
async function listCandidateEventIds(
  client: PoolClient,
  eventsDatabaseId: string,
  startMs: number,
  endMs: number,
): Promise<string[]> {
  const { rows } = await client.query<{ id: string; date: string | null }>(
    `SELECT id, properties ->> 'date' AS date FROM items
     WHERE database_id = $1 AND deleted_at IS NULL AND properties ->> 'type' = ANY($2::text[])
     ORDER BY id`,
    [eventsDatabaseId, MATCHABLE_EVENT_TYPES],
  );
  return rows
    .filter((row) => {
      const at = parseDateWithTime(row.date);
      return at !== null && at >= startMs - MATCH_WINDOW_LEAD_MS && at <= endMs;
    })
    .map((row) => row.id);
}

/**
 * Step 6 of the transcription pipeline (`match`): mechanical, no model call. Runs inside the
 * caller's transaction and row-locks the transcript first, so concurrent runs for the same
 * transcript serialize and every check below still holds when the write lands.
 *
 * A transcript that already has an Event edge, or already has its suggestion card (found by
 * `transcriptSuggestionIdempotencyKey`, whatever that card's status or deletion), is left as it
 * is — a re-run never writes a second edge or a second card. Otherwise exactly one candidate is
 * linked directly; anything else creates one `proposed` card with `sourceTranscript` pointing at
 * the transcript and a create-Event proposal whose `name`/`date` come from the transcript. A
 * single candidate already linked to another transcript cannot take a second edge under the 1:1
 * relation, so it gets the card too rather than a guess.
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
  const transcriptEdges = await relationsStore.listRelationsForItem(client, eventRelation.id, transcript.id);
  if (transcriptEdges.length > 0) return "alreadyLinked";

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
    const eventEdges = await relationsStore.listRelationsForItem(client, eventRelation.id, onlyCandidate);
    if (eventEdges.length === 0) {
      await createRelationWithClient(client, {
        relationPropertyId: eventPropertyId,
        callerItemId: transcript.id,
        targetItemId: onlyCandidate,
      });
      return "linked";
    }
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
        history: appendHistoryEntry(
          [],
          `${candidates.length} Events matched the recording's time window, so none was linked; proposed a new Event.`,
        ),
        status: "proposed",
      },
    },
    { allowedSystemKeys: ["kind", "proposal", "history", "status"] },
  );
  const sourceTranscriptPropertyId = await requirePropertyId(client, processingProposalsDatabaseId, "sourceTranscript");
  await createRelationWithClient(
    client,
    { relationPropertyId: sourceTranscriptPropertyId, callerItemId: card.id, targetItemId: transcript.id },
    PROCESSING_PROPOSALS_RELATION_CONTEXT,
  );
  return "suggested";
}
