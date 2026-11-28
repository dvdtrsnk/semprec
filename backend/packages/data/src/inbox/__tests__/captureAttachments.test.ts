import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { Pool } from "pg";
import { runInTenant } from "@alldots/shared";
import { readJobPayloadsByIdentifier } from "@alldots/queue/testSupport";
import { z } from "zod";
import { getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createRuntimeRolePool, createTestTenant, withTenantTransaction } from "../../testSupport/tenantFixtures.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createBlob, deleteBlobIfUnreferenced, lockBlobsForReference } from "../../blobs/blobsStore.js";
import { ingestUploadedBlob } from "../../blobs/fileUploadStore.js";
import type { BlobStorageWriter } from "../../mail/blobStorage.js";
import { withTransaction } from "../../db/pool.js";
import { createInboxTypeWithClient } from "../inboxTypesStore.js";
import { createCaptureInboxItemRouteHandler } from "../inboxRouteHandlers.js";
import { INBOX_ATTACHMENT_MIME_TYPES } from "../attachmentTypes.js";
import { listInboxAttachments } from "../inboxAttachmentsStore.js";
import { MAX_CAPTURE_ATTACHMENTS } from "../captureAttachments.js";
import { UnsupportedAttachmentTypeError, ValidationError } from "../../errors.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { createInboxItemWithClient } from "../inboxStore.js";

// `POST /api/inbox/items` attaching uploaded blobs, on the runtime role pool inside a tenant scope, with a second
// tenant for the cross-tenant cases.
let adminPool: Pool;
let runtimePool: Pool;
let tenantA: string;
let tenantB: string;

const BODY = { text: "Receipt", date: "2026-11-02", time: "10:15", captureChannel: "typed" } as const;

beforeAll(async () => {
  adminPool = getTestPool();
  runtimePool = await createRuntimeRolePool(adminPool, "alldots_data");
});

beforeEach(async () => {
  await resetDatabase(adminPool);
  tenantA = await createTestTenant(adminPool);
  tenantB = await createTestTenant(adminPool);
  await runInTenant(tenantA, () => seedSystem(runtimePool));
  await runInTenant(tenantB, () => seedSystem(runtimePool));
});

afterAll(async () => {
  await runtimePool?.end();
  await adminPool?.end();
});

type Answer = Awaited<ReturnType<ReturnType<typeof createCaptureInboxItemRouteHandler>>>;

function capture(tenant: string, body: unknown, headers: Record<string, string> = {}): Promise<Answer> {
  return runInTenant(tenant, () =>
    createCaptureInboxItemRouteHandler(runtimePool)({ params: {}, body, req: { headers } }),
  );
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return null;
}

function answerOf(result: Answer) {
  if (!("item" in result)) throw new Error("The route answered no item");
  return result;
}

/** A blob of the given stored type, written as the upload route's own `blobs` row would be. */
function makeBlob(tenant: string, mimeType: string, byteSize = 1234): Promise<string> {
  return withTenantTransaction(runtimePool, tenant, async (client) => {
    const blob = await createBlob(client, { mimeType, byteSize, storageKey: `${tenant}/blobs/${randomUUID()}` });
    return blob.id;
  });
}

class MemoryStorage implements BlobStorageWriter {
  readonly bytesByKey = new Map<string, Buffer>();

  async writeStream(storageKey: string, source: Readable): Promise<{ byteSize: number; contentHash: string }> {
    const chunks: Buffer[] = [];
    for await (const chunk of source) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    this.bytesByKey.set(storageKey, bytes);
    return { byteSize: bytes.length, contentHash: createHash("sha256").update(bytes).digest("hex") };
  }

  async delete(storageKey: string): Promise<void> {
    this.bytesByKey.delete(storageKey);
  }

  readStream(storageKey: string, range?: { start: number; end: number }): Readable {
    const bytes = this.bytesByKey.get(storageKey);
    if (!bytes) throw new Error(`no bytes stored for ${storageKey}`);
    return Readable.from([range ? bytes.subarray(range.start, range.end + 1) : bytes]);
  }
}

