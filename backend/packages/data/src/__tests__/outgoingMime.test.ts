import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { simpleParser } from "mailparser";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { getTenantZeroId, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createBlob } from "../blobs/blobsStore.js";
import { ValidationError } from "../errors.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";
import {
  buildOutgoingMime,
  generateOutgoingMessageId,
  OutgoingAttachmentMissingError,
  type OutgoingMimeInput,
} from "../mail/outgoingMime.js";

let pool: Pool;

/** In-memory root: only `readStream` is exercised by the builder. */
class MemoryRoot implements BlobStorageWriter {
  readonly bytesByKey = new Map<string, Buffer>();

  async writeStream(): Promise<{ byteSize: number; contentHash: string }> {
    throw new Error("not used");
  }

  async delete(): Promise<void> {}

  readStream(storageKey: string): Readable {
    const bytes = this.bytesByKey.get(storageKey);
    if (!bytes) {
      const err = Object.assign(new Error("missing"), { code: "ENOENT" });
      return new Readable({
        read() {
          this.destroy(err);
        },
      });
    }
    return Readable.from([bytes]);
  }
}

async function inRolledBackTransaction(fn: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [getTenantZeroId()]);
    await fn(client);
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
}

const base: OutgoingMimeInput = {
  from: { name: "Ann", address: "ann@example.com" },
  to: [{ name: "Bob", address: "bob@example.com" }],
  cc: [{ address: "cc@example.com" }],
  bcc: [{ address: "secret@example.com" }],
  subject: "Hello",
  text: "Plain body",
  messageId: "<fixed@example.com>",
};

async function storeBlob(client: PoolClient, root: MemoryRoot, bytes: Buffer): Promise<string> {
  const storageKey = `${getTenantZeroId()}/${randomUUID()}`;
  root.bytesByKey.set(storageKey, bytes);
  const blob = await createBlob(client, {
    mimeType: "application/octet-stream",
    byteSize: bytes.length,
    storageKey,
  });
  return blob.id;
}

