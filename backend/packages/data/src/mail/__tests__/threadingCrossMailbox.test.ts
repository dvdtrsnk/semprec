import { beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, inTenantZero, resetDatabase } from "../../testSupport/testDb.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { withTransaction } from "../../db/pool.js";
import { resolveThreadId } from "../threading.js";
import { createMailThread } from "../mailMessageMetaStore.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { ingestEmailMessage } from "../ingest.js";
import type { BlobStorageWriter } from "../blobStorage.js";

let pool: Pool;
const tenantIt = (name: string, fn: () => Promise<void>) => it(name, () => inTenantZero(fn));

async function ingest(mailboxItemId: string, messageId: string, refs: string[] = []): Promise<string> {
  return withTransaction(pool, async (client) => {
    const threadId = await resolveThreadId(client, { messageId, inReplyTo: refs.at(-1) ?? null, references: refs });
    // Historical threading fixture uses mailbox ids without provisioning mailbox items.
    await client.query(
      `INSERT INTO mail_message_meta (item_id, mailbox_item_id, message_id, in_reply_to, "references", thread_id, envelope)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, '{}')`,
      [mailboxItemId, messageId, refs.at(-1) ?? null, refs, threadId],
    );
    return threadId;
  });
}

describe("cross-mailbox threading of one message", () => {
  const mailboxA = "00000000-0000-4000-8000-00000000000a";
  const mailboxB = "00000000-0000-4000-8000-00000000000b";

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  tenantIt("joins the thread of the same message in another mailbox", async () => {
    const a = await ingest(mailboxA, "<news@x>");
    const b = await ingest(mailboxB, "<news@x>");
    expect(b).toBe(a);
    const { rows } = await pool.query(`SELECT DISTINCT thread_id FROM mail_message_meta WHERE message_id = '<news@x>'`);
    expect(rows).toHaveLength(1);
  });

  tenantIt("ends in the ancestor's thread when the other mailbox's copy is in one", async () => {
    await ingest(mailboxA, "<root@x>");
    const a = await ingest(mailboxA, "<child@x>", ["<root@x>"]);
    const b = await ingest(mailboxB, "<child@x>");
    expect(b).toBe(a);
  });

  tenantIt("merges bridged threads and deletes the emptied mail_threads row", async () => {
    const t1 = await ingest(mailboxA, "<dup@x>");
    const t2 = await ingest(mailboxB, "<other@x>");
    expect(t2).not.toBe(t1);
    const merged = await ingest(mailboxB, "<dup@x>", ["<other@x>"]);
    // The other copy of the same message (t1) is consulted first and becomes the merge target.
    expect(merged).toBe(t1);
    const { rows } = await pool.query(`SELECT id FROM mail_threads WHERE id = ANY($1::uuid[])`, [[t1, t2]]);
    expect(rows).toHaveLength(1);
    const { rows: metas } = await pool.query(`SELECT DISTINCT thread_id FROM mail_message_meta`);
    expect(metas).toHaveLength(1);
  });

  tenantIt("keeps messages with different ids in separate threads", async () => {
    const a = await ingest(mailboxA, "<one@x>");
    const b = await ingest(mailboxB, "<two@x>");
    expect(b).not.toBe(a);
  });

  tenantIt("chooses the lowest thread id when existing copies disagree, regardless of insertion order", async () => {
    const first = await withTransaction(pool, (client) => createMailThread(client));
    const second = await withTransaction(pool, (client) => createMailThread(client));
    const [low, high] = [first.id, second.id].sort();
    if (!low || !high) throw new Error("Expected two threads");
    await pool.query(
      `INSERT INTO mail_message_meta (item_id, mailbox_item_id, message_id, thread_id, envelope)
       VALUES (gen_random_uuid(), $1, '<duplicate@x>', $2, '{}'),
              (gen_random_uuid(), $3, '<duplicate@x>', $4, '{}')`,
      [mailboxA, high, mailboxB, low],
    );
    const thirdMailbox = "00000000-0000-4000-8000-00000000000c";
    expect(await ingest(thirdMailbox, "<duplicate@x>")).toBe(low);
    const { rows } = await pool.query<{ thread_id: string }>(
      "SELECT thread_id FROM mail_message_meta WHERE message_id = $1",
      ["<duplicate@x>"],
    );
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.thread_id === low)).toBe(true);
    expect((await pool.query("SELECT id FROM mail_threads WHERE id = $1", [high])).rowCount).toBe(0);
  });
});

