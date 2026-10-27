import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { CORE_TASK_NAMES, runOnce } from "@semprec/queue";
import { readJobPayloadsByIdentifier } from "@semprec/queue/testSupport";
import "../domainWriteHooks.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import { createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { FOLDERS_MODULE_ID } from "../seed/emailModuleKeys.js";
import { ingestEmailMessage } from "../mail/ingest.js";
import { getMailMessageMetaByItemId, upsertMailMessageMeta } from "../mail/mailMessageMetaStore.js";
import { htmlToPlainText, buildMailPreview } from "../mail/mailPlainText.js";
import {
  enqueueMailMessagePreviewBackfill,
  handleMailMessagePreviewBackfillTask,
} from "../mail/mailMessagePreviewBackfillJob.js";
import { createApiCoreTaskList } from "../worker.js";
import { createActionRegistry } from "../scheduler/actions.js";
import { storeCredential } from "../credentials/externalCredentialsStore.js";
import { sendDraftEmail } from "../mail/send.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";

let admin: Pool;
let pool: Pool;
let tenant: string;
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
async function db(key: string): Promise<string> {
  const value = await withTransaction(pool, (client) => getDatabaseByModuleId(client, key));
  if (!value) throw new Error(`Missing database ${key}`);
  return value.id;
}
async function property(databaseId: string, key: string): Promise<string> {
  const value = await withTransaction(pool, (client) => getPropertyByKey(client, databaseId, key));
  if (!value) throw new Error(`Missing property ${key}`);
  return value.id;
}
async function setupMail() {
  const emailsDatabaseId = await db("emails");
  const foldersDatabaseId = await db("folders");
  const mailboxesDatabaseId = await db("mailboxes");
  const mailbox = await createChokePoint(pool).createItem({
    databaseId: mailboxesDatabaseId,
    properties: { name: "Mailbox", provider: "generic", addresses: "me@example.com" },
  });
  const folderRelationPropertyId = await property(emailsDatabaseId, "folder");
  const mailboxFolderRelationPropertyId = await property(foldersDatabaseId, "mailbox");
  const folder = await withTransaction(pool, async (client) => {
    const item = await createItemWithClient(
      client,
      { databaseId: foldersDatabaseId, properties: { name: "Sent", behavior: "folder", specialPurpose: "sent" } },
      { allowedSystemKeys: ["name", "behavior", "specialPurpose"] },
    );
    await createRelationWithClient(
      client,
      { relationPropertyId: mailboxFolderRelationPropertyId, callerItemId: item.id, targetItemId: mailbox.id },
      { ownerProcess: FOLDERS_MODULE_ID },
    );
    return item;
  });
  return {
    emailsDatabaseId,
    foldersDatabaseId,
    mailboxesDatabaseId,
    filesDatabaseId: await db("files"),
    folderRelationPropertyId,
    attachmentsRelationPropertyId: await property(emailsDatabaseId, "attachments"),
    mailboxFolderRelationPropertyId,
    mailboxItemId: mailbox.id,
    folderItemId: folder.id,
    storage,
    storageKeyPrefix: "preview-test",
    attachments: [],
    envelope: {},
  };
}
async function snapshot() {
  return (
    await pool.query<{ item_id: string; preview_text: string | null; ingested_at: Date | null }>(
      "SELECT item_id, preview_text, ingested_at FROM mail_message_meta ORDER BY item_id",
    )
  ).rows;
}
beforeAll(async () => {
  admin = getTestPool();
  pool = await createRuntimeRolePool(admin, "semprec_data");
});
beforeEach(async () => {
  await resetDatabase(admin);
  tenant = await createTestTenant(admin);
  await runInTenant(tenant, () => seedSystem(pool));
});
afterEach(async () => {
  await admin.query(
    "DROP TRIGGER IF EXISTS reject_preview_test ON mail_message_meta; DROP FUNCTION IF EXISTS reject_preview_test()",
  );
});
afterAll(async () => {
  await pool?.end();
  await admin?.end();
});