describe("buildOutgoingMime", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("builds headers, a text/plain body and attachments with identical bytes from either root", async () => {
    const files = new MemoryRoot();
    const mail = new MemoryRoot();
    const filesBytes = Buffer.from([0, 1, 2, 250, 251, 252, 13, 10, 0]);
    const mailBytes = Buffer.from("mail attachment bytes");
    await inRolledBackTransaction(async (client) => {
      const a = await storeBlob(client, files, filesBytes);
      const b = await storeBlob(client, mail, mailBytes);
      const result = await buildOutgoingMime(
        {
          ...base,
          inReplyTo: "<parent@example.com>",
          references: ["<root@example.com>", "<parent@example.com>"],
          attachments: [
            { filename: "a.bin", contentType: "application/octet-stream", blobId: a },
            { filename: "b.bin", contentType: "application/octet-stream", blobId: b },
          ],
        },
        { client, files, mailAttachments: mail },
      );
      const parsed = await simpleParser(result.raw);
      expect(parsed.messageId).toBe("<fixed@example.com>");
      expect(result.messageId).toBe("<fixed@example.com>");
      expect(parsed.inReplyTo).toBe("<parent@example.com>");
      expect(parsed.references).toEqual(["<root@example.com>", "<parent@example.com>"]);
      expect(parsed.text?.trim()).toBe("Plain body");
      expect(parsed.html).toBe(false);
      expect(parsed.attachments.map((x) => x.filename)).toEqual(["a.bin", "b.bin"]);
      expect(parsed.attachments[0]?.content).toEqual(filesBytes);
      expect(parsed.attachments[1]?.content).toEqual(mailBytes);
    });
  });

  it("adds a text/calendar alternative with the method parameter", async () => {
    await inRolledBackTransaction(async (client) => {
      const result = await buildOutgoingMime(
        { ...base, calendar: { method: "REQUEST", content: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n" } },
        { client, files: new MemoryRoot(), mailAttachments: new MemoryRoot() },
      );
      const text = result.raw.toString("utf8");
      expect(text).toMatch(
        /Content-Type: text\/calendar; charset="?utf-8"?; method=REQUEST|Content-Type: text\/calendar; method=REQUEST/i,
      );
      const parsed = await simpleParser(result.raw);
      expect(parsed.text?.trim()).toBe("Plain body");
    });
  });

  it("keeps bcc in the envelope only", async () => {
    await inRolledBackTransaction(async (client) => {
      const result = await buildOutgoingMime(base, {
        client,
        files: new MemoryRoot(),
        mailAttachments: new MemoryRoot(),
      });
      expect(result.envelopeRecipients).toEqual(["bob@example.com", "cc@example.com", "secret@example.com"]);
      expect(result.raw.toString("utf8")).not.toContain("secret@example.com");
      expect(result.raw.toString("utf8").toLowerCase()).not.toContain("bcc:");
    });
  });

  it.each([
    ["subject", { subject: "Hi\r\nBcc: evil@example.com" }],
    ["message id", { messageId: "<id@example.com>\r\nX: injected" }],
    ["in-reply-to", { inReplyTo: "<id@example.com>\nX: injected" }],
    ["second reference", { references: ["<ok@example.com>", "<id@example.com>\rX: injected"] }],
    ["from address", { from: { address: "a@example.com\nX: injected" } }],
    ["from display name", { from: { name: "Alice\nX: injected", address: "a@example.com" } }],
    ["to address", { to: [{ address: "a@example.com\nX: injected" }] }],
    ["display name", { to: [{ name: "Bob\nX-Evil: 1", address: "bob@example.com" }] }],
    ["address", { cc: [{ address: "a@example.com\r\nX-Evil: 1" }] }],
    ["cc display name", { cc: [{ name: "Cc\nX: injected", address: "a@example.com" }] }],
    ["bcc address", { bcc: [{ address: "a@example.com\nX: injected" }] }],
    ["bcc display name", { bcc: [{ name: "Bcc\nX: injected", address: "a@example.com" }] }],
    [
      "attachment filename",
      { attachments: [{ filename: "a\r\nX: 1", contentType: "text/plain", blobId: randomUUID() }] },
    ],
    [
      "attachment content type",
      { attachments: [{ filename: "a.txt", contentType: "text/plain\nX: injected", blobId: randomUUID() }] },
    ],
  ])("throws when the %s contains a line break", async (_label, patch) => {
    await inRolledBackTransaction(async (client) => {
      await expect(
        buildOutgoingMime(
          { ...base, ...patch },
          { client, files: new MemoryRoot(), mailAttachments: new MemoryRoot() },
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it("fails with a typed error when the blob row is missing", async () => {
    await inRolledBackTransaction(async (client) => {
      await expect(
        buildOutgoingMime(
          { ...base, attachments: [{ filename: "x", contentType: "text/plain", blobId: randomUUID() }] },
          { client, files: new MemoryRoot(), mailAttachments: new MemoryRoot() },
        ),
      ).rejects.toBeInstanceOf(OutgoingAttachmentMissingError);
    });
  });

  it("fails with a typed error when the bytes are in neither root", async () => {
    await inRolledBackTransaction(async (client) => {
      const donor = new MemoryRoot();
      const blobId = await storeBlob(client, donor, Buffer.from("gone"));
      await expect(
        buildOutgoingMime(
          { ...base, attachments: [{ filename: "x", contentType: "text/plain", blobId }] },
          { client, files: new MemoryRoot(), mailAttachments: new MemoryRoot() },
        ),
      ).rejects.toBeInstanceOf(OutgoingAttachmentMissingError);
    });
  });

  it("rejects attachments above the size cap", async () => {
    await inRolledBackTransaction(async (client) => {
      const files = new MemoryRoot();
      const blobId = await storeBlob(client, files, Buffer.alloc(20));
      await expect(
        buildOutgoingMime(
          { ...base, attachments: [{ filename: "x", contentType: "text/plain", blobId }] },
          { client, files, mailAttachments: new MemoryRoot(), maxAttachmentBytes: 10 },
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });
});

describe("generateOutgoingMessageId", () => {
  it("uses the sender's domain", () => {
    expect(generateOutgoingMessageId("a@example.org")).toMatch(/^<[0-9a-f-]{36}@example\.org>$/);
  });
});
