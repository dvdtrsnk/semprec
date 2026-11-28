import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { getTenantZeroId, getTestPool, resetDatabase } from "@alldots/data/testSupport";
import {
  createUser,
  createViewTypeRegistry,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  seedSystem,
  type PasswordResetMailer,
} from "@alldots/data";
import { createDispatcher } from "../app.js";

// The client uploads bytes with `POST /api/blobs`, then names the blob ids in `POST /api/inbox/items`; this walks
// the two routes together. Tenant isolation is proven in `tenantIsolationRoutes.test.ts` and the data package.
const PASSWORD = "s3cret-password";
const OWNER_EMAIL = "capture-attachments-owner@example.com";
const noopMailer: PasswordResetMailer = {
  async sendPasswordResetEmail() {},
};

let pool: Pool;
const moduleRegistry = await loadFullModuleRegistry();

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PDF = Buffer.from("%PDF-1.7 a scanned receipt");
const MP3 = Buffer.from("ID3\x04\x00\x00 a voice note");

function isoBmff(majorBrand: string): Buffer {
  const box = Buffer.alloc(24);
  box.writeUInt32BE(24, 0);
  box.write("ftyp", 4, "latin1");
  box.write(majorBrand, 8, "latin1");
  return box;
}

const BODY = { text: "", date: "2026-11-02", time: "10:15", captureChannel: "typed" };

const attachmentSchema = z.object({
  attachmentId: z.string().uuid(),
  blobId: z.string().uuid(),
  mimeType: z.string(),
  byteSize: z.number(),
  source: z.string(),
});
const captureSchema = z
  .object({
    id: z.string().uuid(),
    properties: z.record(z.string(), z.unknown()),
    attachments: z.array(attachmentSchema),
  })
  .passthrough();

