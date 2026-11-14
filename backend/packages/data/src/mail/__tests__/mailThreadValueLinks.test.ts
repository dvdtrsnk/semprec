import "../../domainWriteHooks.js";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { insertValueLink, type ValueLinkSourceInput } from "../../chokePoint/valueLinksStore.js";
import { withTransaction } from "../../db/pool.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import type { BlobStorageWriter } from "../blobStorage.js";
import { ingestEmailMessage } from "../ingest.js";
import { getMailThreadDetail } from "../mailThreadDetail.js";
import { listMailThreads } from "../mailThreadListQuery.js";
import { createMailThreadDetailRouteHandler, createMailThreadListRouteHandler } from "../mailThreadRoutes.js";

/** The writer of a person's own request: a relation write as this writer ends a value link, a system write does not. */
const USER = { writerKind: "user" } as const;

/** A mail thread as the route names it, and the Threads item its relations hang on. */
interface TestThread {
  threadId: string;
  itemId: string;
}

let admin: Pool;
let runtime: Pool;
let tenant: string;
let cp: ChokePoint;
let databases: Record<string, string>;
let properties: { threadProject: string; threadCompany: string; emailFolder: string; emailFiles: string };
let inbox: { mailboxId: string; folderId: string };

/** No message of this file has an attachment, so nothing is ever written. */
const storage: BlobStorageWriter = {
  writeStream() {
    throw new Error("writeStream is not used by this test");
  },
  async delete() {},
  readStream() {
    throw new Error("readStream is not used by this test");
  },
};

function inTenant<T>(fn: () => Promise<T>, tenantId = tenant): Promise<T> {
  return runInTenant(tenantId, fn);
}

function databaseId(key: string): string {
  const id = databases[key];
  if (!id) throw new Error(`the ${key} database is not seeded`);
  return id;
}

async function propertyId(databaseKey: string, key: string): Promise<string> {
  const property = (await cp.listProperties(databaseId(databaseKey))).find((entry) => entry.key === key);
  if (!property) throw new Error(`the ${databaseKey}.${key} property is not seeded`);
  return property.id;
}

/** The thread of one live message in the inbox, through the sync writer. */
async function newThread(messageId: string): Promise<TestThread> {
  return inTenant(() =>
    withTransaction(runtime, async (client) => {
      const ingested = await ingestEmailMessage(client, {
        emailsDatabaseId: databaseId("emails"),
        filesDatabaseId: databaseId("files"),
        folderRelationPropertyId: properties.emailFolder,
        attachmentsRelationPropertyId: properties.emailFiles,
        mailboxItemId: inbox.mailboxId,
        folderItemId: inbox.folderId,
        messageId,
        inReplyTo: null,
        references: [],
        subject: messageId,
        envelope: { from: { address: "klient@example.test" }, to: [{ address: "me@example.test" }] },
        attachments: [],
        storage,
        storageKeyPrefix: "thread-value-links",
      });
      const { rows } = await client.query<{ id: string; item_id: string | null }>(
        `SELECT t.id, t.item_id FROM mail_message_meta m JOIN mail_threads t ON t.id = m.thread_id
          WHERE m.item_id = $1`,
        [ingested.itemId],
      );
      const row = rows[0];
      if (!row?.item_id) throw new Error("the ingested message has no thread item");
      return { threadId: row.id, itemId: row.item_id };
    }),
  );
}

async function newItem(databaseKey: string, itemProperties: Record<string, unknown>): Promise<string> {
  return (await inTenant(() => cp.createItem({ databaseId: databaseId(databaseKey), properties: itemProperties }))).id;
}

/** Links through the choke point as a user, as a person's own request does. */
async function link(relationPropertyId: string, callerItemId: string, targetItemId: string): Promise<void> {
  await inTenant(() => cp.createRelation({ relationPropertyId, callerItemId, targetItemId }, USER));
}

