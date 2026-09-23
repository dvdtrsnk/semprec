import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { loadModuleCatalogs, resolveCatalogLabel, type ModuleCatalogs } from "@semprec/module-registry";
import { withTransaction } from "../db/pool.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as blobsStore from "../blobs/blobsStore.js";
import { FILES_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { readBlobId } from "./transcriptionActions.js";
import { enqueueTranscriptionJob, findTranscriptionJobId } from "./transcriptionJob.js";
import { listTranscriptSpeakers } from "./transcriptionSpeakerEdges.js";
import { toManifestLocale } from "../manifest/catalogResolution.js";

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

/** `GET /api/transcripts/:id/speakers`'s request context: also reads the caller's locale, which the REST adapter supplies with every authenticated request. */
interface SpeakersRouteRequestContext {
  params: Record<string, string>;
  identity: { user: { locale: string } };
}

const transcriptIdSchema = z.string().uuid();

let speakerCatalogsPromise: Promise<ModuleCatalogs> | undefined;

/**
 * Lazily loaded once per process — `transcription/i18n/{cs,en}.json` never changes at runtime. A
 * failed load is not cached, so the next request retries instead of failing until restart.
 */
function getSpeakerCatalogs(): Promise<ModuleCatalogs> {
  speakerCatalogsPromise ??= loadModuleCatalogs(import.meta.url).catch((error: unknown) => {
    speakerCatalogsPromise = undefined;
    throw error;
  });
  return speakerCatalogsPromise;
}

/** One speaker key as a client shows it: the mapped person's name, or the localized "Speaker N". */
interface SpeakerEnvelope {
  speaker: string;
  label: string;
  personId: string | null;
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

    const catalogs = await getSpeakerCatalogs();
    const unmappedTemplate = resolveCatalogLabel(
      null,
      catalogs[toManifestLocale(ctx.identity.user.locale)],
      catalogs.en,
      "transcript.speaker.unmappedLabel",
    );
    const body: { speakers: SpeakerEnvelope[] } = {
      speakers: speakers.map((entry) => ({
        speaker: entry.speaker,
        label: entry.person?.name ?? unmappedTemplate.replace("{ordinal}", String(entry.ordinal)),
        personId: entry.person?.id ?? null,
      })),
    };
    return { status: 200, body };
  };
}