describe("cross-mailbox threading through message ingest", () => {
  tenantIt("joins two newsletter copies and merges an ancestor thread through the ingest entry point", async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool);
    const chokePoint = createChokePoint(pool);
    const { rows: databases } = await pool.query<{ id: string; owner_module_id: string }>(
      "SELECT id, owner_module_id FROM databases WHERE owner_module_id = ANY($1::text[])",
      [["emails", "files", "folders", "mailboxes"]],
    );
    const idFor = (name: string): string => {
      const row = databases.find((database) => database.owner_module_id === name);
      if (!row) throw new Error(`Missing ${name} database`);
      return row.id;
    };
    const emailsId = idFor("emails");
    const properties = await chokePoint.listProperties(emailsId);
    const propertyId = (key: string): string => {
      const property = properties.find((entry) => entry.key === key);
      if (!property) throw new Error(`Missing ${key} property`);
      return property.id;
    };
    const [mailboxA, mailboxB, folderA, folderB] = await withTransaction(pool, async (client) => {
      const a = await createItemWithClient(client, {
        databaseId: idFor("mailboxes"),
        properties: { name: "A", provider: "generic" },
      });
      const b = await createItemWithClient(client, {
        databaseId: idFor("mailboxes"),
        properties: { name: "B", provider: "generic" },
      });
      const fa = await createItemWithClient(
        client,
        { databaseId: idFor("folders"), properties: { name: "A inbox", behavior: "folder", specialPurpose: "inbox" } },
        { allowedSystemKeys: ["name", "behavior", "specialPurpose"] },
      );
      const fb = await createItemWithClient(
        client,
        { databaseId: idFor("folders"), properties: { name: "B inbox", behavior: "folder", specialPurpose: "inbox" } },
        { allowedSystemKeys: ["name", "behavior", "specialPurpose"] },
      );
      return [a.id, b.id, fa.id, fb.id];
    });
    const storage: BlobStorageWriter = {
      async writeStream() {
        throw new Error("No attachments expected");
      },
      async delete() {
        throw new Error("No attachments expected");
      },
      readStream() {
        throw new Error("No attachments expected");
      },
    };
    const ingestCopy = (mailboxItemId: string, folderItemId: string, messageId: string, references: string[] = []) =>
      withTransaction(pool, (client) =>
        ingestEmailMessage(client, {
          emailsDatabaseId: emailsId,
          filesDatabaseId: idFor("files"),
          folderRelationPropertyId: propertyId("folder"),
          attachmentsRelationPropertyId: propertyId("attachments"),
          folderItemId,
          mailboxItemId,
          messageId,
          references,
          subject: "Test",
          envelope: { from: { address: "sender@example.com" }, to: [{ address: "recipient@example.com" }] },
          attachments: [],
          storage,
          storageKeyPrefix: "test",
        }),
      );
    await ingestCopy(mailboxA, folderA, "<newsletter@example.com>");
    await ingestCopy(mailboxB, folderB, "<ancestor@example.com>");
    const { rows: before } = await pool.query<{ message_id: string; thread_id: string }>(
      "SELECT message_id, thread_id FROM mail_message_meta WHERE message_id = ANY($1::text[])",
      [["<newsletter@example.com>", "<ancestor@example.com>"]],
    );
    const original = before.find((row) => row.message_id === "<newsletter@example.com>")?.thread_id;
    const other = before.find((row) => row.message_id === "<ancestor@example.com>")?.thread_id;
    expect(original).toBeDefined();
    expect(other).toBeDefined();
    expect(other).not.toBe(original);
    await ingestCopy(mailboxB, folderB, "<newsletter@example.com>", ["<ancestor@example.com>"]);
    const { rows: after } = await pool.query<{ thread_id: string }>(
      "SELECT thread_id FROM mail_message_meta WHERE message_id = ANY($1::text[])",
      [["<newsletter@example.com>", "<ancestor@example.com>"]],
    );
    expect(after).toHaveLength(3);
    expect(after.every((row) => row.thread_id === original)).toBe(true);
    expect((await pool.query("SELECT id FROM mail_threads WHERE id = $1", [other])).rowCount).toBe(0);

    await ingestCopy(mailboxA, folderA, "<independent@example.com>");
    await ingestCopy(mailboxB, folderB, "<independent@example.com>");
    const { rows: copies } = await pool.query<{ thread_id: string }>(
      "SELECT thread_id FROM mail_message_meta WHERE message_id = $1",
      ["<independent@example.com>"],
    );
    expect(copies).toHaveLength(2);
    expect(copies[0]?.thread_id).toBe(copies[1]?.thread_id);
    expect(copies[0]?.thread_id).not.toBe(original);
  });
});
