import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestTenant,
  ensureMailAccountSyncState,
  getTestPool,
  reconcileGmailAccount,
  resetDatabase,
  type GmailMailClient,
} from "@semprec/data/testSupport";
import {
  createChokePoint,
  createItemWithClient,
  createPersonEmailReindexAction,
  createUser,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  linkEmailEnvelopeToPeople,
  login,
  resolveMailModuleIds,
  seedSystem,
  withTransaction,
} from "@semprec/data";
import { createDispatcher } from "../app.js";

const password = "mail-http-password";
let admin: Pool;
let runtime: Pool;
let root: string;
let server: Server | undefined;
let baseUrl: string;
let tenantA: string;
let tenantB: string;
let authA: string;
let authB: string;

async function session(tenantId: string): Promise<string> {
  const email = `${randomUUID()}@example.com`;
  await createUser(admin, { tenantId, email, passwordHash: await hashPassword(password) });
  return `Bearer ${(await login(admin, { email, password, platform: "ios", ip: "127.0.0.1" })).token}`;
}

function get(auth: string, path: string) {
  return fetch(`${baseUrl}${path}`, { headers: { Authorization: auth } });
}

async function seedMail(tenantId: string) {
  return runInTenant(tenantId, () =>
    withTransaction(runtime, async (client) => {
      const ids = await resolveMailModuleIds(client);
      const cp = createChokePoint(runtime);
      const emailProperties = await cp.listProperties(ids.emailsDatabaseId);
      const folderProperties = await cp.listProperties(ids.foldersDatabaseId);
      const find = (properties: typeof emailProperties, key: string) => {
        const property = properties.find((entry) => entry.key === key);
        if (!property) throw new Error(`Missing ${key}`);
        return property.id;
      };
      const mailbox = await createItemWithClient(client, {
        databaseId: ids.mailboxesDatabaseId,
        properties: { name: "Mailbox", provider: "gmail" },
      });
      await ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "gmail_api" });
      const gmail: GmailMailClient = {
        getCurrentHistoryId: async () => "1",
        listHistorySince: async () => ({
          invalidated: false,
          newHistoryId: "2",
          changedMessageIds: [],
          removedMessageIds: [],
        }),
        listAllMessageIds: async () => ["message"],
        listLabels: async () => [{ id: "INBOX", name: "Inbox", type: "system" }],
        fetchMessage: async () => ({
          id: "message",
          threadId: "thread",
          labelIds: ["INBOX"],
          message: {
            messageId: `<${tenantId}@example.test>`,
            subject: "Distinct proposal",
            envelope: { from: { address: "sender@example.test" } },
            attachments: [],
          },
        }),
        modifyMessageLabels: async () => undefined,
      };
      await reconcileGmailAccount(client, gmail, {
        mailboxItemId: mailbox.id,
        emailsDatabaseId: ids.emailsDatabaseId,
        filesDatabaseId: ids.filesDatabaseId,
        foldersDatabaseId: ids.foldersDatabaseId,
        folderRelationPropertyId: find(emailProperties, "folder"),
        attachmentsRelationPropertyId: find(emailProperties, "attachments"),
        mailboxFolderRelationPropertyId: find(folderProperties, "mailbox"),
        storage: new LocalFsBlobStorageWriter(root),
        storageKeyPrefix: "mail-http",
      });
      const thread = await client.query<{ thread_id: string; item_id: string; thread_item_id: string }>(
        "SELECT m.thread_id, m.item_id, t.item_id AS thread_item_id FROM mail_message_meta m JOIN mail_threads t ON t.tenant_id = m.tenant_id AND t.id = m.thread_id WHERE m.mailbox_item_id = $1",
        [mailbox.id],
      );
      if (!thread.rows[0]?.thread_id) throw new Error("Missing mail thread");
      const folder = await client.query<{ id: string }>(
        "SELECT id FROM items WHERE database_id = $1 AND properties ->> 'specialPurpose' = 'inbox' AND deleted_at IS NULL",
        [ids.foldersDatabaseId],
      );
      if (!folder.rows[0]) throw new Error("Missing inbox folder");
      return {
        mailboxId: mailbox.id,
        folderId: folder.rows[0].id,
        threadId: thread.rows[0].thread_id,
        emailItemId: thread.rows[0].item_id,
        threadItemId: thread.rows[0].thread_item_id,
        emailsDatabaseId: ids.emailsDatabaseId,
      };
    }),
  );
}