/**
 * An `on` value link of one Threads property. The rule that writes such links for a thread (issue gh-1869) is not
 * part of this tree, so the row is written with the store function the link rules write theirs with.
 */
async function inherit(thread: TestThread, propertyKey: string, source: ValueLinkSourceInput): Promise<void> {
  await inTenant(() =>
    withTransaction(runtime, (client) =>
      insertValueLink(client, {
        itemId: thread.itemId,
        propertyKey,
        ruleKey: "test.threadValue",
        sources: [source],
      }),
    ),
  );
}

async function detailOf(thread: TestThread, tenantId = tenant) {
  return inTenant(
    () => withTransaction(runtime, (client) => getMailThreadDetail(client, thread.threadId, false)),
    tenantId,
  );
}

async function listOf(tenantId = tenant) {
  return inTenant(
    () =>
      withTransaction(runtime, (client) =>
        listMailThreads(client, 200, null, { box: "inbox", folderId: null, unread: false, mailboxId: null }),
      ),
    tenantId,
  );
}

/** The thread's list row, which must be there. */
async function rowOf(thread: TestThread, tenantId = tenant) {
  const row = (await listOf(tenantId)).find((entry) => entry.threadId === thread.threadId);
  if (!row) throw new Error("the thread is not in the list");
  return row;
}