describe("mail preview text", () => {
  it.each([
    [" \n hello\t world  ", "hello world"],
    ["a".repeat(201), "a".repeat(200)],
    ["a".repeat(199) + "😀z", "a".repeat(199)],
    ["a".repeat(198) + "😀z", "a".repeat(198) + "😀"],
    ["", ""],
  ])("collapses and truncates UTF-16 safely: %s", (input, expected) => {
    expect(buildMailPreview(input)).toBe(expected);
  });
  it("shares the existing tag and script stripping conversion", () => {
    expect(htmlToPlainText("<p>Hello</p><script>bad()</script>")).toBe("Hello");
  });
});

it.each([
  { bodyText: " hello\n world ", bodyHtml: "<b>ignored</b>", expected: "hello world" },
  { bodyHtml: "<p>HTML only</p><script>bad()</script>", expected: "HTML only" },
  { bodyText: "a".repeat(199) + "😀z", expected: "a".repeat(199) },
  { expected: "" },
  { bodyText: "", bodyHtml: "<b>ignored</b>", expected: "" },
])("ingests preview and arrival time using the production writer: $expected", async ({ expected, ...body }) => {
  await runInTenant(tenant, async () => {
    const input = { ...(await setupMail()), ...body, messageId: randomUUID() };
    const before = Date.now();
    const item = await withTransaction(pool, (client) => ingestEmailMessage(client, input));
    const meta = await getMailMessageMetaByItemId(pool, item.itemId);
    expect(meta?.previewText).toBe(expected);
    expect(meta?.ingestedAt?.getTime()).toBeGreaterThanOrEqual(before);
    expect(meta?.ingestedAt?.getTime()).toBeLessThanOrEqual(Date.now());
    await withTransaction(pool, (client) => ingestEmailMessage(client, { ...input, bodyText: "changed" }));
    expect(await getMailMessageMetaByItemId(pool, item.itemId)).toEqual(meta);
  });
});

it.each([
  { bodyText: " sent\n text ", bodyHtml: "<p>ignored</p>", expected: "sent text" },
  { bodyHtml: "<b>HTML sent</b>", expected: "HTML sent" },
  { bodyText: "", bodyHtml: "<b>ignored</b>", expected: "" },
  { expected: "" },
])("stores the claim before SMTP and preserves it on Sent sync: $expected", async ({ expected, ...body }) => {
  await runInTenant(tenant, async () => {
    const input = await setupMail();
    const draft = await withTransaction(pool, (client) =>
      createItemWithClient(
        client,
        { databaseId: input.emailsDatabaseId, properties: { name: "Draft", body: "draft" } },
        { allowedSystemKeys: ["name", "body"] },
      ),
    );
    expect(await getMailMessageMetaByItemId(pool, draft.id)).toBeNull();
    await storeCredential(pool, { itemId: input.mailboxItemId, credentialType: "app_password", plaintext: "fixture" });
    const before = Date.now();
    let claimedAt: Date | null | undefined;
    const result = await sendDraftEmail(
      pool,
      {
        mailboxItemId: input.mailboxItemId,
        draftItemId: draft.id,
        actor: { type: "user" },
        from: { address: "me@example.com" },
        to: [],
        subject: "Sent preview",
        ...body,
      },
      input,
      {
        createSmtpClient: async () => ({
          sendMail: async () => {
            const claim = await getMailMessageMetaByItemId(pool, draft.id);
            expect(claim?.previewText).toBe(expected);
            claimedAt = claim?.ingestedAt;
            expect(claimedAt?.getTime()).toBeGreaterThanOrEqual(before);
          },
        }),
      },
    );
    const synced = await withTransaction(pool, (client) =>
      ingestEmailMessage(client, { ...input, messageId: result.messageId, bodyText: "different Sent representation" }),
    );
    expect(synced).toEqual({ itemId: draft.id, created: false });
    const meta = await getMailMessageMetaByItemId(pool, draft.id);
    expect(meta?.previewText).toBe(expected);
    expect(meta?.ingestedAt).toEqual(claimedAt);
    // Also exercises the actual ON CONFLICT branch, rather than only ingest's dedup shortcut.
    await upsertMailMessageMeta(pool, {
      itemId: draft.id,
      mailboxItemId: input.mailboxItemId,
      messageId: result.messageId,
      envelope: {},
      previewText: "replacement",
      ingestedAt: new Date(0),
    });
    expect((await getMailMessageMetaByItemId(pool, draft.id))?.previewText).toBe(expected);
    expect((await getMailMessageMetaByItemId(pool, draft.id))?.ingestedAt).toEqual(claimedAt);
  });
});

