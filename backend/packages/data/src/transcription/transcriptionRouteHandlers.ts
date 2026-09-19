import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/pool.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { FILES_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { NotFoundError, ValidationError } from "../errors.js";
import type { ItemRow } from "../types.js";
import { enqueueTranscriptionJob, findTranscriptionJobId } from "./transcriptionJob.js";

/**
 * Duck-typed the same way `inboxRouteHandlers.ts` is: matches `semprec-api`'s
 * `AdapterRequestContext`/`AdapterHandlerResult` structurally, with no dependency on that
 * service's HTTP types from this package.
 */
interface CustomRouteRequestContext {
  params: Record<string, string>;
  body: unknown;
}

type CustomRouteResult = { status: number; item: ItemRow } | { status: number; body: unknown };

async function resolveFilesDatabaseId(client: PoolClient): Promise<string> {
  const database = await getDatabaseByModuleId(client, FILES_MODULE_ID);
  if (!database) throw new NotFoundError(`Database for module '${FILES_MODULE_ID}' not found`);
  return database.id;
}

function requireFileItemId(body: unknown): string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ValidationError("Request body must be a JSON object");
  }
  const fileItemId = (body as Record<string, unknown>).fileItemId;
  if (typeof fileItemId !== "string" || fileItemId.length === 0) {
    throw new ValidationError("'fileItemId' must be a non-empty string", { field: "fileItemId" });
  }
  return fileItemId;
}

/**
 * `POST /api/transcriptions` (issue #180): explicitly requests a transcription for an
 * audio/video/legacy Files item — unlike the Files `onItemEvent:create` trigger, this is not
 * restricted to `audio/*` or gated on the Emails.attachments edge, since the caller is asking for
 * this exact file on purpose. Uses the same job/key scheme as the trigger
 * (`transcriptionJobKey`), so a file already queued by either path converges onto one job either
 * way. The existing-job check and the enqueue run in the same transaction (state-writes: the
 * guard and the write it gates must not straddle a transaction boundary) — a concurrent duplicate
 * request still converges on one job either way, since `enqueueJob`'s `jobKeyMode: 'replace'`
 * default is itself idempotent on the key; this check exists to give the caller a `409` instead of
 * a silent `202`-equivalent when it's clearly a repeat.
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
