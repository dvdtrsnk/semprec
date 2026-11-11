import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { withTransaction, type Queryable } from "../db/pool.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as blobsStore from "../blobs/blobsStore.js";
import { EVENTS_MODULE_ID, FILES_MODULE_ID, TRANSCRIPTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { getRelationDefinitionByPropertyId, listRelationsForItem, otherSide } from "../chokePoint/relationsStore.js";
import { itemDeleteWithClient } from "../chokePoint/itemTrash.js";
import { rejectProposalWithClient } from "../inbox/proposalActions.js";
import { createActionQueueAffinity, type ActionQueueAffinity } from "../scheduler/actions.js";
import { PROCESSING_PROPOSALS_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { lockItemAutomation } from "../library/itemAutomationStore.js";
import { readBlobId } from "./transcriptionActions.js";
import {
  enqueueTranscriptionJob,
  findTranscriptionJobId,
  readTranscriptionSourceFileItemId,
} from "./transcriptionJob.js";
import { listTranscriptSpeakers } from "./transcriptionSpeakerEdges.js";
import { labelTranscriptSpeakers, readTranscriptDetail } from "./transcriptDetail.js";
import { listTranscriptsPage, TRANSCRIPT_PAIRINGS, type TranscriptListCursor } from "./transcriptListQuery.js";
import { parseStoredMeetingNotes } from "./meetingNotesRendering.js";
import { TRANSCRIPT_MEETING_NOTES_COMPUTED_KEY } from "./transcriptionComputedKeys.js";
import { clearActionItemState, listActionItemStates, setActionItemState } from "./transcriptActionItemStates.js";

/**
 * Duck-typed the same way `inboxRouteHandlers.ts` is: matches `semprec-api`'s
 * `AdapterRequestContext`/`AdapterHandlerResult` structurally, with no dependency on that
 * service's HTTP types from this package.
 */
interface CustomRouteRequestContext {
  params: Record<string, string>;
  body: unknown;
}

type CustomRouteResult = { status: number; body: unknown };

const requestBodySchema = z.object({ fileItemId: z.string().uuid() });
const transcriptIdSchema = z.string().uuid();

async function resolveFilesDatabaseId(client: PoolClient): Promise<string> {
  const database = await getDatabaseByModuleId(client, FILES_MODULE_ID);
  if (!database) throw new NotFoundError(`Database for module '${FILES_MODULE_ID}' not found`);
  return database.id;
}

/**
 * Rejects a non-UUID `fileItemId` here rather than letting it reach `getItemById`/
 * `findTranscriptionJobId`'s `uuid`-typed columns, where Postgres would throw `22P02 invalid
 * input syntax for type uuid` and surface as an unhandled 500 instead of a 400.
 */
function requireFileItemId(body: unknown): string {
  const parsed = requestBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError("'fileItemId' must be a UUID string", { field: "fileItemId" });
  }
  return parsed.data.fileItemId;
}

/**
 * `POST /api/transcriptions` (issue #180): explicitly requests a transcription for an
 * audio/video file — the same `audio/*` mime-type gate the Files `onItemEvent:create` trigger
 * uses (see `createFilesTranscriptionTriggerAction`'s own `readBlobId`/mime check), widened to
 * also accept `video/*`, since the issue's Task names "audio/video/legacy files" as this
 * endpoint's scope — "legacy" meaning a pre-existing audio/video file the create-time trigger
 * never saw, not a distinct mime category. Unlike the trigger, this is not gated on the
 * Emails.attachments edge, since the caller is asking for this exact file on purpose. Uses the
 * same job/key scheme as the trigger (`transcriptionJobKey`), so a file already queued by either
 * path converges onto one job either way. The existing-job check and the enqueue run in the same
 * transaction (state-writes: the guard and the write it gates must not straddle a transaction
 * boundary) — a concurrent duplicate request still converges on one job either way, since
 * `enqueueJob`'s `jobKeyMode: 'replace'` default is itself idempotent on the key; this check
 * exists to give the caller a `409` instead of a silent `202`-equivalent when it's clearly a
 * repeat.
 */
export function createCreateTranscriptionRouteHandler(pool: Pool) {
  return async (ctx: CustomRouteRequestContext): Promise<CustomRouteResult> => {
    const fileItemId = requireFileItemId(ctx.body);
    return withTransaction(pool, async (client) => {
      const filesDatabaseId = await resolveFilesDatabaseId(client);
      const fileItem = await itemsStore.getItemById(client, filesDatabaseId, fileItemId);
      if (!fileItem) {
        throw new NotFoundError(`Files item '${fileItemId}' not found`, { resource: "item", itemId: fileItemId });
      }

      const blobId = readBlobId(fileItem.properties);
      const blob = blobId ? await blobsStore.getBlob(client, blobId) : null;
      if (!blob || !(blob.mimeType.startsWith("audio/") || blob.mimeType.startsWith("video/"))) {
        throw new ValidationError("File must be an audio or video file to request a transcription", {
          field: "fileItemId",
        });
      }

      const existingJobId = await findTranscriptionJobId(client, fileItemId);
      if (existingJobId) {
        return {
          status: 409,
          body: { error: { code: "transcription_exists", details: { id: existingJobId } } },
        };
      }

      await enqueueTranscriptionJob(client, { fileItemId });
      return { status: 202, body: { fileItemId } };
    });
  };
}

/**
 * `POST /api/transcriptions/:id/rerun` (issue #186): re-enqueues the transcription of the
 * Transcriptions row `:id` under its original key, `transcription-job:${fileItemId}` with
 * `fileItemId` read from the row's `link`, so the job resumes the same row from its checkpoints
 * and repeats no paid stage. Performs no item write. A row a user set to `locked` is refused with
 * `403 transcription_locked`; the `item_automation` row is locked for the rest of the transaction,
 * so a lock set concurrently either lands before this check or waits for the enqueue to commit —
 * and the job itself re-checks the lock in every step. Every other status is accepted, `pending`
 * included: a still-queued job for the row is replaced under the same key (#180's `replace`
 * contract) with a fresh 3-attempt batch, so the row still has exactly one runnable job, which
 * resumes from the same checkpoints. A row that is not a pipeline transcription
 * (no `item_automation` row, or no Files item `link`) has no job to rerun and is a 404.
 */
export function createRerunTranscriptionRouteHandler(pool: Pool) {
  return async (ctx: CustomRouteRequestContext): Promise<CustomRouteResult> => {
    const parsedId = transcriptIdSchema.safeParse(ctx.params.id);
    if (!parsedId.success) throw new ValidationError("'id' must be a UUID string", { field: "id" });
    const transcriptId = parsedId.data;
    return withTransaction(pool, async (client) => {
      const transcripts = await getDatabaseByModuleId(client, TRANSCRIPTS_MODULE_ID);
      if (!transcripts) throw new NotFoundError(`Database for module '${TRANSCRIPTS_MODULE_ID}' not found`);
      const transcript = await itemsStore.getItemById(client, transcripts.id, transcriptId);
      if (!transcript) {
        throw new NotFoundError(`Transcriptions item '${transcriptId}' not found`, {
          resource: "item",
          itemId: transcriptId,
        });
      }

      const automation = await lockItemAutomation(client, transcriptId);
      const fileItemId = readTranscriptionSourceFileItemId(transcript.properties.link);
      if (!automation || !fileItemId) {
        throw new NotFoundError(`Transcriptions item '${transcriptId}' has no transcription job to rerun`, {
          resource: "transcription",
          itemId: transcriptId,
        });
      }
      if (automation.status === "locked") {
        throw new ForbiddenError(
          `Transcriptions item '${transcriptId}' is locked`,
          { itemId: transcriptId },
          "transcription_locked",
        );
      }

      await enqueueTranscriptionJob(client, { fileItemId });
      return { status: 202, body: { id: transcriptId, fileItemId } };
    });
  };
}

/** `GET /api/transcripts/:id/speakers`'s request context: also reads the caller's locale, which the REST adapter supplies with every authenticated request. */
interface SpeakersRouteRequestContext {
  params: Record<string, string>;
  identity: { user: { locale: string } };
}

/**
 * `GET /api/transcripts/:id/speakers` (issue #185): the transcript's speaker keys in order of first
 * appearance, each with the display label a client renders it under — the mapped person's name, or
 * `transcript.speaker.unmappedLabel` ("Speaker N" / "Mluvčí N") in the caller's `users.locale` for
 * a key with no mapping, and for a mapped person with no name. Composed from the `speakers` edges
 * at read time, so a mapping change shows here without `computed.segments` ever being rewritten.
 * Mapping itself is written through the generic relation endpoint, not here.
 */
export function createTranscriptSpeakersRouteHandler(pool: Pool) {
  return async (ctx: SpeakersRouteRequestContext): Promise<CustomRouteResult> => {
    const parsedId = transcriptIdSchema.safeParse(ctx.params.id);
    if (!parsedId.success) throw new ValidationError("'id' must be a UUID string", { field: "id" });
    const speakers = await withTransaction(pool, (client) => listTranscriptSpeakers(client, parsedId.data));

    const labeled = await labelTranscriptSpeakers(speakers, ctx.identity.user.locale);
    const body = { speakers: labeled.map(({ speaker, label, personId }) => ({ speaker, label, personId })) };
    return { status: 200, body };
  };
}

export function createTranscriptDetailRouteHandler(pool: Pool) {
  return async (ctx: SpeakersRouteRequestContext): Promise<CustomRouteResult> => {
    const parsedId = transcriptIdSchema.safeParse(ctx.params.id);
    if (!parsedId.success) throw new ValidationError("'id' must be a UUID string", { field: "id" });
    return {
      status: 200,
      body: await withTransaction(pool, (client) =>
        readTranscriptDetail(client, parsedId.data, ctx.identity.user.locale),
      ),
    };
  };
}

/** An action item id in the path: a canonical decimal within the `integer` column `action_item_id` (0 to 2147483647). */
const actionItemIdSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,9})$/)
  .transform(Number)
  .refine((value) => value <= 2_147_483_647);