/** A blob stored the way a mail attachment is: under the type the sender declared, with the content hash of its bytes. */
function makeMailBlob(tenant: string, mimeType: string, bytes: Buffer): Promise<string> {
  return withTenantTransaction(runtimePool, tenant, async (client) => {
    const blob = await createBlob(client, {
      mimeType,
      byteSize: bytes.length,
      storageKey: `${tenant}/mail/${randomUUID()}`,
      contentHash: createHash("sha256").update(bytes).digest("hex"),
    });
    return blob.id;
  });
}

function uploadAs(tenant: string, bytes: Buffer, declaredType: string) {
  return runInTenant(tenant, () =>
    ingestUploadedBlob(runtimePool, {
      mimeType: declaredType,
      source: Readable.from([bytes]),
      maxBytes: 1024,
      storage: new MemoryStorage(),
    }),
  );
}

async function count(tenant: string, sql: string): Promise<number> {
  return withTenantTransaction(
    runtimePool,
    tenant,
    async (client) => (await client.query<{ n: number }>(sql)).rows[0]?.n ?? 0,
  );
}

const inboxItems = (tenant: string) =>
  count(
    tenant,
    "SELECT count(*)::int AS n FROM items WHERE database_id = (SELECT id FROM databases WHERE owner_module_id = 'inbox')",
  );
const filesItems = (tenant: string) =>
  count(
    tenant,
    "SELECT count(*)::int AS n FROM items WHERE database_id = (SELECT id FROM databases WHERE owner_module_id = 'files')",
  );
const attachmentRows = (tenant: string) => count(tenant, "SELECT count(*)::int AS n FROM inbox_attachments");

const metadataJobSchema = z.object({
  key: z.string(),
  max_attempts: z.number(),
  queue_name: z.string().nullable(),
});

async function metadataJobs() {
  const { rows } = await adminPool.query<Record<string, unknown>>(
    "SELECT key, max_attempts, queue_name FROM graphile_worker.jobs WHERE task_identifier = 'inboxAttachmentMetadata' ORDER BY key",
  );
  return rows.map((row) => metadataJobSchema.parse(row));
}

async function expectNothingWritten(tenant: string): Promise<void> {
  expect(await inboxItems(tenant)).toBe(0);
  expect(await attachmentRows(tenant)).toBe(0);
  expect(await metadataJobs()).toEqual([]);
}

