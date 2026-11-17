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
import { createActionItemTask, listEventActionItemProposals, removeActionItemTask } from "./transcriptActionItems.js";
import { assignTranscriptSpeaker, listSpeakerCandidates } from "./transcriptSpeakerAssignment.js";
import type { CustomRouteResult, RouteParams, RouteBody, RouteUser, RouteLocale, RouteUrl } from "../customRoute.js";
import { requestUrl, requireUuidParam } from "../customRoute.js";

const requestBodySchema = z.object({ fileItemId: z.string().uuid() });
async function resolveFilesDatabaseId(client: PoolClient): Promise<string> {
  const database = await getDatabaseByModuleId(client, FILES_MODULE_ID);
  if (!database) throw new NotFoundError(`Database for module '${FILES_MODULE_ID}' not found`);
  return database.id;
}

/** Validated here so a non-UUID never reaches a `uuid` column and surfaces as a `22P02` 500 instead of a 400. */
function requireFileItemId(body: unknown): string {
  const parsed = requestBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError("'fileItemId' must be a UUID string", { field: "fileItemId" });
  }
  return parsed.data.fileItemId;
}

/**
 * `POST /api/transcriptions` for an `audio/*` or `video/*` file, not gated on attachment edges since
 * the caller asks for this file on purpose. The enqueue is idempotent on its key; the existing-job
 * check in the same transaction only turns an obvious repeat into a `409`.
 */
