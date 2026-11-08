import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { withTransaction } from "../db/pool.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as blobsStore from "../blobs/blobsStore.js";
import { FILES_MODULE_ID, TRANSCRIPTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
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

const transcriptListCursorSchema = z.object({ at: z.iso.datetime({ precision: 6 }).nullable(), id: z.uuid() }).strict();

/** The request context of `GET /api/transcripts`: its query string is read from the request URL. */
interface TranscriptListRouteRequestContext {
  req: { url?: string };
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
      }),
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const nextCursor =
      rows.length > limit && last ? Buffer.from(JSON.stringify(last.cursor)).toString("base64url") : null;
    return { status: 200, body: { transcripts: page.map((row) => row.transcript), nextCursor } };
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
