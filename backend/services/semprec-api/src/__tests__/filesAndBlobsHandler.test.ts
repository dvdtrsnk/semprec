import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool, type PoolClient } from "pg";
import { z } from "zod";
import { runOnce } from "@semprec/queue";
import { getTenantZeroId, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  createUser,
  createChokePoint,
  createApiCoreTaskList,
  createItemWithClient,
  getDatabaseByModuleId,
  getSystemTimezone,
  createViewTypeRegistry,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  seedSystem,
  withTransaction,
  type PasswordResetMailer,
} from "@semprec/data";
import { createDispatcher } from "../app.js";
import { createApiActionRegistry } from "../actionRegistryComposition.js";
import { runTranscriptionFixture, withFixtureStorage } from "./transcriptionHttpFixture.js";

const PASSWORD = "s3cret-password";
const MAX_FILE_SIZE_BYTES = 1024;
// A complete 1×1 RGBA PNG, including its image data and chunk checksums.
const PNG_IMAGE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
  "base64",
);
function zipEntry(name: string): Buffer {
  const header = Buffer.alloc(30);
  header.write("PK\x03\x04", 0, "latin1");
  header.writeUInt16LE(name.length, 26);
  return Buffer.concat([header, Buffer.from(name, "latin1")]);
}
function tenantDay(zone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

const noopMailer: PasswordResetMailer = {
  async sendPasswordResetEmail() {},
};

let pool: Pool;
const moduleRegistry = await loadFullModuleRegistry();

/** Tenant zero's one user, created in `beforeEach`: every upload of a test must land in the same tenant. */
const OWNER_EMAIL = "files-owner@example.com";

/** A fresh session of tenant zero's user. */
async function authHeader(): Promise<{ Authorization: string }> {
  const { token } = await login(pool, { email: OWNER_EMAIL, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
  return { Authorization: `Bearer ${token}` };
}

interface ItemBody {
  id: string;
  databaseId: string;
  properties: Record<string, unknown>;
}

interface ErrorBody {
  error: { code: string; details?: unknown };
}

describe("files and blobs routes (issue #158)", () => {
  let server: Server;
  let baseUrl: string;
  let tmpBlobDir: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    await createUser(pool, {
      email: OWNER_EMAIL,
      passwordHash: await hashPassword(PASSWORD),
      tenantId: getTenantZeroId(),
    });

    tmpBlobDir = join(tmpdir(), `semprec-test-blobs-${randomUUID()}`);
    const dispatch = await createDispatcher(pool, {
      passwordResetMailer: noopMailer,
      appBaseUrl: "http://localhost",
      setupToken: "unused-setup-token",
      moduleRegistry,
      blobStorage: new LocalFsBlobStorageWriter(tmpBlobDir),
      maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
    });
    server = createServer(dispatch);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function uploadFile(body: string | Buffer, opts: { filename?: string; contentType?: string } = {}) {
    const headers = {
      ...(await authHeader()),
      "Content-Type": opts.contentType ?? "text/plain",
      "X-Filename": opts.filename ?? "hello.txt",
    };
    return fetch(`${baseUrl}/api/files`, { method: "POST", headers, body, duplex: "half" });
  }

  it("restores a deleted-stop transcript and runs its queued HTTP rerun from committed checkpoints", async () => {
    const headers = await authHeader();
    await withFixtureStorage(tmpBlobDir, async () => {
      const first = await runTranscriptionFixture(
        {
          mode: "stop",
          tenantId: getTenantZeroId(),
          storageRoot: tmpBlobDir,
        },
        pool,
      );
      expect(first.result.diarizeCalls).toBe(1);
      expect(first.result.transcribeCalls).toBe(0);
      const stopped = await pool.query<Record<string, unknown>>(
        "SELECT ia.status, ia.error_code, i.deleted_at IS NOT NULL AS deleted FROM item_automation ia JOIN items i ON i.id = ia.item_id WHERE ia.item_id = $1",
        [first.result.transcriptId],
      );
      expect(
        z.object({ status: z.string(), error_code: z.string(), deleted: z.boolean() }).parse(stopped.rows[0]),
      ).toEqual({ status: "error", error_code: "deleted", deleted: true });
      const notifications = await pool.query("SELECT id FROM notifications WHERE source_id = $1", [
        first.result.transcriptId,
      ]);
      expect(notifications.rows).toEqual([]);
      const restore = await fetch(`${baseUrl}/api/items/${first.result.transcriptId}/restore`, {
        method: "POST",
        headers,
      });
      expect(restore.status).toBe(200);
      const rerun = await fetch(`${baseUrl}/api/transcriptions/${first.result.transcriptId}/rerun`, {
        method: "POST",
        headers,
      });
      expect(rerun.status).toBe(202);
      const rerunBody: unknown = await rerun.json();
      expect(z.object({ id: z.uuid(), fileItemId: z.uuid() }).parse(rerunBody)).toEqual({
        id: first.result.transcriptId,
        fileItemId: first.result.fileItemId,
      });
      const queued = await pool.query<Record<string, unknown>>("SELECT key FROM graphile_worker.jobs WHERE key = $1", [
        `transcription-job:${first.result.fileItemId}`,
      ]);
      expect(z.array(z.object({ key: z.string() })).parse(queued.rows)).toHaveLength(1);
      const resumed = await runTranscriptionFixture(
        {
          mode: "consume",
          tenantId: getTenantZeroId(),
          storageRoot: tmpBlobDir,
          fileItemId: first.result.fileItemId,
        },
        pool,
      );
      expect(resumed.result.transcriptId).toBe(first.result.transcriptId);
      expect(resumed.result.normalizedBlobId).toBe(first.result.normalizedBlobId);
      expect(resumed.result.diarizeCalls).toBe(1);
      expect(resumed.result.transcribeCalls).toBe(1);
      expect(resumed.result.summaryCalls).toBeGreaterThan(0);
      const completed = await pool.query<Record<string, unknown>>(
        "SELECT status, error_code FROM item_automation WHERE item_id = $1",
        [first.result.transcriptId],
      );
      expect(z.object({ status: z.string(), error_code: z.string().nullable() }).parse(completed.rows[0])).toEqual({
        status: "done",
        error_code: null,
      });
      const remaining = await pool.query("SELECT key FROM graphile_worker.jobs WHERE key = $1", [
        `transcription-job:${first.result.fileItemId}`,
      ]);
      expect(remaining.rows).toEqual([]);
    });
  });

  describe("POST /api/files", () => {
    function ftyp(brand: string): Buffer {
      const bytes = Buffer.alloc(16);
      bytes.writeUInt32BE(16, 0);
      bytes.write("ftyp", 4, "latin1");
      bytes.write(brand, 8, "latin1");
      return bytes;
    }

    it("enqueues transcription through the heartbeat after an audio upload", async () => {
      vi.stubEnv("AI_GATEWAY_INTERNAL_TOKEN", "local-test-token");
      try {
        const response = await uploadFile(ftyp("M4A "), { filename: "recording.m4a", contentType: "audio/mp4" });
        expect(response.status).toBe(201);
        const body: unknown = await response.json();
        const { id } = z.object({ id: z.uuid() }).parse(body);
        const key = `transcription-job:${id}`;
        const before = await pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM graphile_worker.jobs WHERE key = $1",
          [key],
        );
        expect(before.rows[0]?.count).toBe(0);
        const registry = createApiActionRegistry(pool, moduleRegistry);
        await runOnce({ pgPool: pool, taskList: createApiCoreTaskList(pool, registry) });
        const after = await pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM graphile_worker.jobs WHERE key = $1",
          [key],
        );
        expect(after.rows[0]?.count).toBe(1);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it.each([
      [Buffer.from("%PDF-1.7"), "pdf", "application/pdf"],
      [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "png", "image/png"],
      [ftyp("heic"), "heic", "image/heic"],
      [ftyp("M4A "), "audio", "audio/mp4"],
      [Buffer.from("ID3audio"), "audio", "audio/mpeg"],
      [zipEntry("xl/workbook.xml"), "xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
      [
        zipEntry("word/document.xml"),
        "docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ],
      [zipEntry("other.txt"), undefined, "application/octet-stream"],
    ])("detects uploaded content through the Files route", async (bytes, type, mimeType) => {
      const response = await uploadFile(bytes, { contentType: "image/jpeg" });
      expect(response.status).toBe(201);
      const body: unknown = await response.json();
      expect(body).toMatchObject({
        properties: type === undefined ? expect.not.objectContaining({ type: expect.anything() }) : { type },
        blobs: { file: { mimeType } },
      });
    });

    it("rejects an unauthenticated request", async () => {
      const res = await fetch(`${baseUrl}/api/files`, {
        method: "POST",
        headers: { "Content-Type": "text/plain", "X-Filename": "a.txt" },
        body: "hi",
      });
      expect(res.status).toBe(401);
    });

    it("streams an upload and creates a Files item, 201", async () => {
      const res = await uploadFile("hello world", { filename: "hello.txt", contentType: "text/plain" });
      expect(res.status).toBe(201);
      const body = (await res.json()) as ItemBody;
      expect(body.properties.name).toBe("hello.txt");
      expect(body.properties.file).toMatchObject({ blobId: expect.any(String) });
    });

    it("rejects a payload over Content-Length before reading the body (413)", async () => {
      const oversized = "x".repeat(MAX_FILE_SIZE_BYTES + 100);
      const res = await uploadFile(oversized);
      expect(res.status).toBe(413);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe("payload_too_large");
    });

    it("rejects an X-Filename over the safe storage-key length with 400, not a filesystem error", async () => {
      const res = await uploadFile("hi", { filename: "x".repeat(500) });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe("validation_failed");
    });

    it("rejects a chunked upload with no Content-Length that exceeds the limit via the streaming counter, leaving no partial blob or row", async () => {
      const headers = {
        ...(await authHeader()),
        "Content-Type": "text/plain",
        "X-Filename": "big.txt",
      };
      const oversized = "y".repeat(MAX_FILE_SIZE_BYTES * 2);
      const stream = Readable.from(
        (async function* () {
          // Yielding in small chunks with no declared length forces `fetch` to use chunked
          // transfer-encoding, so no `Content-Length` header precheck can catch this — only
          // the always-on streaming byte counter can.
          for (let i = 0; i < oversized.length; i += 16) {
            yield oversized.slice(i, i + 16);
          }
        })(),
      );

      const res = await fetch(`${baseUrl}/api/files`, {
        method: "POST",
        headers,
        body: stream,
        duplex: "half",
      });
      expect(res.status).toBe(413);

      const { rows: blobRows } = await pool.query("SELECT count(*)::int AS n FROM blobs");
      expect(blobRows[0].n).toBe(0);
      const { rows: itemRows } = await pool.query(
        "SELECT count(*)::int AS n FROM items WHERE properties -> 'file' ->> 'blobId' IS NOT NULL",
      );
      expect(itemRows[0].n).toBe(0);
    });

    it("converges concurrent identical uploads onto one blob and one deterministic Files item", async () => {
      const content = "same bytes every time";
      const [first, second] = await Promise.all([
        uploadFile(content, { filename: "dup.txt" }),
        uploadFile(content, { filename: "dup.txt" }),
      ]);

      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([200, 201]);

      const firstBody = (await first.json()) as ItemBody;
      const secondBody = (await second.json()) as ItemBody;
      expect(secondBody.id).toBe(firstBody.id);

      const { rows: blobRows } = await pool.query("SELECT count(*)::int AS n FROM blobs");
      expect(blobRows[0].n).toBe(1);
    });

    it("reuses the existing Files row (lowest id) when the same content is uploaded again later", async () => {
      const content = "reupload me";
      const first = await uploadFile(content, { filename: "a.txt" });
      expect(first.status).toBe(201);
      const firstBody = (await first.json()) as ItemBody;

      const second = await uploadFile(content, { filename: "a-again.txt" });
      expect(second.status).toBe(200);
      const secondBody = (await second.json()) as ItemBody;
      expect(secondBody.id).toBe(firstBody.id);
    });
  });

  describe("POST /api/blobs (issue #1401)", () => {
    async function uploadBlob(body: string | Buffer, contentType = "image/png", authenticated = true) {
      const headers: Record<string, string> = {
        ...(authenticated ? await authHeader() : {}),
        "Content-Type": contentType,
      };
      return fetch(`${baseUrl}/api/blobs`, { method: "POST", headers, body, duplex: "half" });
    }

    async function storedFileCount(): Promise<number> {
      try {
        return (await readdir(tmpBlobDir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).length;
      } catch {
        return 0;
      }
    }

    it.each([
      [PNG_IMAGE, "image/png", "png"],
      [Buffer.from("%PDF-1.7 document"), "application/pdf", "pdf"],
      [Buffer.from("ID3audio"), "audio/mpeg", "audio"],
      [
        zipEntry("word/document.xml"),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "docx",
      ],
    ])(
      "uploads bytes then creates a separate Files item with an initial project relation",
      async (bytes, mime, type) => {
        await withFixtureStorage(tmpBlobDir, async () => {
          const headers = await authHeader();
          const upload = await fetch(`${baseUrl}/api/blobs`, {
            method: "POST",
            headers: { ...headers, "Content-Type": mime },
            body: bytes,
          });
          expect(upload.status).toBe(201);
          const blob = z
            .object({ blobId: z.string().uuid() })
            .passthrough()
            .parse(await upload.json());
          const files = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "files"));
          const projects = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "projects"));
          if (!files || !projects) throw new Error("Missing system databases");
          const project = await createChokePoint(pool).createItem({
            databaseId: projects.id,
            properties: { name: "Project" },
          });
          const zone = await withTransaction(pool, (client) => getSystemTimezone(client));
          const before = tenantDay(zone);
          const response = await fetch(`${baseUrl}/api/databases/${files.id}/items`, {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({
              properties: { name: "New file", file: { blobId: blob.blobId } },
              relations: [{ propertyKey: "projects", targetItemIds: [project.id] }],
            }),
          });
          expect(response.status).toBe(201);
          const created = z
            .object({ id: z.string().uuid(), properties: z.record(z.string(), z.unknown()) })
            .passthrough()
            .parse(await response.json());
          expect(created.properties).toMatchObject({
            name: "New file",
            file: { blobId: blob.blobId },
            type,
          });
          expect([before, tenantDay(zone)]).toContain(created.properties.date);
          const read = await fetch(`${baseUrl}/api/items/${created.id}`, { headers });
          expect(read.status).toBe(200);
          expect(await read.json()).toMatchObject({ id: created.id, properties: { type } });
          const relations = await fetch(`${baseUrl}/api/items/${created.id}/relations?propertyKey=projects`, {
            headers,
          });
          expect(relations.status).toBe(200);
          expect(await relations.json()).toMatchObject({ relations: [{ targetItemId: project.id }] });
        });
      },
    );

    it("rejects an unauthenticated request", async () => {
      expect((await uploadBlob("png", "image/png", false)).status).toBe(401);
    });

    it("stores an image as a blob, 201, without creating a Files item", async () => {
      const png = PNG_IMAGE;
      const res = await uploadBlob(png);
      expect(res.status).toBe(201);
      const body = (await res.json()) as { blobId: string; byteSize: number; mimeType: string };
      expect(body).toEqual({ blobId: expect.any(String), byteSize: png.length, mimeType: "image/png" });
      const stored = await pool.query<{ storage_key: string }>("SELECT storage_key FROM blobs WHERE id = $1", [
        body.blobId,
      ]);
      const key = stored.rows[0]?.storage_key;
      if (!key) throw new Error("missing stored blob key");
      expect(await readFile(join(tmpBlobDir, key))).toEqual(png);
      const { rows } = await pool.query("SELECT count(*)::int AS n FROM items WHERE properties ? 'file'");
      expect(rows[0].n).toBe(0);
      expect(await storedFileCount()).toBe(1);
    });

    it("normalises Content-Type parameters and returns the same blob with 200 for identical bytes", async () => {
      const first = (await (await uploadBlob("same image")).json()) as { blobId: string };
      const res = await uploadBlob("same image", "Image/PNG; charset=binary");
      expect(res.status).toBe(200);
      expect(((await res.json()) as { blobId: string; mimeType: string }).blobId).toBe(first.blobId);
      // The duplicate's bytes are removed after the commit, without the response waiting for it.
      await vi.waitFor(async () => expect(await storedFileCount()).toBe(1));
    });

    it("detects a mismatched PDF and falls back for unknown bytes despite an image header", async () => {
      const pdf = await uploadBlob("%PDF-1.7 test", "image/jpeg");
      expect(pdf.status).toBe(201);
      expect(await pdf.json()).toMatchObject({ mimeType: "application/pdf" });
      const unknown = await uploadBlob("unrecognised content", "image/png");
      expect(unknown.status).toBe(201);
      expect(await unknown.json()).toMatchObject({ mimeType: "application/octet-stream" });
    });

    it("returns existing historical metadata unchanged on a deduplication hit", async () => {
      const first = await uploadBlob("%PDF-1.7 historical", "image/png");
      expect(first.status).toBe(201);
      const body = (await first.json()) as { blobId: string };
      await pool.query("UPDATE blobs SET mime_type = $2 WHERE id = $1", [body.blobId, "image/legacy"]);
      const second = await uploadBlob("%PDF-1.7 historical", "image/jpeg");
      expect(second.status).toBe(200);
      expect(await second.json()).toMatchObject({ blobId: body.blobId, mimeType: "image/legacy" });
      await vi.waitFor(async () => expect(await storedFileCount()).toBe(1));
    });

    it("rejects a malformed Content-Type with 400 on the Content-Type field and stores nothing", async () => {
      const res = await uploadBlob("hello", "text/plain; broken");
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.details).toMatchObject({ field: "Content-Type" });
      expect(await storedFileCount()).toBe(0);
    });

    it("rejects an oversized body with 413 and stores nothing", async () => {
      const res = await uploadBlob("x".repeat(MAX_FILE_SIZE_BYTES + 100));
      expect(res.status).toBe(413);
      expect(((await res.json()) as ErrorBody).error.code).toBe("payload_too_large");
      expect(await storedFileCount()).toBe(0);
    });
  });

  describe("GET /api/blobs/:id", () => {
    async function uploadAndGetBlobId(content: string | Buffer, opts?: { filename?: string; contentType?: string }) {
      const res = await uploadFile(content, opts);
      const body = (await res.json()) as ItemBody;
      return (body.properties.file as { blobId: string }).blobId;
    }

    it("rejects an unauthenticated request", async () => {
      const blobId = await uploadAndGetBlobId("abc");
      const res = await fetch(`${baseUrl}/api/blobs/${blobId}`);
      expect(res.status).toBe(401);
    });

    it("returns 404 for an unknown blob id", async () => {
      const headers = await authHeader();
      const res = await fetch(`${baseUrl}/api/blobs/${randomUUID()}`, { headers });
      expect(res.status).toBe(404);
    });

    it("returns 400 validation_failed naming 'id' for a non-UUID blob id", async () => {
      const headers = await authHeader();
      const res = await fetch(`${baseUrl}/api/blobs/foo`, { headers });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; details?: unknown } };
      expect(body.error.code).toBe("validation_failed");
      expect(body.error.details).toEqual({ field: "id" });
    });

    it("does not dispatch DELETE or PATCH to the download handler", async () => {
      const headers = await authHeader();
      const blobId = await uploadAndGetBlobId("do not delete me");

      const deleteRes = await fetch(`${baseUrl}/api/blobs/${blobId}`, { method: "DELETE", headers });
      expect(deleteRes.status).not.toBe(200);
      expect(deleteRes.status).not.toBe(206);

      const patchRes = await fetch(`${baseUrl}/api/blobs/${blobId}`, { method: "PATCH", headers });
      expect(patchRes.status).not.toBe(200);
      expect(patchRes.status).not.toBe(206);
    });

    it("downloads the full blob with a safe attachment Content-Disposition and nosniff", async () => {
      const headers = await authHeader();
      const blobId = await uploadAndGetBlobId("hello world", { filename: "hello.txt", contentType: "text/plain" });

      const res = await fetch(`${baseUrl}/api/blobs/${blobId}`, { headers });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("hello world");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("content-disposition")).toContain('attachment; filename="hello.txt"');
      expect(res.headers.get("etag")).toBeTruthy();
    });

    it("serves a valid byte range with 206 and Content-Range", async () => {
      const headers = await authHeader();
      const blobId = await uploadAndGetBlobId("0123456789", { filename: "digits.txt" });

      const res = await fetch(`${baseUrl}/api/blobs/${blobId}`, { headers: { ...headers, Range: "bytes=2-4" } });
      expect(res.status).toBe(206);
      expect(res.headers.get("content-range")).toBe("bytes 2-4/10");
      expect(await res.text()).toBe("234");
    });

    it("rejects an out-of-bounds range with 416", async () => {
      const headers = await authHeader();
      const blobId = await uploadAndGetBlobId("0123456789", { filename: "digits.txt" });

      const res = await fetch(`${baseUrl}/api/blobs/${blobId}`, { headers: { ...headers, Range: "bytes=100-200" } });
      expect(res.status).toBe(416);
      expect(res.headers.get("content-range")).toBe("bytes */10");
    });

    it("rejects a zero-length suffix range (bytes=-0) with 416, per RFC 7233 §2.1", async () => {
      const headers = await authHeader();
      const blobId = await uploadAndGetBlobId("0123456789", { filename: "digits.txt" });

      const res = await fetch(`${baseUrl}/api/blobs/${blobId}`, { headers: { ...headers, Range: "bytes=-0" } });
      expect(res.status).toBe(416);
      expect(res.headers.get("content-range")).toBe("bytes */10");
    });

    it("ignores a malformed Range header and serves the full body", async () => {
      const headers = await authHeader();
      const blobId = await uploadAndGetBlobId("0123456789", { filename: "digits.txt" });

      const res = await fetch(`${baseUrl}/api/blobs/${blobId}`, { headers: { ...headers, Range: "not-a-range" } });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("0123456789");
    });

    it("returns 304 when If-None-Match matches the current ETag", async () => {
      const headers = await authHeader();
      const blobId = await uploadAndGetBlobId("etag me", { filename: "e.txt" });

      const first = await fetch(`${baseUrl}/api/blobs/${blobId}`, { headers });
      const etag = first.headers.get("etag");
      expect(etag).toBeTruthy();

      const res = await fetch(`${baseUrl}/api/blobs/${blobId}`, { headers: { ...headers, "If-None-Match": etag! } });
      expect(res.status).toBe(304);
    });

    it("honors ?disposition=inline only for an allowlisted MIME type", async () => {
      const headers = await authHeader();
      // The mime is detected from the bytes, so a PNG signature is needed whatever the client claims.
      const pngBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("x")]);
      const pngBlobId = await uploadAndGetBlobId(pngBytes, { filename: "pic.png", contentType: "text/plain" });

      const inline = await fetch(`${baseUrl}/api/blobs/${pngBlobId}?disposition=inline`, { headers });
      expect(inline.headers.get("content-disposition")).toContain("inline;");
    });

    it("ignores ?disposition=inline for a MIME type outside the allowlist (e.g. text/html, to avoid inline stored-XSS)", async () => {
      const headers = await authHeader();
      const htmlBlobId = await uploadAndGetBlobId("<script>evil()</script>", {
        filename: "evil.html",
        contentType: "text/html",
      });

      const res = await fetch(`${baseUrl}/api/blobs/${htmlBlobId}?disposition=inline`, { headers });
      expect(res.headers.get("content-disposition")).toContain("attachment;");
    });

    it("percent-encodes and ASCII-sanitizes a malicious filename in Content-Disposition instead of injecting header syntax", async () => {
      const headers = await authHeader();
      const maliciousName = 'evil".txt"; filename="x';
      const blobId = await uploadAndGetBlobId("payload", { filename: maliciousName });

      const res = await fetch(`${baseUrl}/api/blobs/${blobId}`, { headers });
      const disposition = res.headers.get("content-disposition")!;
      expect(disposition).not.toContain('"; filename="x');
      expect(disposition).toContain('filename="evil_.txt_; filename=_x"');
    });
  });

  describe("blob metadata on item envelopes (issue #1412)", () => {
    interface BlobsItemBody extends ItemBody {
      blobs?: Record<string, { blobId: string; byteSize: number; mimeType: string; filename: string | null }>;
    }
    interface QueryBody {
      items: BlobsItemBody[];
    }

    it("returns blobs.file with size, type and filename on the upload response, GET and query", async () => {
      const headers = await authHeader();
      const uploaded = (await (
        await uploadFile("hello world", { filename: "report.txt", contentType: "text/plain" })
      ).json()) as BlobsItemBody;
      const blobId = (uploaded.properties.file as { blobId: string }).blobId;
      const expected = { blobId, byteSize: 11, mimeType: "application/octet-stream", filename: "report.txt" };

      expect(uploaded.blobs).toEqual({ file: expected });

      const got = (await (await fetch(`${baseUrl}/api/items/${uploaded.id}`, { headers })).json()) as BlobsItemBody;
      expect(got.blobs).toEqual({ file: expected });
      expect(got.properties).toEqual(uploaded.properties);

      const queried = (await (
        await fetch(`${baseUrl}/api/databases/${uploaded.databaseId}/query`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: "{}",
        })
      ).json()) as QueryBody;
      expect(queried.items.find((item) => item.id === uploaded.id)?.blobs).toEqual({ file: expected });
    });

    it("returns blob metadata for a Library cover on the real item route", async () => {
      const png = PNG_IMAGE;
      const upload = await fetch(`${baseUrl}/api/blobs`, {
        method: "POST",
        headers: { ...(await authHeader()), "Content-Type": "image/png" },
        body: png,
      });
      expect(upload.status).toBe(201);
      const uploaded: unknown = await upload.json();
      if (
        typeof uploaded !== "object" ||
        uploaded === null ||
        !("blobId" in uploaded) ||
        typeof uploaded.blobId !== "string"
      ) {
        throw new Error("expected uploaded blob id");
      }
      const blobId = uploaded.blobId;
      const item = await withTransaction(pool, async (client) => {
        const books = await getDatabaseByModuleId(client, "books");
        if (!books) throw new Error("missing Books database");
        return createItemWithClient(
          client,
          { databaseId: books.id, properties: { name: "A book", cover: { blobId } } },
          { allowedSystemKeys: ["cover"] },
        );
      });
      const response = await fetch(`${baseUrl}/api/items/${item.id}`, { headers: await authHeader() });
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      expect(body).toMatchObject({
        properties: { cover: { blobId } },
        blobs: { cover: { blobId, byteSize: png.length, mimeType: "image/png", filename: null } },
      });
    });

    it("has no blobs key on an item without a file blob", async () => {
      const headers = await authHeader();
      const uploaded = (await (await uploadFile("x")).json()) as BlobsItemBody;
      const created = await fetch(`${baseUrl}/api/databases/${uploaded.databaseId}/items`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ properties: { name: "no file here" } }),
      });
      expect(created.status).toBe(201);
      const body = (await created.json()) as BlobsItemBody;
      expect(body).not.toHaveProperty("blobs");
      expect(body.properties).toMatchObject({ name: "no file here" });
    });

    it("returns metadata on generic item create and PATCH, and omits it after clearing the image", async () => {
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };
      const upload = await fetch(`${baseUrl}/api/blobs`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "image/png" },
        body: PNG_IMAGE,
      });
      expect(upload.status).toBe(201);
      const uploaded: unknown = await upload.json();
      if (
        typeof uploaded !== "object" ||
        uploaded === null ||
        !("blobId" in uploaded) ||
        typeof uploaded.blobId !== "string"
      )
        throw new Error("expected blob id");
      const blobId = uploaded.blobId;
      const cp = createChokePoint(pool);
      const db = await cp.createDatabase({ name: "Images" });
      await cp.createProperty({ databaseId: db.id, key: "photo", name: "Photo", type: "image" });
      const create = await fetch(`${baseUrl}/api/databases/${db.id}/items`, {
        method: "POST",
        headers,
        body: JSON.stringify({ properties: { photo: { blobId } } }),
      });
      expect(create.status).toBe(201);
      const created: unknown = await create.json();
      if (
        typeof created !== "object" ||
        created === null ||
        !("id" in created) ||
        typeof created.id !== "string" ||
        !("updatedAt" in created) ||
        typeof created.updatedAt !== "string"
      )
        throw new Error("expected created item");
      const metadata = { blobId, byteSize: PNG_IMAGE.length, mimeType: "image/png", filename: null };
      expect(created).toMatchObject({ properties: { photo: { blobId } }, blobs: { photo: metadata } });
      const clear = await fetch(`${baseUrl}/api/items/${created.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ properties: { photo: null }, ifVersion: created.updatedAt }),
      });
      expect(clear.status).toBe(200);
      const cleared: unknown = await clear.json();
      if (
        typeof cleared !== "object" ||
        cleared === null ||
        !("updatedAt" in cleared) ||
        typeof cleared.updatedAt !== "string"
      )
        throw new Error("expected patched item");
      expect(cleared).toMatchObject({ properties: { photo: null } });
      expect(cleared).not.toHaveProperty("blobs");
      const restore = await fetch(`${baseUrl}/api/items/${created.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ properties: { photo: { blobId } }, ifVersion: cleared.updatedAt }),
      });
      expect(restore.status).toBe(200);
      expect(await restore.json()).toMatchObject({ properties: { photo: { blobId } }, blobs: { photo: metadata } });
    });

    it("fetches blobs once for an actual 50-item database query response", async () => {
      const headers = await authHeader();
      const uploaded = (await (await uploadFile("query-count-bytes")).json()) as BlobsItemBody;
      const file = uploaded.properties.file;
      const chokePoint = createChokePoint(pool);
      for (let i = 0; i < 49; i += 1) {
        await chokePoint.createItem({ databaseId: uploaded.databaseId, properties: { name: `File ${i}`, file } });
      }
      const view = await chokePoint.createView({ databaseId: uploaded.databaseId, type: "table", name: "All files" });

      let blobQueries = 0;
      const wrapped = new Map<PoolClient, PoolClient["query"]>();
      const instrument = (client: PoolClient) => {
        if (wrapped.has(client)) return;
        // The proxy forwards the original receiver through Reflect.apply.
        // eslint-disable-next-line @typescript-eslint/unbound-method
        wrapped.set(client, client.query);
        // eslint-disable-next-line @typescript-eslint/unbound-method
        client.query = new Proxy(client.query, {
          apply(target, thisArg, args: unknown[]) {
            if (typeof args[0] === "string" && /FROM blobs\b/i.test(args[0])) blobQueries += 1;
            return Reflect.apply(target, thisArg, args);
          },
        });
      };
      pool.on("acquire", instrument);
      try {
        for (const path of [`/api/databases/${uploaded.databaseId}/query`, `/api/views/${view.id}/query`]) {
          blobQueries = 0;
          const response = await fetch(`${baseUrl}${path}`, {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ limit: 50 }),
          });
          expect(response.status).toBe(200);
          const body: unknown = await response.json();
          if (typeof body !== "object" || body === null || !("items" in body) || !Array.isArray(body.items)) {
            throw new Error("expected query items");
          }
          expect(body.items).toHaveLength(50);
          for (const item of body.items) {
            expect(item).toHaveProperty("blobs.file.blobId", uploaded.blobs?.file?.blobId);
          }
          expect(blobQueries).toBe(1);
        }
      } finally {
        pool.off("acquire", instrument);
        for (const [client, query] of wrapped) client.query = query;
      }
    });
  });
});