export function createCreateTranscriptionRouteHandler(pool: Pool) {
  return async (ctx: RouteParams & RouteBody): Promise<CustomRouteResult> => {
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
 * `POST /api/transcriptions/:id/rerun`: re-enqueues under the original key, so the job resumes the
 * same row from its checkpoints and repeats no paid stage. Writes no item. A `locked` row is
 * `403 transcription_locked`; the `item_automation` row stays locked for the transaction, so a
 * concurrent lock lands before the check or waits for the commit (and the job re-checks every step).
 * Any other status, `pending` included, replaces a still-queued job under the same key. A row with no
 * `item_automation` row or Files `link` is a 404.
 */
export function createRerunTranscriptionRouteHandler(pool: Pool) {
  return async (ctx: RouteParams & RouteBody): Promise<CustomRouteResult> => {
    const transcriptId = requireUuidParam(ctx.params, "id");
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

/** Labels are composed from the `speakers` edges at read time; mappings are written through the generic relation endpoint. */
export function createTranscriptSpeakersRouteHandler(pool: Pool) {
  return async (ctx: RouteParams & RouteLocale): Promise<CustomRouteResult> => {
    const id = requireUuidParam(ctx.params, "id");
    const speakers = await withTransaction(pool, (client) => listTranscriptSpeakers(client, id));

    const labeled = await labelTranscriptSpeakers(speakers, ctx.identity.user.locale);
    const body = { speakers: labeled.map(({ speaker, label, personId }) => ({ speaker, label, personId })) };
    return { status: 200, body };
  };
}

export function createTranscriptDetailRouteHandler(pool: Pool) {
  return async (ctx: RouteParams & RouteLocale): Promise<CustomRouteResult> => {
    const id = requireUuidParam(ctx.params, "id");
    return {
      status: 200,
      body: await withTransaction(pool, (client) => readTranscriptDetail(client, id, ctx.identity.user.locale)),
    };
  };
}

/** A canonical decimal within the `integer` column `action_item_id` (0 to 2147483647). */
const actionItemIdSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,9})$/)
  .transform(Number)
  .refine((value) => value <= 2_147_483_647);

const actionItemStateBodySchema = z.object({ state: z.literal("noted").nullable() });

/**
 * `noted` follows an item, `null` reopens it. Under the transcript row lock, `noted` stores the owner
 * speaker's mapped live person (or `null`) and rewrites only when that owner changed. Missing or
 * foreign transcripts and items answer one 404; an `added` item is refused (`alreadyAdded`).
 */
export function createTranscriptActionItemStateRouteHandler(pool: Pool) {
  return async (ctx: RouteParams & RouteBody): Promise<CustomRouteResult> => {
    const transcriptId = requireUuidParam(ctx.params, "id");
    const parsedActionItemId = actionItemIdSchema.safeParse(ctx.params.actionItemId);
    if (!parsedActionItemId.success) {
      throw new ValidationError("'actionItemId' must be a non-negative integer", { field: "actionItemId" });
    }
    const parsedBody = actionItemStateBodySchema.safeParse(ctx.body);
    if (!parsedBody.success) throw new ValidationError("'state' must be \"noted\" or null", { field: "state" });
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

/** A malformed value is `validation_failed` on its field. */
function readActionItemTaskPath(params: Record<string, string>): { transcriptId: string; actionItemId: number } {
  const id = requireUuidParam(params, "id");
  const parsedActionItemId = actionItemIdSchema.safeParse(params.actionItemId);
  if (!parsedActionItemId.success) {
    throw new ValidationError("'actionItemId' must be a non-negative integer", { field: "actionItemId" });
  }
  return { transcriptId: id, actionItemId: parsedActionItemId.data };
}

const actionItemTaskBodySchema = z.object({ name: z.string().optional(), date: z.iso.date().optional() });

/**
 * Body `{ name?, date? }` overrides the item's text and `due`. `201` when this call created the task,
 * `200` for an existing one, so repeated or concurrent calls create no second task.
 */
export function createTranscriptActionItemTaskRouteHandler(pool: Pool) {
  const queueAffinity = createActionQueueAffinity();
  return async (ctx: RouteParams & RouteBody & RouteUser & RouteLocale): Promise<CustomRouteResult> => {
    const path = readActionItemTaskPath(ctx.params);
    const parsedBody = actionItemTaskBodySchema.safeParse(ctx.body);
    if (!parsedBody.success) {
      const field = parsedBody.error.issues[0]?.path[0];
      throw new ValidationError("'name' must be a string and 'date' a calendar date YYYY-MM-DD", {
        field: typeof field === "string" ? field : "body",
      });
    }
    const { id: userId, locale } = ctx.identity.user;
    const { taskId, created } = await withTransaction(pool, (client) =>
      createActionItemTask(client, { ...path, ...parsedBody.data, locale, userId, queueAffinity }),
    );
    return { status: created ? 201 : 200, body: { taskId } };
  };
}

/** Answers the item's state afterwards, so a repeat answers the same. */
export function createTranscriptActionItemTaskRemoveRouteHandler(pool: Pool) {
  const queueAffinity = createActionQueueAffinity();
  return async (ctx: RouteParams & RouteBody & RouteUser & RouteLocale): Promise<CustomRouteResult> => {
    const path = readActionItemTaskPath(ctx.params);
    const body = await withTransaction(pool, (client) =>
      removeActionItemTask(client, { ...path, userId: ctx.identity.user.id, queueAffinity }),
    );
    return { status: 200, body };
  };
}

/** Other-tenant, unknown and trashed Events answer the same `not_found`. */
export function createEventTranscriptActionItemsRouteHandler(pool: Pool) {
  return async (ctx: RouteParams & RouteLocale): Promise<CustomRouteResult> => {
    const id = requireUuidParam(ctx.params, "id");
    const proposals = await withTransaction(pool, (client) =>
      listEventActionItemProposals(client, id, ctx.identity.user.locale),
    );
    if (proposals === null) throw new NotFoundError("Event not found");
    return { status: 200, body: proposals };
  };
}

const speakerKeySchema = z.string().min(1).max(256);

const speakerAssignmentBodySchema = z.object({ personId: z.uuid().nullable() });

/**
 * `{ personId: null }` clears the key. The label is the one the speakers route shows. Unknown or
 * other-tenant transcripts and people answer the same 404.
 */
export function createTranscriptSpeakerAssignRouteHandler(pool: Pool) {
  return async (ctx: RouteParams & RouteBody & RouteUser & RouteLocale): Promise<CustomRouteResult> => {
    const transcriptId = requireUuidParam(ctx.params, "id");
    const parsedSpeaker = speakerKeySchema.safeParse(ctx.params.speaker);
    if (!parsedSpeaker.success) {
      throw new ValidationError("'speaker' must be a speaker key of 1 to 256 characters", { field: "speaker" });
    }
    const parsedBody = speakerAssignmentBodySchema.safeParse(ctx.body);
    if (!parsedBody.success) {
      const field = parsedBody.error.issues[0]?.path[0];
      throw new ValidationError("'personId' must be a UUID string or null", {
        field: typeof field === "string" ? field : "body",
      });
    }
    const speakers = await withTransaction(pool, (client) =>
      assignTranscriptSpeaker(client, {
        transcriptId,
        speaker: parsedSpeaker.data,
        personId: parsedBody.data.personId,
        userId: ctx.identity.user.id,
      }),
    );
    const labeled = (await labelTranscriptSpeakers(speakers, ctx.identity.user.locale)).find(
      (entry) => entry.speaker === parsedSpeaker.data,
    );
    // The assignment refuses a key the transcript does not have, so the key is among the speakers it read back.
    if (!labeled) throw new Error("The assigned speaker is missing from the transcript's speakers");
    return { status: 200, body: { speaker: labeled.speaker, label: labeled.label, personId: labeled.personId } };
  };
}

/** `GET /api/transcripts/:id/speaker-candidates`; 404 as for the assignment route. */
export function createTranscriptSpeakerCandidatesRouteHandler(pool: Pool) {
  return async (ctx: RouteParams & RouteLocale): Promise<CustomRouteResult> => {
    const id = requireUuidParam(ctx.params, "id");
    const candidates = await withTransaction(pool, (client) => listSpeakerCandidates(client, id));
    return { status: 200, body: candidates };
  };
}

const transcriptListCursorSchema = z.object({ at: z.iso.datetime({ precision: 6 }).nullable(), id: z.uuid() }).strict();

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

/** An unknown, foreign or non-live filter id matches nothing, so the list is empty rather than an error. */
export function createTranscriptListRouteHandler(pool: Pool) {
  return async (ctx: RouteLocale & RouteUrl): Promise<CustomRouteResult> => {
    const url = requestUrl(ctx.req);
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
 * One comma-separated parameter of 1 to `MAX_SUMMARY_EVENT_IDS` distinct UUIDs (case-insensitive),
 * returned as written. Anything else is the same `validation_failed`.
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
 * One statement. Counts live transcripts (and `done` ones) per live Event of the tenant in scope;
 * keyed by lower-case event id, only for events with at least one transcript.
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

/** One key per requested id as written; an unknown, other-tenant, trashed or non-Event id answers zeros. */
export function createTranscriptSummariesRouteHandler(pool: Pool) {
  return async (ctx: RouteUrl): Promise<CustomRouteResult> => {
    const eventIds = readSummaryEventIds(requestUrl(ctx.req));
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
 * The pairing and speaker cards. Each is locked in id order and rejected through the proposal owner's
 * own reject, so a card settled meanwhile is left as it is.
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

/**
 * `DELETE /api/transcripts/:id`: one transaction trashes the recording as a unit, in the pipeline's
 * lock order (source Files item, then transcript): trashes the source, rejects open cards, trashes the
 * transcript and checks it still links the trashed source, else everything rolls back. Both trashes
 * share `now()`, the epoch `transcriptRestoreHook` restores them by. Already-trashed items are left,
 * so a repeat changes nothing. A running pipeline stops at its next check of the trashed items. The deleting user is
 * the writer of every trash it causes.
 */
export function createTranscriptDeleteRouteHandler(
  pool: Pool,
  queueAffinity: ActionQueueAffinity = createActionQueueAffinity(),
) {
  return async (ctx: RouteParams & RouteUser): Promise<CustomRouteResult> => {
    const transcriptId = requireUuidParam(ctx.params, "id");
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