const actionItemStateBodySchema = z.object({ state: z.literal("noted").nullable() });

/**
 * `PUT /api/transcripts/:id/action-items/:actionItemId/state` (issue #1754): the user follows one
 * action item of a transcript's meeting notes (`{ state: "noted" }`) or makes it open again
 * (`{ state: null }`). `actionItemId` is the item's position in the stored
 * `computed.meetingNotes.actionItems`. Answers `{ actionItemId, state }` with the state the item has
 * after the call.
 *
 * One transaction locks the transcript's item row, then reads the notes and the item's stored state
 * and writes. `noted` stores the row with `owner_person_id` set to the live person the transcript's
 * `speakers` edges map the item's `ownerSpeaker` to, or `null` for an item without an owner or an
 * unmapped speaker. `null` deletes the row; for an item that has no row it writes nothing. A repeated
 * call answers the same, and a repeated `noted` rewrites the row only when the owner it resolves
 * differs from the stored one.
 *
 * A non-UUID `id`, an `actionItemId` that is not such an integer and a body whose `state` is neither
 * `"noted"` nor `null` are `400 validation_failed` on that field. An unknown id, another tenant's id,
 * a transcript in the Trash and an `actionItemId` the notes do not have (a transcript without notes
 * has none) answer the same 404. An item whose state is `added` is refused for both values with
 * `400 validation_failed` (field `state`, reason `alreadyAdded`).
 */