describe("POST /api/inbox/items attachments (issue gh-1963)", () => {
  it("captures a photo with an empty text as one item and one attachment, and creates no Files item", async () => {
    const photo = await makeBlob(tenantA, "image/jpeg", 2048);

    const answer = answerOf(
      await capture(tenantA, { ...BODY, text: "", attachments: [{ blobId: photo, source: "camera" }] }),
    );

    expect(answer.status).toBe(201);
    expect(answer.item.properties).toMatchObject({ text: "" });
    expect(answer.attachments).toEqual([
      { attachmentId: expect.any(String), blobId: photo, mimeType: "image/jpeg", byteSize: 2048, source: "camera" },
    ]);
    expect(await inboxItems(tenantA)).toBe(1);
    expect(await attachmentRows(tenantA)).toBe(1);
    expect(await filesItems(tenantA)).toBe(0);
    const stored = await withTenantTransaction(runtimePool, tenantA, (client) =>
      listInboxAttachments(client, [answer.item.id]),
    );
    expect(stored).toEqual([
      expect.objectContaining({
        attachmentId: answer.attachments?.[0]?.attachmentId,
        inboxItemId: answer.item.id,
        blobId: photo,
        position: 0,
      }),
    ]);
  });

  it("accepts a text made of whitespace when the capture has an attachment", async () => {
    const photo = await makeBlob(tenantA, "image/png");

    const answer = answerOf(
      await capture(tenantA, { ...BODY, text: " \n ", attachments: [{ blobId: photo, source: "scan" }] }),
    );

    expect(answer.attachments).toHaveLength(1);
  });

  it("captures a PDF and an M4A as two attachments in array order, whatever the order the blobs were uploaded in", async () => {
    const pdf = await makeBlob(tenantA, "application/pdf", 10);
    const m4a = await makeBlob(tenantA, "audio/mp4", 20);

    const answer = answerOf(
      await capture(tenantA, {
        ...BODY,
        attachments: [
          { blobId: m4a, source: "files" },
          { blobId: pdf, source: "share" },
        ],
      }),
    );

    expect(
      answer.attachments?.map(({ blobId, mimeType, byteSize, source }) => ({ blobId, mimeType, byteSize, source })),
    ).toEqual([
      { blobId: m4a, mimeType: "audio/mp4", byteSize: 20, source: "files" },
      { blobId: pdf, mimeType: "application/pdf", byteSize: 10, source: "share" },
    ]);
    const stored = await withTenantTransaction(runtimePool, tenantA, (client) =>
      listInboxAttachments(client, [answer.item.id]),
    );
    expect(stored.map((row) => [row.blobId, row.position])).toEqual([
      [m4a, 0],
      [pdf, 1],
    ]);
  });

  it("accepts every type of the allowlist and every source", async () => {
    const sources = ["camera", "scan", "photoLibrary", "files", "share"] as const;
    const attachments = await Promise.all(
      INBOX_ATTACHMENT_MIME_TYPES.map(async (mimeType, index) => ({
        blobId: await makeBlob(tenantA, mimeType),
        source: sources[index % sources.length]!,
      })),
    );

    const answer = answerOf(await capture(tenantA, { ...BODY, attachments }));

    expect(answer.attachments?.map((entry) => entry.mimeType)).toEqual([...INBOX_ATTACHMENT_MIME_TYPES]);
    expect(answer.attachments?.map((entry) => entry.source)).toEqual(attachments.map((entry) => entry.source));
  });

  it("answers an empty attachments list for a capture without attachments, whether the key is absent or the array empty", async () => {
    expect(answerOf(await capture(tenantA, BODY)).attachments).toEqual([]);
    expect(answerOf(await capture(tenantA, { ...BODY, attachments: [] })).attachments).toEqual([]);
    expect(await attachmentRows(tenantA)).toBe(0);
  });

  it("lets two captures attach the same blob, and one capture carry the maximum of ten attachments", async () => {
    const shared = await makeBlob(tenantA, "image/png");
    await capture(tenantA, { ...BODY, attachments: [{ blobId: shared, source: "camera" }] });
    const ten = await Promise.all(
      Array.from({ length: MAX_CAPTURE_ATTACHMENTS }, async () => ({
        blobId: await makeBlob(tenantA, "image/png"),
        source: "photoLibrary" as const,
      })),
    );

    const answer = answerOf(
      await capture(tenantA, { ...BODY, attachments: [{ blobId: shared, source: "share" }, ...ten.slice(1)] }),
    );

    expect(answer.attachments).toHaveLength(MAX_CAPTURE_ATTACHMENTS);
    expect(await attachmentRows(tenantA)).toBe(1 + MAX_CAPTURE_ATTACHMENTS);
  });

  describe("refusals leave nothing behind", () => {
    it("refuses a HEIC blob with 415 unsupported_attachment_type naming the blob and its type", async () => {
      const heic = await makeBlob(tenantA, "image/heic");

      const error = await failureOf(
        capture(tenantA, { ...BODY, attachments: [{ blobId: heic, source: "photoLibrary" }] }),
      );

      expect(error).toBeInstanceOf(UnsupportedAttachmentTypeError);
      expect(error).toMatchObject({
        status: 415,
        code: "unsupported_attachment_type",
        details: { blobId: heic, mimeType: "image/heic" },
      });
      await expectNothingWritten(tenantA);
    });

    it.each(["application/octet-stream", "image/gif", "text/plain", "audio/wav", "video/mp4"])(
      "refuses a blob stored as %s",
      async (mimeType) => {
        const blob = await makeBlob(tenantA, mimeType);

        const error = await failureOf(capture(tenantA, { ...BODY, attachments: [{ blobId: blob, source: "files" }] }));

        expect(error).toMatchObject({ status: 415, details: { blobId: blob, mimeType } });
        await expectNothingWritten(tenantA);
      },
    );

    it("refuses the whole capture when one attachment of several is refused, even the last one", async () => {
      const pdf = await makeBlob(tenantA, "application/pdf");
      const mp3 = await makeBlob(tenantA, "audio/mpeg");
      const heic = await makeBlob(tenantA, "image/heic");

      const error = await failureOf(
        capture(tenantA, {
          ...BODY,
          attachments: [
            { blobId: pdf, source: "files" },
            { blobId: mp3, source: "files" },
            { blobId: heic, source: "camera" },
          ],
        }),
      );

      expect(error).toMatchObject({ code: "unsupported_attachment_type", details: { blobId: heic } });
      await expectNothingWritten(tenantA);
    });

    it("names the first refused attachment in array order", async () => {
      const heic = await makeBlob(tenantA, "image/heic");
      const gif = await makeBlob(tenantA, "image/gif");

      const error = await failureOf(
        capture(tenantA, {
          ...BODY,
          attachments: [
            { blobId: gif, source: "files" },
            { blobId: heic, source: "files" },
          ],
        }),
      );

      expect(error).toMatchObject({ details: { blobId: gif, mimeType: "image/gif" } });
    });

    it("refuses an unknown blob id on attachments, whatever the other attachments are", async () => {
      const pdf = await makeBlob(tenantA, "application/pdf");

      const error = await failureOf(
        capture(tenantA, {
          ...BODY,
          attachments: [
            { blobId: pdf, source: "files" },
            { blobId: randomUUID(), source: "files" },
          ],
        }),
      );

      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject({ status: 400, code: "validation_failed", details: { field: "attachments" } });
      await expectNothingWritten(tenantA);
    });

    it("answers the blob of another tenant exactly as it answers an unknown blob id", async () => {
      const foreign = await makeBlob(tenantA, "application/pdf");
      const own = await makeBlob(tenantB, "application/pdf");

      const foreignError = await failureOf(
        capture(tenantB, { ...BODY, attachments: [{ blobId: foreign, source: "files" }] }),
      );
      const randomError = await failureOf(
        capture(tenantB, { ...BODY, attachments: [{ blobId: randomUUID(), source: "files" }] }),
      );

      expect(foreignError).toBeInstanceOf(ValidationError);
      expect(foreignError).toMatchObject({ status: 400, code: "validation_failed", details: { field: "attachments" } });
      expect((foreignError as ValidationError).message).toBe((randomError as ValidationError).message);
      expect((foreignError as ValidationError).details).toEqual((randomError as ValidationError).details);
      await expectNothingWritten(tenantB);
      await expectNothingWritten(tenantA);
      // Tenant B's own blob still attaches, so the refusal above was the foreign id and nothing else.
      expect(
        answerOf(await capture(tenantB, { ...BODY, attachments: [{ blobId: own, source: "files" }] })).attachments,
      ).toHaveLength(1);
    });

    it("does not tell a foreign blob of a refused type from an unknown one", async () => {
      const foreignHeic = await makeBlob(tenantA, "image/heic");

      const error = await failureOf(
        capture(tenantB, { ...BODY, attachments: [{ blobId: foreignHeic, source: "files" }] }),
      );

      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).details).toEqual({ field: "attachments" });
    });

    it("refuses a refused attachment together with an archived type on typeId, before the attachments", async () => {
      const heic = await makeBlob(tenantA, "image/heic");
      const archived = await withTenantTransaction(runtimePool, tenantA, async (client) => {
        const types = await getDatabaseByModuleId(client, "inboxItemTypes");
        if (!types) throw new Error("Missing Inbox item types database");
        return createInboxTypeWithClient(client, {
          inboxItemTypesDatabaseId: types.id,
          name: "Old",
          emoji: "📝",
          processingMethod: "pageContent",
          status: "archived",
        });
      });

      const error = await failureOf(
        capture(tenantA, { ...BODY, typeId: archived.id, attachments: [{ blobId: heic, source: "files" }] }),
      );

      expect(error).toMatchObject({ code: "validation_failed", details: { field: "typeId" } });
      await expectNothingWritten(tenantA);
    });

    it("rolls the item back when the attachment insert fails after the item was created", async () => {
      const pdf = await makeBlob(tenantA, "application/pdf");
      // A trigger the insert cannot pass: the only way to fail the insert after the checks passed and the item exists.
      await adminPool.query(
        "CREATE FUNCTION fail_inbox_attachment_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'attachment insert refused'; END $$",
      );
      await adminPool.query(
        "CREATE TRIGGER fail_inbox_attachment_insert BEFORE INSERT ON inbox_attachments FOR EACH ROW EXECUTE FUNCTION fail_inbox_attachment_insert()",
      );
      try {
        const error = await failureOf(capture(tenantA, { ...BODY, attachments: [{ blobId: pdf, source: "files" }] }));

        expect(error).toMatchObject({ message: expect.stringContaining("attachment insert refused") });
        await expectNothingWritten(tenantA);
      } finally {
        await adminPool.query("DROP TRIGGER fail_inbox_attachment_insert ON inbox_attachments");
        await adminPool.query("DROP FUNCTION fail_inbox_attachment_insert()");
      }
    });
  });

  describe("the metadata job (issue gh-1965)", () => {
    const envelopeSchema = z.object({
      tenantId: z.string(),
      payload: z.object({ attachmentId: z.string() }),
    });

    it("enqueues one job for each new attachment in the capture, in the tenant of the capture, under the key of the attachment", async () => {
      const photo = await makeBlob(tenantA, "image/jpeg");
      const note = await makeBlob(tenantA, "audio/mp4");

      const answer = answerOf(
        await capture(tenantA, {
          ...BODY,
          attachments: [
            { blobId: photo, source: "camera" },
            { blobId: note, source: "files" },
          ],
        }),
      );

      const attachmentIds = (answer.attachments ?? []).map((attachment) => attachment.attachmentId).sort();
      expect(attachmentIds).toHaveLength(2);
      expect(await metadataJobs()).toEqual(
        attachmentIds.map((id) => ({
          key: `inbox-attachment-metadata:${id}`,
          max_attempts: 3,
          queue_name: expect.stringContaining(tenantA),
        })),
      );
      const envelopes = (await readJobPayloadsByIdentifier(adminPool, "inboxAttachmentMetadata")).map((raw) =>
        envelopeSchema.parse(raw),
      );
      expect(envelopes.map((envelope) => envelope.tenantId)).toEqual([tenantA, tenantA]);
      expect(envelopes.map((envelope) => envelope.payload.attachmentId).sort()).toEqual(attachmentIds);
    });

    it("enqueues no job for a capture without attachments", async () => {
      await capture(tenantA, BODY);

      expect(await metadataJobs()).toEqual([]);
    });

    it("enqueues no second job for a replay of the capture", async () => {
      const photo = await makeBlob(tenantA, "image/jpeg");
      const body = { ...BODY, attachments: [{ blobId: photo, source: "camera" }] };
      const headers = { "idempotency-key": "metadata-replay" };

      await capture(tenantA, body, headers);
      await capture(tenantA, body, headers);

      expect(await metadataJobs()).toHaveLength(1);
    });

    it("rolls the whole capture back when the job cannot be enqueued", async () => {
      const photo = await makeBlob(tenantA, "image/jpeg");
      // The queue's own table is the only place the enqueue can be refused after the item and the attachment exist.
      await adminPool.query(
        "CREATE FUNCTION fail_metadata_job_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'job insert refused'; END $$",
      );
      await adminPool.query(
        "CREATE TRIGGER fail_metadata_job_insert BEFORE INSERT ON graphile_worker._private_jobs FOR EACH ROW WHEN (NEW.key LIKE 'inbox-attachment-metadata:%') EXECUTE FUNCTION fail_metadata_job_insert()",
      );
      try {
        const error = await failureOf(
          capture(tenantA, { ...BODY, attachments: [{ blobId: photo, source: "camera" }] }),
        );

        expect(error).toMatchObject({ message: expect.stringContaining("job insert refused") });
        await expectNothingWritten(tenantA);
      } finally {
        await adminPool.query("DROP TRIGGER fail_metadata_job_insert ON graphile_worker._private_jobs");
        await adminPool.query("DROP FUNCTION fail_metadata_job_insert()");
      }
    });
  });

  describe("the body", () => {
    it.each([
      ["more than ten attachments", () => Array.from({ length: MAX_CAPTURE_ATTACHMENTS + 1 }, () => "new")],
      ["a repeated blobId", () => ["same", "same"]],
      ["a repeated blobId that differs in case", () => ["same", "SAME"]],
    ])("is a ValidationError on attachments for %s, and writes nothing", async (_name, plan) => {
      const shared = await makeBlob(tenantA, "image/png");
      const attachments = await Promise.all(
        plan().map(async (entry) => ({
          blobId:
            entry === "new" ? await makeBlob(tenantA, "image/png") : entry === "SAME" ? shared.toUpperCase() : shared,
          source: "camera",
        })),
      );

      const error = await failureOf(capture(tenantA, { ...BODY, attachments }));

      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject({ status: 400, details: { field: "attachments" } });
      await expectNothingWritten(tenantA);
    });

    it.each([
      ["attachments that are not an array", { blobId: "x", source: "camera" }],
      ["attachments of null", null],
      ["an entry that is not an object", ["text"]],
      ["an entry of null", [null]],
      ["an entry that is an array", [[]]],
      ["an entry without a blobId", [{ source: "camera" }]],
      ["a blobId that is not a string", [{ blobId: 7, source: "camera" }]],
      ["a blobId that is not a UUID", [{ blobId: "not-a-uuid", source: "camera" }]],
      ["an entry without a source", [{ blobId: randomUUID() }]],
      ["a source that is not one of the five", [{ blobId: randomUUID(), source: "email" }]],
      ["a source that is not a string", [{ blobId: randomUUID(), source: 1 }]],
      ["an unknown key in an entry", [{ blobId: randomUUID(), source: "camera", name: "a.pdf" }]],
    ])("is a ValidationError on attachments for %s, and writes nothing", async (_name, attachments) => {
      const error = await failureOf(capture(tenantA, { ...BODY, attachments }));

      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject({ status: 400, details: { field: "attachments" } });
      await expectNothingWritten(tenantA);
    });

    it("still needs a text when the capture has no attachment, also with an empty attachments array", async () => {
      for (const body of [
        { ...BODY, text: "" },
        { ...BODY, text: "", attachments: [] },
        { date: BODY.date, time: BODY.time, attachments: [] },
      ]) {
        const error = await failureOf(capture(tenantA, body));
        expect(error).toMatchObject({ code: "validation_failed", details: { field: "text" } });
      }
      await expectNothingWritten(tenantA);
    });

    it("still needs a string text with an attachment, and refuses a NUL in it", async () => {
      const photo = await makeBlob(tenantA, "image/png");
      const attachments = [{ blobId: photo, source: "camera" }];

      for (const text of [undefined, 7, "a\u0000b"]) {
        const error = await failureOf(capture(tenantA, { ...BODY, text, attachments }));
        expect(error).toMatchObject({ code: "validation_failed", details: { field: "text" } });
      }
      await expectNothingWritten(tenantA);
    });
  });

  describe("an Idempotency-Key", () => {
    it("answers a replay with the first item and its attachments, and attaches nothing a second time", async () => {
      const pdf = await makeBlob(tenantA, "application/pdf");
      const mp3 = await makeBlob(tenantA, "audio/mpeg");
      const body = {
        ...BODY,
        attachments: [
          { blobId: pdf, source: "files" },
          { blobId: mp3, source: "share" },
        ],
      };
      const headers = { "idempotency-key": "capture-attachments-1" };

      const first = answerOf(await capture(tenantA, body, headers));
      const second = answerOf(await capture(tenantA, body, headers));

      expect(second.status).toBe(201);
      expect(second.item.id).toBe(first.item.id);
      expect(second.attachments).toEqual(first.attachments);
      expect(first.attachments).toHaveLength(2);
      expect(await inboxItems(tenantA)).toBe(1);
      expect(await attachmentRows(tenantA)).toBe(2);
    });

    it("answers a replay with the original attachments whatever attachments the replay names", async () => {
      const pdf = await makeBlob(tenantA, "application/pdf");
      const headers = { "idempotency-key": "capture-attachments-2" };
      const first = answerOf(
        await capture(tenantA, { ...BODY, attachments: [{ blobId: pdf, source: "files" }] }, headers),
      );

      const replay = answerOf(
        await capture(
          tenantA,
          { ...BODY, attachments: [{ blobId: await makeBlob(tenantA, "image/png"), source: "camera" }] },
          headers,
        ),
      );

      expect(replay.item.id).toBe(first.item.id);
      expect(replay.attachments).toEqual(first.attachments);
      expect(await attachmentRows(tenantA)).toBe(1);
    });

    it("creates one item and one set of attachments for two concurrent captures of the same key", async () => {
      const pdf = await makeBlob(tenantA, "application/pdf");
      const body = { ...BODY, attachments: [{ blobId: pdf, source: "files" }] };
      const headers = { "idempotency-key": "capture-attachments-3" };

      const answers = await Promise.all([capture(tenantA, body, headers), capture(tenantA, body, headers)]);

      expect(new Set(answers.map((answer) => answerOf(answer).item.id)).size).toBe(1);
      expect(await inboxItems(tenantA)).toBe(1);
      expect(await attachmentRows(tenantA)).toBe(1);
    });

    it("does not insert attachments again when the helper replays a reserved key", async () => {
      const pdf = await makeBlob(tenantA, "application/pdf");
      const inboxDatabaseId = await withTenantTransaction(runtimePool, tenantA, async (client) => {
        const inbox = await getDatabaseByModuleId(client, "inbox");
        if (!inbox) throw new Error("Missing Inbox database");
        return inbox.id;
      });
      const input = {
        inboxDatabaseId,
        ...BODY,
        idempotencyKey: "helper-key",
        attachments: [{ blobId: pdf, source: "files" as const }],
      };

      const create = () =>
        runInTenant(tenantA, () => withTransaction(runtimePool, (client) => createInboxItemWithClient(client, input)));
      const first = await create();
      const replay = await create();

      expect(replay.id).toBe(first.id);
      expect(await attachmentRows(tenantA)).toBe(1);
    });
  });
});