describe("company, project and links of the mail thread list and detail (issue gh-1897)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    cp = createChokePoint(runtime);
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await inTenant(() => seedSystem(runtime));
    databases = Object.fromEntries(
      (await inTenant(() => cp.listDatabases())).flatMap((database) =>
        database.ownerModuleId ? [[database.ownerModuleId, database.id]] : [],
      ),
    );
    properties = await inTenant(async () => ({
      threadProject: await propertyId("threads", "project"),
      threadCompany: await propertyId("threads", "company"),
      emailFolder: await propertyId("emails", "folder"),
      emailFiles: await propertyId("emails", "attachments"),
    }));
    inbox = await inTenant(() =>
      withTransaction(runtime, async (client) => {
        const mailbox = await createItemWithClient(client, {
          databaseId: databaseId("mailboxes"),
          properties: { name: "Personal", provider: "generic" },
        });
        const folder = await createItemWithClient(
          client,
          {
            databaseId: databaseId("folders"),
            properties: { name: "Inbox", behavior: "folder", specialPurpose: "inbox" },
          },
          { allowedSystemKeys: ["name", "behavior", "specialPurpose"] },
        );
        return { mailboxId: mailbox.id, folderId: folder.id };
      }),
    );
  });

  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  it("returns both names and an inherited link state with its sources for a thread that inherited its company and project", async () => {
    const thread = await newThread("<inherited@example.test>");
    const sender = await newItem("people", { name: "Klient" });
    const project = await newItem("projects", { name: "Web" });
    const company = await newItem("companies", { name: "Acme" });
    await link(properties.threadProject, thread.itemId, project);
    await link(properties.threadCompany, thread.itemId, company);
    // The links are written after the edges above, which as a user's writes would otherwise end them.
    await inherit(thread, "project", { kind: "item", sourceItemId: sender, sourcePropertyKey: "project" });
    await inherit(thread, "company", { kind: "senderDomain", domain: "acme.example", sourcePropertyKey: "company" });

    const expectedLinks = {
      project: {
        valueKind: "inherited",
        sources: [{ kind: "item", itemId: sender, databaseKey: "people", title: "Klient", propertyKey: "project" }],
        brokenBy: null,
        brokenAt: null,
      },
      company: {
        valueKind: "inherited",
        sources: [{ kind: "senderDomain", domain: "acme.example", propertyKey: "company" }],
        brokenBy: null,
        brokenAt: null,
      },
    };
    const expected = {
      project: { id: project, name: "Web" },
      company: { id: company, name: "Acme" },
      links: expectedLinks,
    };
    expect(await rowOf(thread)).toMatchObject(expected);
    expect(await detailOf(thread)).toMatchObject(expected);
  });

  it("shows the project as inheritedBroken with who broke it once a person set it by hand", async () => {
    const thread = await newThread("<broken@example.test>");
    const sender = await newItem("people", { name: "Klient" });
    const project = await newItem("projects", { name: "Web" });
    await inherit(thread, "project", { kind: "item", sourceItemId: sender, sourcePropertyKey: "project" });
    expect((await rowOf(thread)).links.project).toMatchObject({ valueKind: "inherited", brokenBy: null });

    await link(properties.threadProject, thread.itemId, project);

    for (const answer of [await rowOf(thread), await detailOf(thread)]) {
      expect(answer.project).toEqual({ id: project, name: "Web" });
      expect(answer.links.project).toMatchObject({ valueKind: "inheritedBroken", brokenBy: "user" });
      expect(answer.links.project?.brokenAt).toEqual(expect.any(String));
      expect(answer.links.project?.sources).toHaveLength(1);
    }
  });

  it("has no links entry for a value the user set that never had a link, and one for the other property that has", async () => {
    const thread = await newThread("<own@example.test>");
    const project = await newItem("projects", { name: "Web" });
    const company = await newItem("companies", { name: "Acme" });
    await link(properties.threadProject, thread.itemId, project);
    await link(properties.threadCompany, thread.itemId, company);
    await inherit(thread, "company", { kind: "senderDomain", domain: "acme.example", sourcePropertyKey: "company" });

    for (const answer of [await rowOf(thread), await detailOf(thread)]) {
      expect(answer.project).toEqual({ id: project, name: "Web" });
      expect(Object.keys(answer.links)).toEqual(["company"]);
      expect(answer.links.project).toBeUndefined();
    }
  });

  it("returns null for both and an empty links object for a thread without company or project", async () => {
    const thread = await newThread("<bare@example.test>");
    // A link of a property that is neither company nor project is not reported.
    await inherit(thread, "name", { kind: "senderDomain", domain: "acme.example", sourcePropertyKey: "name" });

    for (const answer of [await rowOf(thread), await detailOf(thread)]) {
      expect(answer.project).toBeNull();
      expect(answer.company).toBeNull();
      expect(answer.links).toEqual({});
    }
  });

  it("reads a company and a project in the Trash as null and keeps the live one", async () => {
    const thread = await newThread("<trash@example.test>");
    const project = await newItem("projects", { name: "Web" });
    const company = await newItem("companies", { name: "Acme" });
    await link(properties.threadProject, thread.itemId, project);
    await link(properties.threadCompany, thread.itemId, company);
    expect(await inTenant(() => cp.softDeleteItem(databaseId("projects"), project))).not.toBeNull();

    for (const answer of [await rowOf(thread), await detailOf(thread)]) {
      expect(answer.project).toBeNull();
      expect(answer.company).toEqual({ id: company, name: "Acme" });
    }

    expect(await inTenant(() => cp.softDeleteItem(databaseId("companies"), company))).not.toBeNull();
    for (const answer of [await rowOf(thread), await detailOf(thread)]) expect(answer.company).toBeNull();
  });

  it("answers an empty name for a project and a company that have none", async () => {
    const thread = await newThread("<nameless@example.test>");
    const project = await newItem("projects", {});
    const company = await newItem("companies", {});
    await link(properties.threadProject, thread.itemId, project);
    await link(properties.threadCompany, thread.itemId, company);

    const row = await rowOf(thread);
    expect(row.project).toEqual({ id: project, name: "" });
    expect(row.company).toEqual({ id: company, name: "" });
  });

  it("answers null and no links for a thread that has no Threads item yet", async () => {
    const thread = await newThread("<unbacked@example.test>");
    const project = await newItem("projects", { name: "Web" });
    await link(properties.threadProject, thread.itemId, project);
    // A thread row written before its Threads item exists (the backfill of issue gh-1573 fills it in) has no item id;
    // the API cannot produce that state, so the column is cleared directly.
    await admin.query("UPDATE mail_threads SET item_id = NULL WHERE id = $1", [thread.threadId]);

    const row = await rowOf(thread);
    expect(row.project).toBeNull();
    expect(row.company).toBeNull();
    expect(row.links).toEqual({});
  });

  it("answers the same fields through the list and the detail routes", async () => {
    const thread = await newThread("<routes@example.test>");
    const project = await newItem("projects", { name: "Web" });
    await link(properties.threadProject, thread.itemId, project);
    await inherit(thread, "project", { kind: "senderDomain", domain: "acme.example", sourcePropertyKey: "project" });

    const list = await inTenant(() => createMailThreadListRouteHandler(runtime)({ req: { url: "/api/mail/threads" } }));
    const detail = await inTenant(() =>
      createMailThreadDetailRouteHandler(runtime)({
        req: { url: `/api/mail/threads/${thread.threadId}` },
        params: { threadId: thread.threadId },
      }),
    );

    expect(list.status).toBe(200);
    expect(list.body.threads).toHaveLength(1);
    expect(list.body.threads[0]).toMatchObject({ project: { id: project, name: "Web" }, company: null });
    expect(list.body.threads[0]?.links.project?.valueKind).toBe("inherited");
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ project: { id: project, name: "Web" }, company: null });
    expect(detail.body.links.project?.valueKind).toBe("inherited");
  });

  it("runs the same number of statements for a page of 1 thread as for a page of 50", async () => {
    const project = await newItem("projects", { name: "Web" });
    const company = await newItem("companies", { name: "Acme" });
    async function seed(prefix: string, count: number): Promise<void> {
      for (let index = 0; index < count; index += 1) {
        const thread = await newThread(`<${prefix}-${index}@example.test>`);
        await link(properties.threadProject, thread.itemId, project);
        await link(properties.threadCompany, thread.itemId, company);
        await inherit(thread, "project", {
          kind: "senderDomain",
          domain: "acme.example",
          sourcePropertyKey: "project",
        });
        await inherit(thread, "company", {
          kind: "senderDomain",
          domain: "acme.example",
          sourcePropertyKey: "company",
        });
      }
    }
    async function countStatements(expectedThreads: number): Promise<number> {
      return inTenant(() =>
        withTransaction(runtime, async (client) => {
          const spy = vi.spyOn(client, "query");
          try {
            const rows = await listMailThreads(client, 100, null, {
              box: "inbox",
              folderId: null,
              unread: false,
              mailboxId: null,
            });
            expect(rows).toHaveLength(expectedThreads);
            expect(rows.every((row) => row.project?.id === project && row.links.project && row.links.company)).toBe(
              true,
            );
            return spy.mock.calls.length;
          } finally {
            spy.mockRestore();
          }
        }),
      );
    }

    await seed("one", 1);
    const one = await countStatements(1);
    await seed("many", 49);
    const fifty = await countStatements(50);

    expect(one).toBeGreaterThan(0);
    expect(fifty).toBe(one);
  });

  it("shows another tenant none of the names and links of a thread", async () => {
    const thread = await newThread("<isolated@example.test>");
    const project = await newItem("projects", { name: "Web" });
    await link(properties.threadProject, thread.itemId, project);
    await inherit(thread, "project", { kind: "senderDomain", domain: "acme.example", sourcePropertyKey: "project" });
    const foreign = await createTestTenant(admin);
    await inTenant(() => seedSystem(runtime), foreign);

    expect(await listOf(foreign)).toEqual([]);
    await expect(detailOf(thread, foreign)).rejects.toMatchObject({ code: "not_found" });
    expect((await rowOf(thread)).project).toEqual({ id: project, name: "Web" });
  });
});
