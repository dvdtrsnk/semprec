import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BlobReadCleanupError, labeledSempMessageRefSchema, runInTenant } from "@semprec/shared";
import {
  createChokePoint,
  createItemWithClient,
  getDatabaseByModuleId,
  ingestUploadedBlob,
  listPropertiesByDatabase,
  LocalFsBlobStorageWriter,
  resolveMailModuleIds,
  seedSystem,
  withTransaction,
} from "@semprec/data";
import {
  createRuntimeRolePool,
  createTestTenant,
  ensureFolderItem,
  getTestPool,
  ingestEmailMessage,
  resetDatabase,
} from "@semprec/data/testSupport";
import { expandSempRefs } from "../refExpansion.js";

function pdfFixture(): Buffer {
  const stream = "BT /F1 24 Tf 20 100 Td (PDF reference sentinel) Tj ET";
  const objects = [
    "",
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 300 300] /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 1; i < objects.length; i += 1) {
    offsets[i] = Buffer.byteLength(body);
    body += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i += 1) body += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  return Buffer.from(`${body}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
}

describe("tenant-scoped reference blob expansion", () => {
  let admin: Pool;
  let runtime: Pool;
  let tenant: string;
  let foreign: string;
  let root: string;
  let files: LocalFsBlobStorageWriter;
  let mailAttachments: LocalFsBlobStorageWriter;

  beforeAll(async () => {
    admin = getTestPool();
    await resetDatabase(admin);
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    tenant = await createTestTenant(admin);
    foreign = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(runtime));
    await runInTenant(foreign, () => seedSystem(runtime));
    root = await mkdtemp(join(tmpdir(), "semp-ref-expansion-"));
    files = new LocalFsBlobStorageWriter(join(root, "files"));
    mailAttachments = new LocalFsBlobStorageWriter(join(root, "mail"));
  });
  afterAll(async () => {
    const errors: unknown[] = [];
    try {
      await runtime?.end();
    } catch (error) {
      errors.push(error);
    }
    try {
      await admin?.end();
    } catch (error) {
      errors.push(error);
    }
    try {
      if (root) await rm(root, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, "Reference fixture cleanup failed", { cause: errors[0] });
  });

  async function createFile(owner: string, name: string, bytes: Buffer) {
    return runInTenant(owner, async () => {
      const upload = await ingestUploadedBlob(runtime, {
        mimeType: "application/octet-stream",
        source: Readable.from([bytes]),
        maxBytes: bytes.length + 1,
        storage: files,
      });
      const db = await withTransaction(runtime, (client) => getDatabaseByModuleId(client, "files"));
      if (!db) throw new Error("Missing Files database");
      const item = await createChokePoint(runtime).createItem({
        databaseId: db.id,
        properties: { name, file: { blobId: upload.blob.id } },
      });
      return { kind: "item" as const, databaseId: db.id, itemId: item.id };
    });
  }

  it("extracts real PDF and DOCX bytes and turns a current image into an ephemeral JPEG", async () => {
    const docx = await readFile(join(dirname(fileURLToPath(import.meta.url)), "fixtures/reference-text.docx"));
    const image = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: "#abc123" } })
      .png()
      .toBuffer();
    const refs = [
      await createFile(tenant, "PDF", pdfFixture()),
      await createFile(tenant, "DOCX", docx),
      await createFile(tenant, "Image", image),
    ];
    const opened: Readable[] = [];
    const realRead = files.readStream.bind(files);
    const observer = vi.spyOn(files, "readStream").mockImplementation((key, range) => {
      const stream = realRead(key, range);
      opened.push(stream);
      return stream;
    });
    let result: Awaited<ReturnType<typeof expandSempRefs>>;
    try {
      result = await runInTenant(tenant, () => expandSempRefs(runtime, refs, { files, mailAttachments }));
      expect(opened).toHaveLength(3);
      expect(opened.every((stream) => stream.closed)).toBe(true);
    } finally {
      observer.mockRestore();
    }
    expect(result.text).toContain("PDF reference sentinel");
    expect(result.text).toContain("DOCX reference sentinel");
    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.mimeType).toBe("image/jpeg");
    expect(result.context).toHaveLength(3);
    expect(JSON.stringify(result.context)).not.toContain(result.images[0]?.data ?? "missing");
  });

  it("stops before the next reference on a synthetic post-transfer cleanup failure", async () => {
    const first = await createFile(tenant, "First PDF", pdfFixture());
    const second = await createFile(tenant, "Second PDF", Buffer.concat([pdfFixture(), Buffer.from("next")]));
    const cleanupFailure = new Error("synthetic post-read transport error");
    const realRead = files.readStream.bind(files);
    const opened: Readable[] = [];
    const observer = vi.spyOn(files, "readStream").mockImplementation((key, range) => {
      const stream = realRead(key, range);
      opened.push(stream);
      if (opened.length === 1) {
        stream.once("end", () => {
          queueMicrotask(() => stream.emit("error", cleanupFailure));
        });
      }
      return stream;
    });
    try {
      let caught: unknown;
      try {
        await runInTenant(tenant, () => expandSempRefs(runtime, [first, second], { files, mailAttachments }));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(BlobReadCleanupError);
      if (!(caught instanceof BlobReadCleanupError)) throw new Error("Missing cleanup failure");
      expect(caught.errors).toContain(cleanupFailure);
      expect(opened).toHaveLength(1);
      expect(opened[0]?.closed).toBe(true);
    } finally {
      observer.mockRestore();
    }
  });

  it("preserves an aborted read as primary when a synthetic cleanup error follows", async () => {
    const first = await createFile(tenant, "Abort PDF", pdfFixture());
    const second = await createFile(tenant, "Later PDF", Buffer.concat([pdfFixture(), Buffer.from("later")]));
    const controller = new AbortController();
    const abortReason = new Error("synthetic turn cancellation");
    const cleanupFailure = new Error("synthetic cleanup error after cancellation");
    const realRead = files.readStream.bind(files);
    const opened: Readable[] = [];
    const observer = vi.spyOn(files, "readStream").mockImplementation((key, range) => {
      const stream = realRead(key, range);
      opened.push(stream);
      if (opened.length === 1) {
        stream.once("end", () => {
          controller.abort(abortReason);
          queueMicrotask(() => stream.emit("error", cleanupFailure));
        });
      }
      return stream;
    });
    try {
      let caught: unknown;
      try {
        await runInTenant(tenant, () =>
          expandSempRefs(runtime, [first, second], { files, mailAttachments }, controller.signal),
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(BlobReadCleanupError);
      if (!(caught instanceof BlobReadCleanupError)) throw new Error("Missing cleanup failure");
      expect(caught.errors).toEqual([abortReason, cleanupFailure]);
      expect(caught.cause).toBe(abortReason);
      expect(opened).toHaveLength(1);
      expect(opened[0]?.closed).toBe(true);
    } finally {
      observer.mockRestore();
    }
  });

  it("waits for delayed post-transfer closure before returning an ordinary placeholder", async () => {
    const ref = await createFile(tenant, "Delayed PDF", pdfFixture());
    let release: (() => void) | undefined;
    const stream = new Readable({
      read() {
        this.push(Buffer.from("%PDF-corrupt"));
        this.push(null);
      },
      destroy(_error, callback) {
        release = () => callback(null);
      },
    });
    const closed = new Promise<void>((resolve) => stream.once("close", resolve));
    const realRead = files.readStream.bind(files);
    let reads = 0;
    const observer = vi.spyOn(files, "readStream").mockImplementation((key, range) => {
      reads += 1;
      return reads === 1 ? stream : realRead(key, range);
    });
    let returned = false;
    const expansion = runInTenant(tenant, () => expandSempRefs(runtime, [ref], { files, mailAttachments })).then(
      (result) => {
        returned = true;
        return result;
      },
    );
    try {
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      expect(returned).toBe(false);
      expect(stream.closed).toBe(false);
      if (!release) throw new Error("Missing controlled destroy callback");
      release();
      release = undefined;
      const result = await expansion;
      expect(stream.closed).toBe(true);
      expect(result.text).toContain("Attachment text unavailable.");
      expect(result.context).toEqual([{ ...ref, label: "Delayed PDF" }]);
    } finally {
      if (!stream.destroyed) stream.destroy();
      if (release) release();
      await closed;
      await Promise.allSettled([expansion]);
      observer.mockRestore();
    }
  });

  it.each([
    ["over-cap bytes", () => Readable.from([Buffer.alloc(10 * 1024 * 1024 + 1)])],
    ["invalid chunk", () => Readable.from([{ invalid: true }])],
    [
      "read error",
      () => {
        let started = false;
        return new Readable({
          read() {
            if (started) return;
            started = true;
            this.push(Buffer.from("%PDF-"));
            setImmediate(() => this.destroy(new Error("synthetic transport read failure")));
          },
        });
      },
    ],
  ])("closes a controlled %s stream before an unavailable note and next real ref", async (_case, createStream) => {
    const first = await createFile(tenant, "Fault PDF", pdfFixture());
    const second = await createFile(tenant, "Next PDF", Buffer.concat([pdfFixture(), Buffer.from("next")]));
    const stream = createStream();
    const realRead = files.readStream.bind(files);
    let reads = 0;
    const observer = vi.spyOn(files, "readStream").mockImplementation((key, range) => {
      reads += 1;
      return reads === 1 ? stream : realRead(key, range);
    });
    try {
      const result = await runInTenant(tenant, () =>
        expandSempRefs(runtime, [first, second], { files, mailAttachments }),
      );
      expect(stream.closed).toBe(true);
      expect(reads).toBe(2);
      expect(result.text).toContain("Attachment text unavailable.");
      expect(result.text).toContain("PDF reference sentinel");
    } finally {
      observer.mockRestore();
    }
  });

  it("waits for post-transfer cleanup before propagating a cancelled read", async () => {
    const ref = await createFile(tenant, "Cancelled PDF", pdfFixture());
    const controller = new AbortController();
    const reason = new Error("synthetic cancellation during byte read");
    let release: (() => void) | undefined;
    let started!: () => void;
    const readable = new Promise<void>((resolve) => {
      started = resolve;
    });
    const stream = new Readable({
      read() {
        this.push(Buffer.from("%PDF-"));
        started();
      },
      destroy(_error, callback) {
        release = () => callback(null);
      },
    });
    const closed = new Promise<void>((resolve) => stream.once("close", resolve));
    const observer = vi.spyOn(files, "readStream").mockReturnValue(stream);
    const outcome = runInTenant(tenant, () =>
      expandSempRefs(runtime, [ref], { files, mailAttachments }, controller.signal),
    ).then(
      () => ({ kind: "success" as const }),
      (error: unknown) => ({ kind: "failure" as const, error }),
    );
    let settled = false;
    void outcome.then(() => {
      settled = true;
    });
    try {
      await readable;
      controller.abort(reason);
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      expect(settled).toBe(false);
      expect(stream.closed).toBe(false);
      if (!release) throw new Error("Missing controlled destroy callback");
      release();
      release = undefined;
      expect(await outcome).toEqual({ kind: "failure", error: reason });
      expect(stream.closed).toBe(true);
    } finally {
      controller.abort(reason);
      if (!stream.destroyed) stream.destroy();
      if (release) release();
      await closed;
      await outcome;
      observer.mockRestore();
    }
  });

  it("fails expansion at the cleanup deadline and observes eventual stream closure", async () => {
    const first = await createFile(tenant, "Stalled PDF", pdfFixture());
    const second = await createFile(tenant, "Unreached PDF", Buffer.concat([pdfFixture(), Buffer.from("last")]));
    let release: (() => void) | undefined;
    const stream = new Readable({
      read() {
        this.push(Buffer.from("%PDF-corrupt"));
        this.push(null);
      },
      destroy(_error, callback) {
        release = () => callback(null);
      },
    });
    const closed = new Promise<void>((resolve) => stream.once("close", resolve));
    const realRead = files.readStream.bind(files);
    let reads = 0;
    const observer = vi.spyOn(files, "readStream").mockImplementation((key, range) => {
      reads += 1;
      return reads === 1 ? stream : realRead(key, range);
    });
    try {
      let caught: unknown;
      try {
        await runInTenant(tenant, () => expandSempRefs(runtime, [first, second], { files, mailAttachments }));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(BlobReadCleanupError);
      if (!(caught instanceof BlobReadCleanupError)) throw new Error("Missing cleanup deadline failure");
      expect(caught.errors).toHaveLength(1);
      expect(caught.errors[0]).toBeInstanceOf(Error);
      expect(stream.closed).toBe(false);
      expect(reads).toBe(1);
    } finally {
      if (!stream.destroyed) stream.destroy();
      if (release) release();
      await closed;
      observer.mockRestore();
    }
    expect(stream.closed).toBe(true);
  }, 15_000);

  it("expands real mail text bytes ephemerally and refuses foreign, random and invalid UTF-8 references", async () => {
    const createMail = (owner: string, attachments: Array<{ filename: string; bytes: Buffer }>) =>
      runInTenant(owner, () =>
        withTransaction(runtime, async (client) => {
          const ids = await resolveMailModuleIds(client);
          const emailProperties = await listPropertiesByDatabase(client, ids.emailsDatabaseId);
          const folderProperties = await listPropertiesByDatabase(client, ids.foldersDatabaseId);
          const attachment = emailProperties.find((property) => property.key === "attachments");
          const folder = emailProperties.find((property) => property.key === "folder");
          const mailbox = folderProperties.find((property) => property.key === "mailbox");
          if (!attachment || !folder || !mailbox) throw new Error("Missing mail fixture relations");
          const mailboxItem = await createItemWithClient(client, {
            databaseId: ids.mailboxesDatabaseId,
            properties: { name: "Mail" },
          });
          const folderId = await ensureFolderItem(client, {
            foldersDatabaseId: ids.foldersDatabaseId,
            mailboxItemId: mailboxItem.id,
            mailboxRelationPropertyId: mailbox.id,
            providerId: "INBOX",
            name: "Inbox",
            behavior: "folder",
            specialPurpose: "inbox",
          });
          const email = await ingestEmailMessage(client, {
            emailsDatabaseId: ids.emailsDatabaseId,
            filesDatabaseId: ids.filesDatabaseId,
            folderRelationPropertyId: folder.id,
            attachmentsRelationPropertyId: attachment.id,
            folderItemId: folderId,
            mailboxItemId: mailboxItem.id,
            messageId: `<${randomUUID()}@example.test>`,
            subject: "Fixture",
            envelope: {},
            attachments: attachments.map(({ filename, bytes }) => ({
              filename,
              contentType: "text/plain",
              contentId: null,
              disposition: "attachment",
              openStream: () => Readable.from([bytes]),
            })),
            storage: mailAttachments,
            storageKeyPrefix: "semp-ref-fixture",
          });
          const result = await client.query<{ id: string; filename: string; content_type: string; mime_type: string }>(
            `SELECT attachment.id, attachment.filename, attachment.content_type, blob.mime_type
           FROM mail_attachments attachment JOIN blobs blob ON blob.tenant_id = attachment.tenant_id AND blob.id = attachment.blob_id
           WHERE attachment.message_item_id = $1 ORDER BY attachment.filename`,
            [email.itemId],
          );
          return result.rows;
        }),
      );
    const own = await createMail(tenant, [
      { filename: "plain.txt", bytes: Buffer.from("Mail text fixture sentinel") },
      { filename: "invalid.txt", bytes: Buffer.from([0xff, 0xfe]) },
    ]);
    const privateRows = await createMail(foreign, [
      { filename: "private.txt", bytes: Buffer.from("Foreign fixture sentinel") },
    ]);
    expect(own.map(({ filename, content_type, mime_type }) => ({ filename, content_type, mime_type }))).toEqual([
      { filename: "invalid.txt", content_type: "text/plain", mime_type: "text/plain" },
      { filename: "plain.txt", content_type: "text/plain", mime_type: "text/plain" },
    ]);
    const plain = own.find((row) => row.filename === "plain.txt");
    const invalid = own.find((row) => row.filename === "invalid.txt");
    const privateRow = privateRows[0];
    if (!plain || !invalid || !privateRow) throw new Error("Missing ingested fixture attachments");
    const refs = [plain.id, invalid.id, privateRow.id, randomUUID()].map((attachmentId) => ({
      kind: "mailAttachment" as const,
      attachmentId,
    }));
    await runInTenant(tenant, async () => {
      const snapshot = () =>
        runtime.query(
          `SELECT (SELECT count(*)::int FROM items) AS items,
            (SELECT count(*)::int FROM item_relations) AS edges,
            (SELECT count(*)::int FROM blobs) AS blobs,
            (SELECT count(*)::int FROM mail_attachments) AS attachments,
            (SELECT count(*)::int FROM item_search_index) AS search,
            (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM mail_attachments a WHERE a.id = ANY($1::uuid[])) AS attachment_rows,
            (SELECT jsonb_agg(to_jsonb(b) ORDER BY b.id) FROM blobs b WHERE b.id IN
              (SELECT a.blob_id FROM mail_attachments a WHERE a.id = ANY($1::uuid[]))) AS blob_rows,
            (SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM items i WHERE i.id IN
              (SELECT a.message_item_id FROM mail_attachments a WHERE a.id = ANY($1::uuid[]))) AS message_rows,
            (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.item_id) FROM item_search_index s WHERE s.item_id IN
              (SELECT a.message_item_id FROM mail_attachments a WHERE a.id = ANY($1::uuid[]))) AS search_rows`,
          [own.map((row) => row.id)],
        );
      const before = await snapshot();
      const opened: Readable[] = [];
      const realRead = mailAttachments.readStream.bind(mailAttachments);
      const observer = vi.spyOn(mailAttachments, "readStream").mockImplementation((key, range) => {
        const stream = realRead(key, range);
        opened.push(stream);
        return stream;
      });
      let result: Awaited<ReturnType<typeof expandSempRefs>>;
      try {
        result = await expandSempRefs(runtime, refs, { files, mailAttachments }, new AbortController().signal);
        expect(opened).toHaveLength(2);
        expect(opened.every((stream) => stream.closed)).toBe(true);
      } finally {
        observer.mockRestore();
      }
      expect(result.text).toContain("Mail text fixture sentinel");
      expect(result.text).toContain('"mimeType":"text/plain"');
      expect(result.text).toContain("Attachment text unavailable.");
      expect(result.text).not.toContain("Foreign fixture sentinel");
      expect(result.context.map((entry) => entry.label)).toEqual(["plain.txt", "invalid.txt", "", ""]);
      expect(result.context).toEqual(
        refs.map((ref, index) => ({ ...ref, label: ["plain.txt", "invalid.txt", "", ""][index] })),
      );
      expect(JSON.stringify(result.context)).not.toContain("Mail text fixture sentinel");
      expect(JSON.stringify(result.context)).not.toContain(
        Buffer.from("Mail text fixture sentinel").toString("base64"),
      );
      expect((await snapshot()).rows).toEqual(before.rows);
    });
  });

  it("keeps metadata and finite notes for corrupt, oversized and unsupported inputs, and refuses foreign and random refs", async () => {
    const corrupt = await createFile(tenant, "Corrupt", Buffer.from("%PDF-corrupt"));
    const large = await createFile(
      tenant,
      "Large",
      Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(10 * 1024 * 1024)]),
    );
    const unknown = await createFile(tenant, "Unknown", Buffer.from("unknown payload"));
    const other = await createFile(foreign, "Private", pdfFixture());
    const before = await runInTenant(tenant, () =>
      runtime.query<{ count: number }>("SELECT count(*)::int AS count FROM blobs"),
    );
    const result = await runInTenant(tenant, () =>
      expandSempRefs(runtime, [corrupt, large, unknown, other, { ...corrupt, itemId: randomUUID() }], {
        files,
        mailAttachments,
      }),
    );
    expect(result.text).toContain("Attachment text unavailable.");
    expect(result.text).toContain("Attachment exceeds the size limit.");
    expect(result.text).toContain("Attachment type cannot be extracted.");
    expect(result.text).not.toContain("Private");
    expect(result.images).toEqual([]);
    expect(result.context.map((ref) => ref.label)).toEqual(["Corrupt", "Large", "Unknown", "", ""]);
    const after = await runInTenant(tenant, () =>
      runtime.query<{ count: number }>("SELECT count(*)::int AS count FROM blobs"),
    );
    expect(after.rows).toEqual(before.rows);
  });

  it("preserves historical labels while fresh unavailable references carry empty labels", async () => {
    const own = await createFile(tenant, "Current label", Buffer.from("unsupported"));
    const other = await createFile(foreign, "Foreign label", Buffer.from("unsupported"));
    const missing = { ...own, itemId: randomUUID() };
    const refs = [own, other, missing, { ...own, label: "Historical label" }, { ...missing, label: "Old missing" }];
    const result = await runInTenant(tenant, () => expandSempRefs(runtime, refs, { files, mailAttachments }));
    expect(result.context).toEqual([
      { ...own, label: "Current label" },
      { ...other, label: "" },
      { ...missing, label: "" },
      { ...own, label: "Historical label" },
      { ...missing, label: "Old missing" },
    ]);
    for (const ref of result.context) expect(labeledSempMessageRefSchema.safeParse(ref).success).toBe(true);
    const sections = result.text.split("\n\n");
    expect(sections).toHaveLength(refs.length);
    expect(sections[0]).toContain("item: Current label");
    expect(sections[1]).toContain("item: no longer exists or is unavailable.");
    expect(sections[2]).toContain("item: no longer exists or is unavailable.");
    expect(sections[3]).toContain("item: Current label");
    expect(sections[4]).toContain("item: no longer exists or is unavailable.");
    expect(result.text).toContain("no longer exists or is unavailable");
    expect(result.text).not.toContain("Foreign label");
  });
});
