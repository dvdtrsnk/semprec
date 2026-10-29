import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createTestTenant, withTenantTransaction } from "../testSupport/tenantFixtures.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import { seedSystem } from "../seed/seedSystem.js";
import { FOLDERS_MODULE_ID } from "../seed/emailModuleKeys.js";
import { withTransaction } from "../db/pool.js";
import { createEmailDraft } from "../mail/draft.js";
import {
  getMailDraft,
  insertMailDraft,
  markMailDraftSent,
  MailDraftThreadConflictError,
  updateMailDraft,
  type InsertMailDraftInput,
} from "../mail/mailDraftsStore.js";

let pool: Pool;
let chokePoint: ChokePoint;

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

function draftInput(overrides: Partial<InsertMailDraftInput> = {}): InsertMailDraftInput {
  return {
    emailItemId: randomUUID(),
    mailboxItemId: randomUUID(),
    threadId: randomUUID(),
    mode: "reply",
    fromAddress: "me@example.com",
    createdBy: "agent",
    ...overrides,
  };
}

describe("mail drafts store (issue #1504)", () => {
  let emailsId: string;
  let folderRelationPropertyId: string;
  let draftsFolderId: string;
  let mailboxId: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);

    emailsId = await databaseIdFor("emails");
    const foldersId = await databaseIdFor("folders");
    const mailboxesId = await databaseIdFor("mailboxes");
    const emailProps = await chokePoint.listProperties(emailsId);
    const folderProps = await chokePoint.listProperties(foldersId);
    folderRelationPropertyId = emailProps.find((p) => p.key === "folder")!.id;
    const mailboxFolderRelationPropertyId = folderProps.find((p) => p.key === "mailbox")!.id;

    await withTransaction(pool, async (client) => {
      const mailbox = await createItemWithClient(client, {
        databaseId: mailboxesId,
        properties: { name: "Test", provider: "generic", addresses: "me@example.com" },
      });
      mailboxId = mailbox.id;
      const drafts = await createItemWithClient(
        client,
        { databaseId: foldersId, properties: { name: "Drafts", behavior: "folder", specialPurpose: "drafts" } },
        { allowedSystemKeys: ["name", "behavior", "specialPurpose"] },
      );
      draftsFolderId = drafts.id;
      await createRelationWithClient(
        client,
        { relationPropertyId: mailboxFolderRelationPropertyId, callerItemId: drafts.id, targetItemId: mailbox.id },
        { ownerProcess: FOLDERS_MODULE_ID },
      );
    });
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function createDraft(
    threadId: string | null,
    createdBy: "user" | "agent",
    to = [{ name: "Bob", address: "bob@example.com" }],
  ) {
    return withTransaction(pool, (client) =>
      createEmailDraft(client, {
        emailsDatabaseId: emailsId,
        folderRelationPropertyId,
        draftsFolderItemId: draftsFolderId,
        subject: "Hello",
        from: { address: "me@example.com" },
        bodyText: "hi",
        metadata: { mailboxItemId: mailboxId, threadId, mode: "new", fromAddress: "me@example.com", createdBy, to },
      }),
    );
  }

  it("creates the Email item, the Drafts folder edge and the metadata row together, with a date", async () => {
    const item = await createDraft(randomUUID(), "agent");
    const { rows: edges } = await pool.query(
      "SELECT 1 FROM item_relations WHERE (item_a = $1 AND item_b = $2) OR (item_a = $2 AND item_b = $1)",
      [item.id, draftsFolderId],
    );
    expect(edges).toHaveLength(1);
    expect(typeof item.properties.date).toBe("string");
    expect(item.properties.recipients).toContain("bob@example.com");
    const draft = await getMailDraft(pool, item.id);
    expect(draft).toMatchObject({ emailItemId: item.id, mailboxItemId: mailboxId, createdBy: "agent", sentAt: null });
  });

  it("creates none of the three when the metadata row is rejected", async () => {
    const threadId = randomUUID();
    await createDraft(threadId, "agent");
    const before = await pool.query("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [emailsId]);
    await expect(createDraft(threadId, "agent")).rejects.toBeInstanceOf(MailDraftThreadConflictError);
    const after = await pool.query("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [emailsId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    // The Drafts folder's edges: one to its mailbox and one to the first draft only.
    const edges = await pool.query("SELECT count(*)::int AS n FROM item_relations WHERE item_a = $1 OR item_b = $1", [
      draftsFolderId,
    ]);
    expect(edges.rows[0].n).toBe(2);
  });

  it("without metadata creates a plain Email and no mail_drafts row", async () => {
    const item = await withTransaction(pool, (client) =>
      createEmailDraft(client, {
        emailsDatabaseId: emailsId,
        folderRelationPropertyId,
        draftsFolderItemId: draftsFolderId,
        subject: "Plain",
      }),
    );
    expect(await getMailDraft(pool, item.id)).toBeNull();
  });

  it("rejects a second unsent agent draft for the same thread with a distinct error", async () => {
    const threadId = randomUUID();
    await insertMailDraft(pool, draftInput({ threadId }));
    const error = await insertMailDraft(pool, draftInput({ threadId })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MailDraftThreadConflictError);
    expect((error as MailDraftThreadConflictError).status).toBe(409);
  });

  it("does not limit user drafts or agent drafts without a thread", async () => {
    const threadId = randomUUID();
    await insertMailDraft(pool, draftInput({ threadId, createdBy: "user" }));
    await insertMailDraft(pool, draftInput({ threadId, createdBy: "user" }));
    await insertMailDraft(pool, draftInput({ threadId, createdBy: "agent" }));
    await insertMailDraft(pool, draftInput({ threadId: null }));
    await insertMailDraft(pool, draftInput({ threadId: null }));
  });

  it("allows the same thread id in another tenant", async () => {
    const threadId = randomUUID();
    await insertMailDraft(pool, draftInput({ threadId }));
    const other = await createTestTenant(pool);
    await withTenantTransaction(pool, other, (client) => insertMailDraft(client, draftInput({ threadId })));
  });

  it("allows a new agent draft once the previous one is marked sent", async () => {
    const threadId = randomUUID();
    const first = draftInput({ threadId });
    await insertMailDraft(pool, first);
    const sent = await markMailDraftSent(pool, first.emailItemId);
    expect(sent.sentAt).toBeInstanceOf(Date);
    await insertMailDraft(pool, draftInput({ threadId }));
  });

  it("stores and reads recipients as name and address lists in the original order", async () => {
    const to = [
      { name: "Zed", address: "z@example.com" },
      { name: "", address: "a@example.com" },
      { name: "Mid", address: "m@example.com" },
    ];
    const cc = [
      { name: "C2", address: "c2@example.com" },
      { name: "C1", address: "c1@example.com" },
    ];
    const bcc = [{ name: "B", address: "b@example.com" }];
    const input = draftInput({ to, cc, bcc, references: ["<b@x>", "<a@x>"], inReplyTo: "<a@x>" });
    await insertMailDraft(pool, input);
    expect(await getMailDraft(pool, input.emailItemId)).toMatchObject({
      to,
      cc,
      bcc,
      references: ["<b@x>", "<a@x>"],
      inReplyTo: "<a@x>",
    });
  });

  it("updates only the given fields, records the editor, and refuses a missing or sent draft", async () => {
    const input = draftInput({ to: [{ name: "Bob", address: "bob@example.com" }] });
    await insertMailDraft(pool, input);
    const updated = await updateMailDraft(pool, input.emailItemId, {
      lastEditedBy: "user",
      cc: [{ name: "", address: "c@example.com" }],
    });
    expect(updated).toMatchObject({
      createdBy: "agent",
      lastEditedBy: "user",
      to: [{ name: "Bob", address: "bob@example.com" }],
      cc: [{ name: "", address: "c@example.com" }],
    });
    await expect(updateMailDraft(pool, randomUUID(), { lastEditedBy: "user" })).rejects.toMatchObject({
      name: "NotFoundError",
    });
    await markMailDraftSent(pool, input.emailItemId);
    await expect(updateMailDraft(pool, input.emailItemId, { lastEditedBy: "user" })).rejects.toMatchObject({
      name: "NotFoundError",
    });
    await expect(markMailDraftSent(pool, input.emailItemId)).rejects.toMatchObject({ name: "NotFoundError" });
  });
});