export function createTranscriptActionItemStateRouteHandler(pool: Pool) {
  return async (ctx: CustomRouteRequestContext): Promise<CustomRouteResult> => {
    const parsedId = transcriptIdSchema.safeParse(ctx.params.id);
    if (!parsedId.success) throw new ValidationError("'id' must be a UUID string", { field: "id" });
    const parsedActionItemId = actionItemIdSchema.safeParse(ctx.params.actionItemId);
    if (!parsedActionItemId.success) {
      throw new ValidationError("'actionItemId' must be a non-negative integer", { field: "actionItemId" });
    }
    const parsedBody = actionItemStateBodySchema.safeParse(ctx.body);
    if (!parsedBody.success) throw new ValidationError("'state' must be \"noted\" or null", { field: "state" });
    const transcriptId = parsedId.data;
    const actionItemId = parsedActionItemId.data;
    const { state } = parsedBody.data;
    const notFound = () =>
      new NotFoundError("Transcript action item not found", {
        resource: "transcriptActionItem",
        transcriptId,
        actionItemId,
      });
    return withTransaction(pool, async (client) => {
      const transcripts = await getDatabaseByModuleId(client, TRANSCRIPTS_MODULE_ID);
      const transcript = transcripts && (await itemsStore.lockItemById(client, transcripts.id, transcriptId));
      if (!transcript || transcript.deletedAt) throw notFound();
      const notes = parseStoredMeetingNotes(transcript.computed[TRANSCRIPT_MEETING_NOTES_COMPUTED_KEY]);
      const actionItem = notes?.actionItems[actionItemId];
      if (!actionItem) throw notFound();

      const states = await listActionItemStates(client, transcriptId);
      const current = states.find((row) => row.actionItemId === actionItemId);
      if (current?.state === "added") {
        throw new ValidationError("The action item was added as a task", { field: "state", reason: "alreadyAdded" });
      }
      if (state === null) {
        if (current) await clearActionItemState(client, transcriptId, actionItemId);
        return { status: 200, body: { actionItemId, state: null } };
      }
      const ownerSpeaker = actionItem.ownerSpeaker;
      const speakers = ownerSpeaker === null ? [] : await listTranscriptSpeakers(client, transcriptId, transcript);
      const ownerPersonId = speakers.find((entry) => entry.speaker === ownerSpeaker)?.person?.id ?? null;
      const stored = await setActionItemState(client, {
        transcriptId,
        actionItemId,
        state,
        taskItemId: null,
        ownerPersonId,
      });
      return { status: 200, body: { actionItemId: stored.actionItemId, state: stored.state } };
    });
  };
}

