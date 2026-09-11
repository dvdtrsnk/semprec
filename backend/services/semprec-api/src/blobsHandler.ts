import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import {
  ChokePointError,
  NotFoundError,
  withTransaction,
  getDatabaseByModuleId,
  findFileItemByBlobId,
  getBlob,
  FILES_MODULE_ID,
  type BlobRow,
  type BlobStorageWriter,
} from "@semprec/data";
import { authenticateRequest } from "./authHandler.js";
import { statusForError, toErrorResponseBody } from "./adapter/errorContract.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

const BLOB_PATH = /^\/api\/blobs\/([^/]+)$/;

/**
 * `?disposition=inline` (issue #158) is only honored for MIME types that are safe for a browser
 * to render directly in the same origin — deliberately excludes anything HTML/script-capable
 * (`text/html`, `image/svg+xml`, `application/xhtml+xml`, …), since an attacker-supplied blob
 * rendered inline under this API's origin would otherwise be a stored-XSS vector. Anything not in
 * this set always downloads as `attachment`, regardless of the query parameter.
 */
const INLINE_SAFE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
]);

interface ParsedRange {
  start: number;
  end: number;
}

/**
 * A single `bytes=start-end` range (RFC 7233 §2.1) against a resource of `size` bytes. A
 * syntactically valid but out-of-bounds range is `"unsatisfiable"` (416); anything the regex
 * doesn't recognize at all is treated as absent — RFC 7233 §3.1: a server that doesn't understand
 * a Range header must serve the full representation, not fail the request.
 */
function parseRange(header: string | undefined, size: number): ParsedRange | "unsatisfiable" | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return undefined;
  const [, startStr, endStr] = match;
  if (startStr === "" && endStr === "") return undefined;

  let start: number;
  let end: number;
  if (startStr === "") {
    const suffixLength = Number(endStr);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return undefined;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(startStr);
    end = endStr === "" ? size - 1 : Number(endStr);
  }

  if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || start < 0 || start >= size) {
    return "unsatisfiable";
  }
  return { start, end: Math.min(end, size - 1) };
}

/** `If-None-Match` (RFC 7232 §3.2): `"*"` or a comma-separated list of (optionally weak) entity tags. */
function ifNoneMatchMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === "*") return true;
  return header.split(",").some((candidate) => candidate.trim().replace(/^W\//, "") === etag);
}

/**
 * RFC 6266 + RFC 5987: an ASCII-only fallback `filename=` (control characters, quotes and
 * backslashes stripped so nothing can break out of the quoted string or inject a second header
 * directive) plus a percent-encoded UTF-8 `filename*` for clients that support it — malicious or
 * merely non-ASCII filenames stay display-only, never header-structural.
 */
function contentDispositionHeader(kind: "inline" | "attachment", filename: string): string {
  const asciiFallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** The lowest-id Files item pointing at this blob (same convergence lookup `POST /api/files` dedup uses), if any — its `name` property is the best available display filename for a download that only knows a blob id. */
async function resolveDownloadFilename(pool: Pool, blob: BlobRow): Promise<string> {
  const item = await withTransaction(pool, async (client) => {
    const filesDatabase = await getDatabaseByModuleId(client, FILES_MODULE_ID);
    if (!filesDatabase) return null;
    return findFileItemByBlobId(client, filesDatabase.id, blob.id);
  });
  const name = item && typeof item.properties.name === "string" ? item.properties.name : undefined;
  return name && name.length > 0 ? name : blob.id;
}

export interface BlobsRequestListenerOptions {
  storage: BlobStorageWriter;
}

/**
 * `GET /api/blobs/:id` (issue #158): authenticated, streamed, `Range`/conditional-request aware.
 * Like `filesHandler.ts`, this can't go through `createAdapterRequestListener` — a binary
 * download's response isn't a JSON envelope and its body is piped, not buffered — so it's a
 * bespoke listener the same way `notificationsHandler.ts` is, sharing this adapter's auth and
 * error-code contract without its JSON-specific machinery.
 */
export function createBlobsRequestListener(pool: Pool, options: BlobsRequestListenerOptions) {
  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      await authenticateRequest(pool, req);

      const match = BLOB_PATH.exec(url.pathname);
      if (!match) {
        sendJson(res, 404, { error: { code: "not_found" } });
        return;
      }
      // Group 1 of BLOB_PATH is not optional, so a successful match always captured it.
      const blobId = match[1]!;

      const blob = await withTransaction(pool, (client) => getBlob(client, blobId));
      if (!blob) throw new NotFoundError(`Blob ${blobId} not found`);

      const byteSize = Number(blob.byteSize);
      const etag = blob.contentHash ? `"${blob.contentHash}"` : undefined;

      const ifNoneMatch = req.headers["if-none-match"];
      if (etag && ifNoneMatchMatches(typeof ifNoneMatch === "string" ? ifNoneMatch : undefined, etag)) {
        res.writeHead(304, { ETag: etag });
        res.end();
        return;
      }

      const rangeHeader = req.headers.range;
      const range = parseRange(typeof rangeHeader === "string" ? rangeHeader : undefined, byteSize);
      if (range === "unsatisfiable") {
        res.writeHead(416, { "Content-Range": `bytes */${byteSize}` });
        res.end();
        return;
      }

      const wantsInline = url.searchParams.get("disposition") === "inline";
      const disposition = wantsInline && INLINE_SAFE_MIME_TYPES.has(blob.mimeType) ? "inline" : "attachment";
      const filename = await resolveDownloadFilename(pool, blob);

      const headers: Record<string, string> = {
        "Content-Type": blob.mimeType,
        "Accept-Ranges": "bytes",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": contentDispositionHeader(disposition, filename),
      };
      if (etag) headers.ETag = etag;

      const stream = options.storage.readStream(blob.storageKey, range);
      stream.once("error", (streamErr) => {
        console.error(`Error streaming blob ${blobId}:`, streamErr);
        if (res.headersSent) {
          res.destroy();
        } else {
          sendJson(res, 500, { error: { code: "internal_error" } });
        }
      });

      if (range) {
        headers["Content-Range"] = `bytes ${range.start}-${range.end}/${byteSize}`;
        headers["Content-Length"] = String(range.end - range.start + 1);
        res.writeHead(206, headers);
      } else {
        headers["Content-Length"] = String(byteSize);
        res.writeHead(200, headers);
      }
      stream.pipe(res);
    } catch (err) {
      if (err instanceof ChokePointError) {
        sendJson(res, statusForError(err), toErrorResponseBody(err));
        return;
      }
      const errInfo = err instanceof Error ? (err.stack ?? err.message) : err;
      console.error(`Unexpected error in ${req.method} ${url.pathname}:`, errInfo);
      sendJson(res, 500, { error: { code: "internal_error" } });
    }
  }

  return function handleRequestSafely(req: IncomingMessage, res: ServerResponse): void {
    handleRequest(req, res).catch((err: unknown) => {
      const errInfo = err instanceof Error ? (err.stack ?? err.message) : err;
      console.error("Unhandled error in the request listener:", errInfo);
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, { error: { code: "internal_error" } });
    });
  };
}
