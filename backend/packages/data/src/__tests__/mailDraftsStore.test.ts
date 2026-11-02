import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../db/migrate.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  withTenantTransaction,
} from "../testSupport/tenantFixtures.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import { seedSystem } from "../seed/seedSystem.js";
import { FOLDERS_MODULE_ID } from "../seed/emailModuleKeys.js";
import { withTransaction } from "../db/pool.js";
import { createEmailDraft } from "../mail/draft.js";
import { writeMailboxAddresses } from "../mail/mailboxAddresses.js";
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
        properties: { name: "Test", provider: "generic" },
      });
      await writeMailboxAddresses(client, {
        mailboxesDatabaseId: mailboxesId,
        mailboxItemId: mailbox.id,
        address: "me@example.com",
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

  it("preserves a different unique violation and arbitrary thrown values without classifying them as thread conflicts", async () => {
    const input = draftInput({ createdBy: "user" });
    await insertMailDraft(pool, input);
    const duplicate = await insertMailDraft(pool, input).then(
      () => null,
      (error: unknown) => error,
    );
    expect(duplicate).not.toBeInstanceOf(MailDraftThreadConflictError);
    expect(duplicate).toBeInstanceOf(Error);
    if (typeof duplicate !== "object" || duplicate === null) throw new Error("Missing database failure");
    expect(Reflect.get(duplicate, "code")).toBe("23505");
    expect(Reflect.get(duplicate, "constraint")).toBe("mail_drafts_pkey");

    const original = new Proxy(
      {},
      {
        get() {
          throw new Error("classification trap");
        },
      },
    );
    for (const value of [original, undefined, "non-error", { code: "23505", constraint: "other_index" }]) {
      const query = vi.spyOn(pool, "query").mockRejectedValueOnce(value);
      try {
        const failure = await insertMailDraft(pool, draftInput()).then(
          () => null,
          (error: unknown) => ({ value: error }),
        );
        expect(failure).not.toBeNull();
        expect(failure?.value).toBe(value);
      } finally {
        query.mockRestore();
      }
    }
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

  it("isolates draft reads and writes through the runtime role while allowing the same thread in each tenant", async () => {
    const other = await createTestTenant(pool);
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    const threadId = randomUUID();
    const first = draftInput({ threadId });
    const second = draftInput({ threadId });
    const run = <T>(tenant: string, fn: Parameters<typeof withTransaction<T>>[1]) =>
      runInTenant(tenant, () => withTransaction(runtime, fn));
    try {
      await run(getTenantZeroId(), (client) => insertMailDraft(client, first));
      await run(other, (client) => insertMailDraft(client, second));
      const duplicate = draftInput({ threadId });
      await expect(run(getTenantZeroId(), (client) => insertMailDraft(client, duplicate))).rejects.toBeInstanceOf(
        MailDraftThreadConflictError,
      );
      expect(await run(getTenantZeroId(), (client) => getMailDraft(client, duplicate.emailItemId))).toBeNull();
      expect(await run(other, (client) => getMailDraft(client, first.emailItemId))).toBeNull();
      await expect(run(other, (client) => markMailDraftSent(client, first.emailItemId))).rejects.toMatchObject({
        name: "NotFoundError",
      });
      expect(await run(getTenantZeroId(), (client) => getMailDraft(client, first.emailItemId))).toMatchObject({
        emailItemId: first.emailItemId,
        sentAt: null,
      });
      expect(await run(other, (client) => getMailDraft(client, second.emailItemId))).toMatchObject({
        emailItemId: second.emailItemId,
        sentAt: null,
      });
    } finally {
      await runtime.end();
    }
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

it("upgrades populated legacy state before installing the draft table", async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("Missing test database URL");
  const name = `mail_upgrade_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url });
  const dir = await mkdtemp(path.join(tmpdir(), "semprec-mail-upgrade-"));
  const migrations = fileURLToPath(new URL("../db/migrations/", import.meta.url));
  const target = "0107_mail_drafts.sql";
  const existingId = randomUUID();
  let scratch: Pool | undefined;
  let created = false;
  const failures: unknown[] = [];
  try {
    // name is a fixed prefix followed only by hexadecimal UUID digits.
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const scratchUrl = new URL(url);
    scratchUrl.pathname = `/${name}`;
    scratch = new Pool({ connectionString: scratchUrl.toString() });
    const database = scratch;
    for (const file of (await readdir(migrations)).filter((entry) => entry.endsWith(".sql") && entry < target).sort()) {
      await copyFile(path.join(migrations, file), path.join(dir, file));
    }
    await runMigrations(database, dir);
    const tenant = await database.query<{ id: string }>("SELECT id FROM tenants ORDER BY id LIMIT 1");
    const tenantId = tenant.rows[0]?.id;
    if (!tenantId) throw new Error("Missing tenant");
    await runInTenant(tenantId, () =>
      withTransaction(database, (client) =>
        client.query(
          "INSERT INTO mail_account_sync_state (item_id, sync_mode, next_expected_activity_at) VALUES ($1, 'imap', '2099-01-01')",
          [existingId],
        ),
      ),
    );
    await copyFile(path.join(migrations, target), path.join(dir, target));
    await runMigrations(database, dir);
    const preserved = await runInTenant(tenantId, () =>
      withTransaction(database, (client) =>
        client.query("SELECT item_id FROM mail_account_sync_state WHERE item_id = $1", [existingId]),
      ),
    );
    expect(preserved.rowCount).toBe(1);
    const catalog = await database.query<{ relrowsecurity: boolean; comment: string | null }>(
      "SELECT c.relrowsecurity, obj_description(c.oid, 'pg_class') AS comment FROM pg_class c WHERE c.oid = 'mail_drafts'::regclass",
    );
    expect(catalog.rows[0]).toEqual({ relrowsecurity: true, comment: "semprec:tenancy=tenant" });
  } catch (error) {
    failures.push(error);
  }
  try {
    await scratch?.end();
  } catch (error) {
    failures.push(error);
  }
  try {
    // The same fixed-prefix, hexadecimal UUID identifier was created above.
    if (created) await admin.query(`DROP DATABASE "${name}"`);
  } catch (error) {
    failures.push(error);
  }
  try {
    await admin.end();
  } catch (error) {
    failures.push(error);
  }
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Upgrade test and cleanup failed");
});