it("deploy enqueues one fixed-key system task; production worker backfills multiple pages in two tenants idempotently", async () => {
  const other = await createTestTenant(admin);
  const suspended = await createTestTenant(admin, { status: "suspended" });
  const ids = new Map<string, string[]>();
  for (const t of [tenant, other, suspended]) {
    await runInTenant(t, async () => {
      if (t !== tenant) await seedSystem(pool);
      const emailId = await db("emails");
      const itemIds: string[] = [];
      for (let n = 0; n < (t === tenant ? 101 : 1); n++) {
        await withTransaction(pool, async (client) => {
          const item = await createItemWithClient(
            client,
            {
              databaseId: emailId,
              properties: { name: "Old mail", body: n === 0 ? "<b>old</b>\n body" : "x".repeat(205) },
            },
            { allowedSystemKeys: ["name", "body"] },
          );
          await upsertMailMessageMeta(client, {
            itemId: item.id,
            mailboxItemId: null,
            messageId: randomUUID(),
            envelope: {},
            ...(n === 1 ? { previewText: "keep" } : {}),
            ...(n === 2 ? { ingestedAt: new Date(0) } : {}),
          });
          itemIds.push(item.id);
        });
      }
      ids.set(t, itemIds);
    });
  }
  await runInTenant(tenant, async () => {
    expect(await getMailMessageMetaByItemId(pool, ids.get(other)![0]!)).toBeNull();
    expect(await getMailMessageMetaByItemId(pool, randomUUID())).toBeNull();
  });
  await runAsSystem("preview deploy test", async () => {
    await enqueueMailMessagePreviewBackfill(admin);
    await enqueueMailMessagePreviewBackfill(admin);
    expect(await readJobPayloadsByIdentifier(admin, CORE_TASK_NAMES.MAIL_MESSAGE_PREVIEW_BACKFILL)).toHaveLength(1);
    const handler = createApiCoreTaskList(pool, createActionRegistry())[CORE_TASK_NAMES.MAIL_MESSAGE_PREVIEW_BACKFILL];
    if (!handler) throw new Error("Production handler missing");
    await runOnce({ pgPool: admin }, { [CORE_TASK_NAMES.MAIL_MESSAGE_PREVIEW_BACKFILL]: handler });
  });
  const snapshots = new Map<string, Awaited<ReturnType<typeof snapshot>>>();
  for (const t of [tenant, other])
    await runInTenant(t, async () => {
      const rows = await snapshot();
      expect(rows).toHaveLength(t === tenant ? 101 : 1);
      for (const row of rows) {
        const n = ids.get(t)!.indexOf(row.item_id);
        expect(row.preview_text).toBe(n === 0 ? "old body" : n === 1 ? "keep" : "x".repeat(200));
        const source = await pool.query<{ updated_at: Date }>("SELECT updated_at FROM items WHERE id = $1", [
          row.item_id,
        ]);
        expect(row.ingested_at).toEqual(n === 2 ? new Date(0) : source.rows[0]?.updated_at);
      }
      snapshots.set(t, rows);
    });
  await handleMailMessagePreviewBackfillTask(pool);
  for (const t of [tenant, other])
    await runInTenant(t, async () => {
      expect(await snapshot()).toEqual(snapshots.get(t));
    });
  await runInTenant(suspended, async () => {
    expect((await snapshot())[0]).toMatchObject({ preview_text: null, ingested_at: null });
  });
});