describe("a blob whose stored type is not the type of its bytes (issue gh-1963)", () => {
  const MP3 = Buffer.from("ID3\x04\x00 an MP3 body");

  it("attaches the bytes of a mail attachment stored as application/octet-stream once they are uploaded", async () => {
    const mailBlob = await makeMailBlob(tenantA, "application/octet-stream", MP3);

    const uploaded = await uploadAs(tenantA, MP3, "image/jpeg");

    expect(uploaded.created).toBe(false);
    expect(uploaded.blob.id).toBe(mailBlob);
    // The first row keeps its own metadata, and the upload answers it unchanged; the verified type is recorded beside it.
    expect(uploaded.blob.mimeType).toBe("application/octet-stream");
    const row = await withTenantTransaction(
      runtimePool,
      tenantA,
      async (client) =>
        (
          await client.query<{ mime_type: string; detected_mime_type: string | null }>(
            "SELECT mime_type, detected_mime_type FROM blobs WHERE id = $1",
            [mailBlob],
          )
        ).rows[0],
    );
    expect(row).toEqual({ mime_type: "application/octet-stream", detected_mime_type: "audio/mpeg" });

    const answer = answerOf(await capture(tenantA, { ...BODY, attachments: [{ blobId: mailBlob, source: "files" }] }));

    expect(answer.status).toBe(201);
    expect(answer.attachments).toEqual([
      {
        attachmentId: expect.any(String),
        blobId: mailBlob,
        mimeType: "audio/mpeg",
        byteSize: MP3.length,
        source: "files",
      },
    ]);
    const stored = await withTenantTransaction(runtimePool, tenantA, (client) =>
      listInboxAttachments(client, [answer.item.id]),
    );
    expect(stored.map((attachment) => attachment.mimeType)).toEqual(["audio/mpeg"]);
  });

  it("still refuses the same mail attachment while its bytes have not been verified", async () => {
    const mailBlob = await makeMailBlob(tenantA, "application/octet-stream", MP3);

    const failure = await failureOf(
      capture(tenantA, { ...BODY, attachments: [{ blobId: mailBlob, source: "files" }] }),
    );

    expect(failure).toBeInstanceOf(UnsupportedAttachmentTypeError);
    expect(failure).toMatchObject({ details: { blobId: mailBlob, mimeType: "application/octet-stream" } });
    await expectNothingWritten(tenantA);
  });

  it("refuses a blob stored under an allowed type whose verified type is not allowed", async () => {
    const declared = await makeMailBlob(tenantA, "image/jpeg", Buffer.from("GIF89a not a jpeg"));
    await adminPool.query("UPDATE blobs SET detected_mime_type = 'image/gif' WHERE id = $1", [declared]);

    const failure = await failureOf(
      capture(tenantA, { ...BODY, attachments: [{ blobId: declared, source: "files" }] }),
    );

    expect(failure).toBeInstanceOf(UnsupportedAttachmentTypeError);
    expect(failure).toMatchObject({ details: { blobId: declared, mimeType: "image/gif" } });
    await expectNothingWritten(tenantA);
  });
});