const transcriptListCursorSchema = z.object({ at: z.iso.datetime({ precision: 6 }).nullable(), id: z.uuid() }).strict();

/** The request context of `GET /api/transcripts`: its query string is read from the request URL, the labels' locale from the user. */
interface TranscriptListRouteRequestContext {
  req: { url?: string };
  identity: { user: { locale: string } };
}

function readTranscriptListCursor(raw: string | null): TranscriptListCursor | null {
  if (raw === null) return null;
  if (raw.length > 256 || !/^[A-Za-z0-9_-]+$/.test(raw))
    throw new ValidationError("Invalid cursor", { field: "cursor" });
  let decoded: unknown;
  try {
    const bytes = Buffer.from(raw, "base64url");
    if (bytes.toString("base64url") !== raw) throw new Error("Invalid encoding");
    decoded = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ValidationError("Invalid cursor", { field: "cursor" });
  }
  const parsed = transcriptListCursorSchema.safeParse(decoded);
  if (!parsed.success) throw new ValidationError("Invalid cursor", { field: "cursor" });
  return parsed.data;
}

/**
 * `GET /api/transcripts` (issue #1636): the lightweight recordings list, `limit` (1-200, default 50)
 * transcripts per page with a keyset `nextCursor`. `eventId`, `personId` (a speaker or a participant,
 * issue #1581), `projectId` (issue #1581) and `pairing` filter it;
 * `order=asc` sorts by date ascending (default `desc`). A filter id that is unknown, foreign or not a
 * live item of its database matches nothing, so the list is empty rather than an error.
 */