describe("mail reads through the dispatcher", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("check mail HTTP role", () =>
      runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    root = await mkdtemp(join(tmpdir(), "semprec-mail-http-"));
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenantA = await createTestTenant(admin);
    tenantB = await createTestTenant(admin);
    for (const tenant of [tenantA, tenantB]) await runInTenant(tenant, () => seedSystem(runtime));
    authA = await session(tenantA);
    authB = await session(tenantB);
    const dispatch = await createDispatcher(runtime, {
      passwordResetMailer: { async sendPasswordResetEmail() {} },
      appBaseUrl: "https://app.example.test",
      setupToken: "mail-test-setup-token",
      moduleRegistry: await loadFullModuleRegistry(),
      blobStorage: new LocalFsBlobStorageWriter(root),
      maxFileSizeBytes: 2_000_000,
    });
    const currentServer = createServer(dispatch);
    server = currentServer;
    await new Promise<void>((resolve) => currentServer.listen(0, "127.0.0.1", resolve));
    const address = currentServer.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    const currentServer = server;
    server = undefined;
    if (currentServer)
      await new Promise<void>((resolve, reject) => currentServer.close((error) => (error ? reject(error) : resolve())));
  });
  afterAll(async () => {
    const failures: unknown[] = [];
    try {
      await runtime?.end();
    } catch (error) {
      failures.push(error);
    }
    try {
      await admin?.end();
    } catch (error) {
      failures.push(error);
    }
    try {
      if (root) await rm(root, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Fixture cleanup failed");
  });

  it("serves the caller's mailbox and matching inbox while concealing foreign mailboxes", async () => {
    const a = await seedMail(tenantA);
    const b = await seedMail(tenantB);
    const detail = await get(authB, `/api/mail/mailboxes/${b.mailboxId}`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ id: b.mailboxId, name: "Mailbox", syncMode: "gmail_api" });
    const foreign = await get(authB, `/api/mail/mailboxes/${a.mailboxId}`);
    const random = await get(authB, `/api/mail/mailboxes/${randomUUID()}`);
    expect(foreign.status).toBe(404);
    expect(random.status).toBe(404);
    expect(await foreign.text()).toBe(await random.text());
    const list = await get(authB, `/api/mail/threads?mailboxId=${b.mailboxId}&unread=true&q=proposal`);
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toBe("no-store");
    const body = await list.text();
    expect(body).toContain(b.threadId);
    expect(body).not.toContain(a.threadId);
    const contradictory = await get(authB, "/api/mail/threads?q=is%3Aunread%20is%3Aread");
    expect(contradictory.status).toBe(200);
    expect(await contradictory.json()).toEqual({ threads: [], nextCursor: null });
    const folderOwn = await get(authB, `/api/mail/threads?folderId=${b.folderId}`);
    expect(folderOwn.status).toBe(200);
    expect(await folderOwn.text()).toContain(b.threadId);
    const folderForeign = await get(authB, `/api/mail/threads?folderId=${a.folderId}`);
    const folderRandom = await get(authB, `/api/mail/threads?folderId=${randomUUID()}`);
    expect(folderForeign.status).toBe(404);
    expect(folderRandom.status).toBe(404);
    expect(await folderForeign.text()).toBe(await folderRandom.text());
    const filters = await runInTenant(tenantB, async () => {
      const cp = createChokePoint(runtime);
      const databases = await cp.listDatabases();
      const db = (key: string) => {
        const found = databases.find((entry) => entry.ownerModuleId === key);
        if (!found) throw new Error(`Missing ${key}`);
        return found.id;
      };
      const area = await cp.createItem({ databaseId: db("areas"), properties: { name: "Area" } });
      const project = await cp.createItem({ databaseId: db("projects"), properties: { name: "Project" } });
      const person = await cp.createItem({
        databaseId: db("people"),
        properties: { name: "Sender", emails: "sender@example.test" },
      });
      const projectProperty = (await cp.listProperties(db("threads"))).find((property) => property.key === "project");
      const areaProperty = (await cp.listProperties(db("projects"))).find((property) => property.key === "area");
      if (!projectProperty || !areaProperty) throw new Error("Missing project/area relation");
      await cp.createRelation({
        relationPropertyId: projectProperty.id,
        callerItemId: b.threadItemId,
        targetItemId: project.id,
      });
      await cp.createRelation({ relationPropertyId: areaProperty.id, callerItemId: project.id, targetItemId: area.id });
      await createPersonEmailReindexAction(runtime)(
        { peopleDatabaseId: db("people") },
        { heartbeatId: "fixture", projectItemId: "fixture", itemId: person.id },
      );
      await withTransaction(runtime, (client) =>
        linkEmailEnvelopeToPeople(client, {
          itemId: b.emailItemId,
          emailsDatabaseId: b.emailsDatabaseId,
          senderPeopleKey: "senderPeople",
          recipientsPeopleKey: "recipientsPeople",
          envelope: { from: { address: "sender@example.test" } },
        }),
      );
      return { projectId: project.id, areaId: area.id, personId: person.id };
    });
    const combined = await get(
      authB,
      `/api/mail/threads?mailboxId=${b.mailboxId}&q=proposal&projectId=${filters.projectId}&areaId=${filters.areaId}&personId=${filters.personId}`,
    );
    expect(combined.status).toBe(200);
    expect(await combined.text()).toContain(b.threadId);
    const noMatch = await get(authB, `/api/mail/threads?personId=${randomUUID()}`);
    expect(noMatch.status).toBe(200);
    const noMatchBody = await noMatch.text();
    expect(noMatchBody).toBe('{"threads":[],"nextCursor":null}');
    const foreignPerson = await runInTenant(tenantA, async () => {
      const cp = createChokePoint(runtime);
      const people = (await cp.listDatabases()).find((database) => database.ownerModuleId === "people");
      if (!people) throw new Error("Missing People database");
      return cp.createItem({ databaseId: people.id, properties: { name: "Foreign" } });
    });
    const foreignFilter = await get(authB, `/api/mail/threads?personId=${foreignPerson.id}`);
    expect(foreignFilter.status).toBe(200);
    expect(await foreignFilter.text()).toBe(noMatchBody);
    expect((await get(authA, "/api/mail/threads?box=bad")).status).toBe(400);
    expect((await get(authB, "/api/mail/threads?projectId=bad")).status).toBe(400);
    expect((await get(authB, "/api/mail/threads?q=before%3Anot-a-date")).status).toBe(400);
  });
});