describe("capturing an Inbox item with uploaded blobs (issue gh-1963)", () => {
  let server: Server;
  let baseUrl: string;
  let storageDir: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    await createUser(pool, {
      email: OWNER_EMAIL,
      passwordHash: await hashPassword(PASSWORD),
      tenantId: getTenantZeroId(),
    });
    storageDir = join(tmpdir(), `alldots-test-capture-attachments-${randomUUID()}`);
    const dispatch = await createDispatcher(pool, {
      passwordResetMailer: noopMailer,
      appBaseUrl: "http://localhost",
      setupToken: "unused-setup-token",
      moduleRegistry,
      blobStorage: new LocalFsBlobStorageWriter(storageDir),
      maxFileSizeBytes: 1024,
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

  async function authHeader(): Promise<{ Authorization: string }> {
    const { token } = await login(pool, { email: OWNER_EMAIL, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
    return { Authorization: `Bearer ${token}` };
  }

  async function upload(bytes: Buffer, declaredType = "image/jpeg"): Promise<{ status: number; blobId: string }> {
    const res = await fetch(`${baseUrl}/api/blobs`, {
      method: "POST",
      headers: { ...(await authHeader()), "Content-Type": declaredType },
      body: bytes,
    });
    const parsed = z
      .object({ blobId: z.string().uuid().optional() })
      .passthrough()
      .parse(await res.json());
    return { status: res.status, blobId: parsed.blobId ?? "" };
  }

  async function capture(body: unknown) {
    return fetch(`${baseUrl}/api/inbox/items`, {
      method: "POST",
      headers: { ...(await authHeader()), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function count(sql: string): Promise<number> {
    return (await pool.query<{ n: number }>(sql)).rows[0]?.n ?? 0;
  }
  const inboxItems = () =>
    count(
      "SELECT count(*)::int AS n FROM items WHERE database_id = (SELECT id FROM databases WHERE owner_module_id = 'inbox')",
    );
  const filesItems = () =>
    count(
      "SELECT count(*)::int AS n FROM items WHERE database_id = (SELECT id FROM databases WHERE owner_module_id = 'files')",
    );
  const attachmentRows = () => count("SELECT count(*)::int AS n FROM inbox_attachments");
  async function metadataJobKeys(): Promise<string[]> {
    const { rows } = await pool.query<{ key: string | null }>(
      "SELECT key FROM graphile_worker.jobs WHERE task_identifier = 'inboxAttachmentMetadata' ORDER BY key",
    );
    return rows.map((row) => row.key ?? "");
  }

  async function storedFiles(): Promise<number> {
    try {
      return (await readdir(storageDir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).length;
    } catch {
      return 0;
    }
  }

  it("captures an uploaded photo without any text as an Inbox item with one attachment and no Files item", async () => {
    const photo = await upload(JPEG);
    expect(photo.status).toBe(201);

    const res = await capture({ ...BODY, attachments: [{ blobId: photo.blobId, source: "camera" }] });

    expect(res.status).toBe(201);
    const body = captureSchema.parse(await res.json());
    expect(body.properties).toMatchObject({ text: "", date: BODY.date, time: BODY.time });
    expect(body.attachments).toEqual([
      {
        attachmentId: expect.any(String),
        blobId: photo.blobId,
        mimeType: "image/jpeg",
        byteSize: JPEG.length,
        source: "camera",
      },
    ]);
    expect(await inboxItems()).toBe(1);
    expect(await attachmentRows()).toBe(1);
    expect(await filesItems()).toBe(0);
    expect(await metadataJobKeys()).toEqual([`inbox-attachment-metadata:${body.attachments[0]?.attachmentId}`]);
  });

  it("captures a PDF and an M4A recording as two attachments in the order they were sent", async () => {
    const pdf = await upload(PDF, "application/pdf");
    const m4a = await upload(isoBmff("M4A "), "audio/x-m4a");

    const res = await capture({
      ...BODY,
      text: "Receipt and note",
      attachments: [
        { blobId: pdf.blobId, source: "files" },
        { blobId: m4a.blobId, source: "share" },
      ],
    });

    expect(res.status).toBe(201);
    const body = captureSchema.parse(await res.json());
    expect(body.attachments.map((entry) => [entry.blobId, entry.mimeType, entry.source])).toEqual([
      [pdf.blobId, "application/pdf", "files"],
      [m4a.blobId, "audio/mp4", "share"],
    ]);
    expect(await metadataJobKeys()).toEqual(
      body.attachments.map((entry) => `inbox-attachment-metadata:${entry.attachmentId}`).sort(),
    );
  });

  it("stores an MP3 body labeled image/jpeg as audio/mpeg, and it attaches as such", async () => {
    const mp3 = await upload(MP3, "image/jpeg");
    expect(mp3.status).toBe(201);
    expect(
      (await pool.query<{ mime_type: string }>("SELECT mime_type FROM blobs WHERE id = $1", [mp3.blobId])).rows,
    ).toEqual([{ mime_type: "audio/mpeg" }]);

    const body = captureSchema.parse(
      await (await capture({ ...BODY, attachments: [{ blobId: mp3.blobId, source: "files" }] })).json(),
    );

    expect(body.attachments[0]).toMatchObject({ blobId: mp3.blobId, mimeType: "audio/mpeg" });
  });

  it("refuses an uploaded HEIC blob with 415 unsupported_attachment_type, and creates no item and no attachment", async () => {
    const pdf = await upload(PDF, "application/pdf");
    const heic = await upload(isoBmff("heic"), "image/heic");
    expect(heic.status).toBe(201);

    const res = await capture({
      ...BODY,
      attachments: [
        { blobId: pdf.blobId, source: "files" },
        { blobId: heic.blobId, source: "photoLibrary" },
      ],
    });

    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({
      error: { code: "unsupported_attachment_type", details: { blobId: heic.blobId, mimeType: "image/heic" } },
    });
    expect(await inboxItems()).toBe(0);
    expect(await attachmentRows()).toBe(0);
  });

  it("refuses an unknown blob id with 400 validation_failed on attachments, and creates nothing", async () => {
    const pdf = await upload(PDF, "application/pdf");

    const res = await capture({
      ...BODY,
      attachments: [
        { blobId: pdf.blobId, source: "files" },
        { blobId: randomUUID(), source: "files" },
      ],
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: "validation_failed", details: { field: "attachments" } } });
    expect(await inboxItems()).toBe(0);
    expect(await attachmentRows()).toBe(0);
  });

  it("answers 400 for eleven attachments and for a repeated blobId, and creates nothing", async () => {
    const blobs = await Promise.all(
      Array.from({ length: 11 }, (_, index) => upload(Buffer.from(`%PDF-1.7 page ${index}`), "application/pdf")),
    );

    const eleven = await capture({
      ...BODY,
      attachments: blobs.map(({ blobId }) => ({ blobId, source: "scan" })),
    });
    const repeated = await capture({
      ...BODY,
      attachments: [
        { blobId: blobs[0]!.blobId, source: "scan" },
        { blobId: blobs[0]!.blobId, source: "files" },
      ],
    });
    const ten = await capture({
      ...BODY,
      attachments: blobs.slice(0, 10).map(({ blobId }) => ({ blobId, source: "scan" })),
    });

    expect(eleven.status).toBe(400);
    expect(repeated.status).toBe(400);
    expect(ten.status).toBe(201);
    expect(await inboxItems()).toBe(1);
    expect(await attachmentRows()).toBe(10);
  });

  it("answers an empty attachments list for a capture of text alone", async () => {
    const res = await capture({ ...BODY, text: "Call the dentist" });

    expect(res.status).toBe(201);
    expect(captureSchema.parse(await res.json()).attachments).toEqual([]);
  });

  it("refuses a capture with neither text nor an attachment with 400 on text", async () => {
    const res = await capture(BODY);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "validation_failed", details: { field: "text" } } });
    expect(await inboxItems()).toBe(0);
  });

  it("answers 415 to an executable uploaded to POST /api/blobs and keeps no bytes", async () => {
    const res = await upload(Buffer.from("MZ\x90\x00\x03\x00\x00\x00 program"), "application/x-msdownload");

    expect(res.status).toBe(415);
    expect(await storedFiles()).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM blobs")).toBe(0);
  });
});
