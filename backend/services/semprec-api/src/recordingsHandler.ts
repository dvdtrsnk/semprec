import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { z } from "zod";
import {
  ChokePointError,
  MaxBytesExceededError,
  NotFoundError,
  ValidationError,
  EVENTS_MODULE_ID,
  FILES_MODULE_ID,
  getDatabaseByModuleId,
  getItemById,
  ingestUploadedFileWithTransaction,
  recordRecordingIntake,
  withTransaction,
  type BlobStorageWriter,
} from "@semprec/data";
import { runInTenant } from "@semprec/shared";
import { authenticateRequest } from "./authHandler.js";
import { optionalHeader, requireHeader } from "./adapter/requestValidation.js";
import { statusForError, toErrorResponseBody } from "./adapter/errorContract.js";
import { sendJson } from "./adapter/http.js";
import { logger } from "./logger.js";

export function createRecordingsRequestListener(
  pool: Pool,
  options: { storage: BlobStorageWriter; maxFileSizeBytes: number },
) {
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let streaming = false;
    try {
      const identity = await authenticateRequest(pool, req);
      await runInTenant(identity.tenantId, async () => {
        const contentType = requireHeader(req, "Content-Type");
        if (!/^(audio|video)\/[a-z0-9!#$&^_.+-]+(?:\s*;.*)?$/i.test(contentType))
          throw new ValidationError("Invalid content type", { field: "Content-Type" });
        const filename = requireHeader(req, "X-Filename");
        if (Buffer.byteLength(filename, "utf8") > 200)
          throw new ValidationError("Invalid filename", { field: "X-Filename" });
        const rawEventId = optionalHeader(req, "X-Event-Id");
        const eventId = rawEventId === undefined ? null : z.uuid().safeParse(rawEventId);
        if (eventId !== null && !eventId.success) throw new ValidationError("Invalid event", { field: "X-Event-Id" });
        const recordedAt = optionalHeader(req, "X-Recorded-At") ?? null;
        if (recordedAt !== null && !z.iso.datetime({ offset: true }).safeParse(recordedAt).success)
          throw new ValidationError("Invalid recording time", { field: "X-Recorded-At" });
        const length = req.headers["content-length"];
        if (
          typeof length === "string" &&
          Number.isFinite(Number(length)) &&
          Number(length) > options.maxFileSizeBytes
        ) {
          res.shouldKeepAlive = false;
          sendJson(res, 413, { error: { code: "payload_too_large" } });
          return;
        }
        const requested = eventId === null ? null : eventId.data;
        const preflight = await withTransaction(pool, async (client) => {
          const files = await getDatabaseByModuleId(client, FILES_MODULE_ID);
          const events = await getDatabaseByModuleId(client, EVENTS_MODULE_ID);
          if (!files || !events) throw new Error("Recording catalog is missing");
          const event = requested ? await getItemById(client, events.id, requested) : null;
          if (requested && !event) throw new NotFoundError("Event not found");
          return { filesId: files.id, eventId: event && !event.deletedAt ? event.id : null };
        });
        streaming = true;
        const uploaded = await ingestUploadedFileWithTransaction(
          pool,
          {
            filesDatabaseId: preflight.filesId,
            filename,
            contentType,
            source: req,
            storageKeyPrefix: "files",
            maxBytes: options.maxFileSizeBytes,
            storage: options.storage,
          },
          (client, result) =>
            recordRecordingIntake(client, { fileItemId: result.item.id, eventId: preflight.eventId, recordedAt }),
        );
        sendJson(res, uploaded.result.created ? 201 : 200, {
          fileItemId: uploaded.result.item.id,
          created: uploaded.result.created,
          ...uploaded.value,
        });
      });
    } catch (error) {
      if (!streaming) res.shouldKeepAlive = false;
      if (error instanceof MaxBytesExceededError) {
        req.resume();
        sendJson(res, 413, { error: { code: "payload_too_large" } });
        return;
      }
      if (error instanceof ChokePointError) {
        sendJson(res, statusForError(error), toErrorResponseBody(error));
        return;
      }
      logger.error({ errorName: error instanceof Error ? error.name : "unknown" }, "Recording upload failed");
      sendJson(res, 500, { error: { code: "internal_error" } });
    }
  }
  return function listener(req: IncomingMessage, res: ServerResponse): void {
    handle(req, res).catch((error: unknown) => {
      logger.error({ errorName: error instanceof Error ? error.name : "unknown" }, "Recording listener failed");
      if (res.headersSent) res.end();
      else sendJson(res, 500, { error: { code: "internal_error" } });
    });
  };
}