it("fills null upsert fields while preserving an existing empty preview", async () => {
  await runInTenant(tenant, async () => {
    const input = await setupMail();
    const item = await withTransaction(pool, (client) =>
      createItemWithClient(
        client,
        { databaseId: input.emailsDatabaseId, properties: { name: "Old" } },
        { allowedSystemKeys: ["name"] },
      ),
    );
    const key = { itemId: item.id, mailboxItemId: input.mailboxItemId, messageId: randomUUID(), envelope: {} };
    await upsertMailMessageMeta(pool, key);
    expect(await getMailMessageMetaByItemId(pool, item.id)).toMatchObject({ previewText: null, ingestedAt: null });
    await upsertMailMessageMeta(pool, { ...key, previewText: "", ingestedAt: new Date(0) });
    await upsertMailMessageMeta(pool, { ...key, previewText: "later", ingestedAt: new Date(1000) });
    expect(await getMailMessageMetaByItemId(pool, item.id)).toMatchObject({ previewText: "", ingestedAt: new Date(0) });
    // A pre-upgrade row can have no body property; the backfill still supplies a usable empty preview.
    await withTransaction(pool, (client) =>
      client.query("UPDATE mail_message_meta SET preview_text = NULL, ingested_at = NULL WHERE item_id = $1", [
        item.id,
      ]),
    );
  });
  await handleMailMessagePreviewBackfillTask(pool);
  await runInTenant(tenant, async () => {
    expect((await snapshot())[0]?.preview_text).toBe("");
  });
});

it("commits earlier pages, rolls back a failing page, visits other tenants and recovers on retry", async () => {
  const other = await createTestTenant(admin);
  let lastId = "";
  for (const t of [tenant, other])
    await runInTenant(t, async () => {
      if (t === other) await seedSystem(pool);
      const databaseId = await db("emails");
      for (let n = 0; n < (t === tenant ? 102 : 1); n++)
        await withTransaction(pool, async (client) => {
          const item = await createItemWithClient(
            client,
            { databaseId, properties: { name: "Legacy", body: "old" } },
            { allowedSystemKeys: ["name", "body"] },
          );
          await upsertMailMessageMeta(client, {
            itemId: item.id,
            mailboxItemId: null,
            messageId: randomUUID(),
            envelope: {},
          });
        });
      if (t === tenant) {
        const rows = await snapshot();
        lastId = rows.at(-1)!.item_id;
        await withTransaction(pool, (client) =>
          updateItemWithClient(
            client,
            { databaseId, itemId: lastId, propertiesPatch: { body: "failBackfill" } },
            { allowedSystemKeys: ["body"] },
          ),
        );
      }
    });
  // Database-only fault injection: the public API cannot reject a metadata update on demand.
  await admin.query(`CREATE FUNCTION reject_preview_test() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'preview backfill test failure'; END $$;
    CREATE TRIGGER reject_preview_test BEFORE UPDATE ON mail_message_meta
    FOR EACH ROW WHEN (NEW.preview_text = 'failBackfill') EXECUTE FUNCTION reject_preview_test()`);
  await expect(handleMailMessagePreviewBackfillTask(pool)).rejects.toBeInstanceOf(AggregateError);
  await runInTenant(tenant, async () => {
    const rows = await snapshot();
    expect(rows.filter((row) => row.preview_text === "old")).toHaveLength(100);
    expect(rows.filter((row) => row.preview_text === null && row.ingested_at === null)).toHaveLength(2);
  });
  await runInTenant(other, async () => {
    expect((await snapshot())[0]?.preview_text).toBe("old");
  });
  await admin.query("DROP TRIGGER reject_preview_test ON mail_message_meta; DROP FUNCTION reject_preview_test()");
  await handleMailMessagePreviewBackfillTask(pool);
  await runInTenant(tenant, async () => {
    expect((await snapshot()).filter((row) => row.preview_text === null || row.ingested_at === null)).toHaveLength(0);
    expect((await getMailMessageMetaByItemId(pool, lastId))?.previewText).toBe("failBackfill");
  });
});