describe("lockBlobsForReference (issue gh-1963)", () => {
  it("returns the blobs of the tenant in scope in id order, and nothing of another tenant", async () => {
    const own = await Promise.all([makeBlob(tenantA, "image/png"), makeBlob(tenantA, "application/pdf")]);
    const foreign = await makeBlob(tenantB, "image/png");

    const rows = await withTenantTransaction(runtimePool, tenantA, (client) =>
      lockBlobsForReference(client, [...own, foreign, randomUUID()]),
    );

    expect(rows.map((row) => row.id)).toEqual([...own].sort());
  });

  it("holds the blobs against a deleter that takes the row for update, until the transaction ends", async () => {
    const blob = await makeBlob(tenantA, "image/png");
    const holder = await runtimePool.connect();
    const deleter = await runtimePool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
      await lockBlobsForReference(holder, [blob]);

      await deleter.query("BEGIN");
      await deleter.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
      // A key share conflicts with nothing but the deleter's lock: a writer of a non-key column is not held.
      await expect(
        deleter.query("UPDATE blobs SET detected_mime_type = 'image/png' WHERE id = $1", [blob]),
      ).resolves.toMatchObject({ rowCount: 1 });
      await expect(deleter.query("SELECT id FROM blobs WHERE id = $1 FOR UPDATE NOWAIT", [blob])).rejects.toMatchObject(
        { code: "55P03" },
      );
      await deleter.query("ROLLBACK");
      await holder.query("COMMIT");

      expect(
        await withTenantTransaction(runtimePool, tenantA, (client) => deleteBlobIfUnreferenced(client, blob)),
      ).toEqual(expect.any(String));
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await deleter.query("ROLLBACK").catch(() => undefined);
      holder.release();
      deleter.release();
    }
  });
});