export function createTranscriptListRouteHandler(pool: Pool) {
  return async (ctx: TranscriptListRouteRequestContext): Promise<CustomRouteResult> => {
    const url = new URL(ctx.req.url ?? "/", "http://localhost");
    const rawLimit = url.searchParams.get("limit");
    if (rawLimit !== null && !/^[0-9]{1,3}$/.test(rawLimit))
      throw new ValidationError("Invalid limit", { field: "limit" });
    const limit = rawLimit === null ? 50 : Number(rawLimit);
    if (limit < 1 || limit > 200) throw new ValidationError("Invalid limit", { field: "limit" });
    const cursor = readTranscriptListCursor(url.searchParams.get("cursor"));
    const rawOrder = url.searchParams.get("order") ?? "desc";
    if (rawOrder !== "asc" && rawOrder !== "desc") throw new ValidationError("Invalid order", { field: "order" });
    const uuidParam = (field: string) => {
      const value = url.searchParams.get(field);
      if (value !== null && !z.uuid().safeParse(value).success)
        throw new ValidationError(`Invalid ${field}`, { field });
      return value;
    };
    const eventId = uuidParam("eventId");
    const personId = uuidParam("personId");
    const projectId = uuidParam("projectId");
    const rawPairing = url.searchParams.get("pairing");
    const pairing = rawPairing === null ? null : TRANSCRIPT_PAIRINGS.find((value) => value === rawPairing);
    if (pairing === undefined) throw new ValidationError("Invalid pairing", { field: "pairing" });
    const rows = await withTransaction(pool, (client) =>
      listTranscriptsPage(client, {
        limit,
        order: rawOrder,
        cursor,
        filters: { eventId, personId, projectId, pairing },
        locale: ctx.identity.user.locale,
      }),
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const nextCursor =
      rows.length > limit && last ? Buffer.from(JSON.stringify(last.cursor)).toString("base64url") : null;
    return { status: 200, body: { transcripts: page.map((row) => row.transcript), nextCursor } };
  };
}

const MAX_SUMMARY_EVENT_IDS = 100;

/**
 * Reads `eventIds` of `GET /api/transcript-summaries`: one comma-separated parameter of 1 to
 * `MAX_SUMMARY_EVENT_IDS` distinct UUIDs, returned as the caller wrote them. A missing, repeated or
 * empty parameter, a longer list, an entry that is not a UUID and an id given twice (compared
 * without regard to letter case) are refused with the same `validation_failed`.
 */
function readSummaryEventIds(url: URL): string[] {
  const [raw, ...repeated] = url.searchParams.getAll("eventIds");
  const ids = raw === undefined || repeated.length > 0 ? [] : raw.split(",");
  const uuid = z.uuid();
  if (
    ids.length < 1 ||
    ids.length > MAX_SUMMARY_EVENT_IDS ||
    !ids.every((id) => uuid.safeParse(id).success) ||
    new Set(ids.map((id) => id.toLowerCase())).size !== ids.length
  ) {
    throw new ValidationError(`'eventIds' must be 1-${MAX_SUMMARY_EVENT_IDS} distinct UUIDs separated by commas`, {
      field: "eventIds",
    });
  }
  return ids;
}

interface TranscriptSummary {
  count: number;
  doneCount: number;
}

/**
 * One statement: it resolves the Transcripts `event` relation from the catalog and aggregates
 * `item_relations` joined with `items`. For each of `eventIds` that is a live Event of the tenant in
 * scope it counts the live transcripts linked to it through that relation, and how many of those
 * have status `done`. The map has an entry, keyed by the event id in lower case, for an event with
 * at least one such transcript and for no other id.
 */
async function countTranscriptsByEvent(client: Queryable, eventIds: string[]): Promise<Map<string, TranscriptSummary>> {
  const { rows } = await client.query<{ eventId: string; count: number; doneCount: number }>(
    `
WITH schema_ids AS (
  SELECT (SELECT id FROM databases WHERE tenant_id = app_tenant_default() AND system AND owner_module_id = $2) AS transcripts,
         (SELECT id FROM databases WHERE tenant_id = app_tenant_default() AND system AND owner_module_id = $3) AS events
), event_relation AS (
  SELECT rd.id, rd.property_id_a = p.id AS transcript_is_a
  FROM properties p JOIN relation_definitions rd ON rd.tenant_id = p.tenant_id AND p.id IN (rd.property_id_a, rd.property_id_b)
  WHERE p.tenant_id = app_tenant_default() AND p.database_id = (SELECT transcripts FROM schema_ids) AND p.key = 'event'
)
SELECT event.id AS "eventId", count(*)::int AS "count",
  (count(*) FILTER (WHERE transcript.properties->>'status' = 'done'))::int AS "doneCount"
FROM event_relation er
JOIN item_relations r ON r.tenant_id = app_tenant_default() AND r.relation_definition_id = er.id
JOIN items event ON event.tenant_id = app_tenant_default() AND event.database_id = (SELECT events FROM schema_ids)
  AND event.id = CASE WHEN er.transcript_is_a THEN r.item_b ELSE r.item_a END AND event.deleted_at IS NULL
JOIN items transcript ON transcript.tenant_id = app_tenant_default() AND transcript.database_id = (SELECT transcripts FROM schema_ids)
  AND transcript.id = CASE WHEN er.transcript_is_a THEN r.item_a ELSE r.item_b END AND transcript.deleted_at IS NULL
WHERE event.id = ANY($1::uuid[])
GROUP BY event.id
`,
    [eventIds, TRANSCRIPTS_MODULE_ID, EVENTS_MODULE_ID],
  );
  return new Map(rows.map((row) => [row.eventId, { count: row.count, doneCount: row.doneCount }]));
}

/** The request context of `GET /api/transcript-summaries`: its query string is read from the request URL. */
interface TranscriptSummariesRouteRequestContext {
  req: { url?: string };
}

/**
 * `GET /api/transcript-summaries?eventIds=<uuid,...>` (issue #1693): the transcript counts of the
 * given events in one call, for the journal's day. The body is `{ [eventId]: { count, doneCount } }`
 * with one key per requested id, as the caller wrote it. `count` is the event's live transcripts and
 * `doneCount` those with status `done`; a transcript in the Trash is in neither. An id that is
 * unknown, another tenant's, in the Trash or not an Event answers `{ count: 0, doneCount: 0 }`.
 */
export function createTranscriptSummariesRouteHandler(pool: Pool) {
  return async (ctx: TranscriptSummariesRouteRequestContext): Promise<CustomRouteResult> => {
    const eventIds = readSummaryEventIds(new URL(ctx.req.url ?? "/", "http://localhost"));
    const counted = await withTransaction(pool, (client) => countTranscriptsByEvent(client, eventIds));
    const body = Object.fromEntries(
      eventIds.map((id): [string, TranscriptSummary] => [
        id,
        counted.get(id.toLowerCase()) ?? { count: 0, doneCount: 0 },
      ]),
    );
    return { status: 200, body };
  };
}

/**
 * Rejects every open card of the transcript (kind `transcript`, status `proposed` or
 * `needsClarification`, linked through `sourceTranscript`): the pairing card and the speaker cards.
 * Each card is locked first, in id order, and rejected through the proposal owner's own reject, so a
 * card confirmed or rejected meanwhile is left as it is. Returns the ids it rejected.
 */
async function rejectOpenTranscriptCards(client: PoolClient, transcriptId: string): Promise<string[]> {
  const proposals = await getDatabaseByModuleId(client, PROCESSING_PROPOSALS_MODULE_ID);
  if (!proposals) throw new NotFoundError(`Database for module '${PROCESSING_PROPOSALS_MODULE_ID}' not found`);
  const property = await getPropertyByKey(client, proposals.id, "sourceTranscript");
  const definition = property && (await getRelationDefinitionByPropertyId(client, property.id));
  if (!definition) throw new NotFoundError("Relation definition for Processing proposals 'sourceTranscript' not found");
  const cardIds = (await listRelationsForItem(client, definition.id, transcriptId))
    .map((edge) => otherSide(edge, transcriptId))
    .sort();
  const rejected: string[] = [];
  for (const cardId of cardIds) {
    const card = await itemsStore.lockItemById(client, proposals.id, cardId);
    if (!card || card.deletedAt || card.properties.kind !== "transcript") continue;
    if (card.properties.status !== "proposed" && card.properties.status !== "needsClarification") continue;
    await rejectProposalWithClient(client, { processingProposalsDatabaseId: proposals.id }, card.id);
    rejected.push(card.id);
  }
  return rejected;
}

/** `DELETE /api/transcripts/:id`'s request context: the deleting user is the writer of every trash it causes. */
interface TranscriptDeleteRouteRequestContext {
  params: Record<string, string>;
  identity: { user: { id: string } };
}

/**
 * `DELETE /api/transcripts/:id` (issue #1642): one transaction trashes the recording as a unit into
 * the generic Trash, in the lock order the transcription pipeline uses for the pair (the source
 * Files item, then the transcript): it trashes the Files item the transcript's `link` names, rejects
 * the transcript's open cards, then trashes the transcript and checks that the locked transcript
 * still links the Files item it trashed; otherwise everything rolls back. Both trashes share the
 * transaction's `now()`, the epoch `transcriptRestoreHook` restores them together by. An item already
 * in the Trash is left as it is, so a repeat call changes nothing. An unknown id, an id of another
 * database and another tenant's id answer the same 404. A running pipeline stops on its own next
 * check of the trashed items (issue #1582).
 */
export function createTranscriptDeleteRouteHandler(
  pool: Pool,
  queueAffinity: ActionQueueAffinity = createActionQueueAffinity(),
) {
  return async (ctx: TranscriptDeleteRouteRequestContext): Promise<CustomRouteResult> => {
    const parsedId = transcriptIdSchema.safeParse(ctx.params.id);
    if (!parsedId.success) throw new ValidationError("'id' must be a UUID string", { field: "id" });
    const transcriptId = parsedId.data;
    const options = { queueAffinity, actingUserId: ctx.identity.user.id, writer: { writerKind: "user" as const } };
    return withTransaction(pool, async (client) => {
      const transcripts = await getDatabaseByModuleId(client, TRANSCRIPTS_MODULE_ID);
      if (!transcripts) throw new NotFoundError(`Database for module '${TRANSCRIPTS_MODULE_ID}' not found`);
      const transcript = await itemsStore.getItemById(client, transcripts.id, transcriptId);
      if (!transcript) throw new NotFoundError("Transcript not found", { resource: "item", itemId: transcriptId });
      const fileItemId = readTranscriptionSourceFileItemId(transcript.properties.link);
      if (fileItemId) await itemDeleteWithClient(client, await resolveFilesDatabaseId(client), fileItemId, options);
      await rejectOpenTranscriptCards(client, transcriptId);
      const deleted = await itemDeleteWithClient(client, transcripts.id, transcriptId, options);
      if (!deleted) throw new NotFoundError("Transcript not found", { resource: "item", itemId: transcriptId });
      if (readTranscriptionSourceFileItemId(deleted.properties.link) !== fileItemId) {
        throw new ConflictError("The transcript's source file changed during the delete", { field: "link" });
      }
      return { status: 200, body: { id: transcriptId, fileItemId } };
    });
  };
}
