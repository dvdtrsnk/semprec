import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { withTransaction } from "../../db/pool.js";
import { THREADS_MODULE_ID } from "../../seed/emailModuleKeys.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { PROJECTS_MODULE_ID } from "../../seed/tenDatabaseKeys.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { LocalFsBlobStorageWriter } from "../blobStorage.js";
import { ensureFolderItem } from "../folderDiscovery.js";
import { ingestEmailMessage } from "../ingest.js";
import { resolveMailModuleIds } from "../mailModuleIds.js";
import { createMailThreadFacetsRouteHandler } from "../mailThreadRoutes.js";

let admin: Pool;
let runtime: Pool;
let storageRoot: string;
let storage: LocalFsBlobStorageWriter;
let tenant: string;
let foreign: string;

function inTenant<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(runtime, fn));
}

async function seededIds(tenantId: string) {
  return inTenant(tenantId, async (client) => {
    const mail = await resolveMailModuleIds(client);
    const databaseId = async (moduleId: string): Promise<string> => {
      const database = await getDatabaseByModuleId(client, moduleId);
      if (database === null) throw new Error(`database '${moduleId}' is not seeded`);
      return database.id;
    };
    const propertyId = async (database: string, key: string): Promise<string> => {
      const { rows } = await client.query<{ id: string }>(
        "SELECT id FROM properties WHERE database_id = $1 AND key = $2",
        [database, key],
      );
      const id = rows[0]?.id;
      if (!id) throw new Error(`property '${key}' is not seeded`);
      return id;
    };
    const projectsDatabaseId = await databaseId(PROJECTS_MODULE_ID);
    return {
      ...mail,
      projectsDatabaseId,
      emailFolderProperty: await propertyId(mail.emailsDatabaseId, "folder"),
      emailAttachmentsProperty: await propertyId(mail.emailsDatabaseId, "attachments"),
      folderMailboxProperty: await propertyId(mail.foldersDatabaseId, "mailbox"),
      threadProjectProperty: await propertyId(await databaseId(THREADS_MODULE_ID), "project"),
    };
  });
}

interface SeededThread {
  messageId: string;
  emailItemId: string;
}

/** `behavior` "folder" is how the IMAP and Graph passes write a mailbox's folders, "label" how the Gmail pass does. */
async function facetsFixture(tenantId: string, behavior: "folder" | "label" = "folder") {
  const ids = await seededIds(tenantId);
  const chokePoint = createChokePoint(runtime);
  const mailboxId = await inTenant(tenantId, async (client) => {
    const item = await createItemWithClient(client, {
      databaseId: ids.mailboxesDatabaseId,
      properties: { name: "Mailbox", provider: behavior === "label" ? "gmail" : "generic" },
    });
    return item.id;
  });
  const folders = new Map<string, string>();

  const folder = async (specialPurpose: string): Promise<string> => {
    const known = folders.get(specialPurpose);
    if (known !== undefined) return known;
    const id = await inTenant(tenantId, (client) =>
      ensureFolderItem(client, {
        foldersDatabaseId: ids.foldersDatabaseId,
        mailboxItemId: mailboxId,
        mailboxRelationPropertyId: ids.folderMailboxProperty,
        providerId: specialPurpose,
        name: specialPurpose,
        behavior,
        specialPurpose,
      }),
    );
    folders.set(specialPurpose, id);
    return id;
  };

  /**
   * With several `placement`s the message is ingested once per folder under one Message-ID, leaving one Emails item
   * with an edge to every folder: a Gmail message with several labels, or an IMAP or Graph message in several folders.
   */
  const message = async (placement: string | readonly string[], replyTo?: SeededThread): Promise<SeededThread> => {
    const messageId = `<${randomUUID()}@example.test>`;
    const references = replyTo === undefined ? [] : [replyTo.messageId];
    const emailItemIds = new Set<string>();
    for (const specialPurpose of [placement].flat()) {
      const folderItemId = await folder(specialPurpose);
      const emailItemId = await inTenant(tenantId, async (client) => {
        const result = await ingestEmailMessage(client, {
          arrival: "live",
          contentState: "full",
          emailsDatabaseId: ids.emailsDatabaseId,
          filesDatabaseId: ids.filesDatabaseId,
          folderRelationPropertyId: ids.emailFolderProperty,
          attachmentsRelationPropertyId: ids.emailAttachmentsProperty,
          folderItemId,
          mailboxItemId: mailboxId,
          messageId,
          inReplyTo: references.at(-1) ?? null,
          references,
          subject: messageId,
          envelope: {
            from: { name: "Sender", address: "sender@example.test" },
            to: [{ name: "Me", address: "me@example.test" }],
          },
          bodyText: "body",
          flags: [],
          attachments: [],
          storage,
          storageKeyPrefix: "mail-thread-facets",
        });
        return result.itemId;
      });
      emailItemIds.add(emailItemId);
    }
    const [emailItemId] = emailItemIds;
    if (emailItemId === undefined || emailItemIds.size !== 1) {
      throw new Error("expected one Emails item for the one Message-ID");
    }
    return { messageId, emailItemId };
  };

  const item = async (databaseId: string, name: string): Promise<string> =>
    (await runInTenant(tenantId, () => chokePoint.createItem({ databaseId, properties: { name } }))).id;

  const project = (name: string): Promise<string> => item(ids.projectsDatabaseId, name);

  const assign = async (seeded: SeededThread, projectId: string): Promise<void> => {
    const { rows } = await inTenant(tenantId, (client) =>
      client.query<{ thread_item_id: string | null }>(
        `SELECT t.item_id AS thread_item_id FROM mail_message_meta m
         JOIN mail_threads t ON t.tenant_id = m.tenant_id AND t.id = m.thread_id WHERE m.item_id = $1`,
        [seeded.emailItemId],
      ),
    );
    const threadItemId = rows[0]?.thread_item_id;
    if (!threadItemId) throw new Error("the message has no Threads item");
    await runInTenant(tenantId, () =>
      chokePoint.createRelation({
        relationPropertyId: ids.threadProjectProperty,
        callerItemId: threadItemId,
        targetItemId: projectId,
      }),
    );
  };

  const thread = async (placement: string | readonly string[], projectId?: string): Promise<SeededThread> => {
    const seeded = await message(placement);
    if (projectId !== undefined) await assign(seeded, projectId);
    return seeded;
  };

  const trash = async (databaseId: string, itemId: string): Promise<void> => {
    const deleted = await runInTenant(tenantId, () => chokePoint.softDeleteItem(databaseId, itemId));
    if (deleted === null) throw new Error(`item ${itemId} was not moved to the trash`);
  };

  return { ids, message, project, thread, trash };
}

const facetsBody = z
  .object({
    total: z.number(),
    projects: z.object({
      total: z.number(),
      items: z.array(z.object({ id: z.string(), count: z.number() }).strict()),
    }),
  })
  .strict();

type FacetsBody = z.infer<typeof facetsBody>;

async function facets(tenantId: string): Promise<FacetsBody> {
  const answer = await runInTenant(tenantId, () => createMailThreadFacetsRouteHandler(runtime)());
  expect(answer.status).toBe(200);
  return facetsBody.parse(answer.body);
}

function byId<T extends { id: string }>(rows: T[]): T[] {
  return [...rows].sort((left, right) => (left.id < right.id ? -1 : 1));
}

/** The scenario of the count tests: three projects and five visible threads, one of them without a project. */
async function seedScenario(tenantId: string) {
  const fixture = await facetsFixture(tenantId);
  const website = await fixture.project("Website");
  const hiring = await fixture.project("Hiring");
  const empty = await fixture.project("Empty");

  const first = await fixture.thread("inbox", website);
  await fixture.message("inbox", first);
  await fixture.thread("archive", website);
  await fixture.thread("sent", website);
  await fixture.thread("inbox", hiring);
  await fixture.thread("inbox");

  const unfiltered: FacetsBody = {
    total: 5,
    projects: {
      total: 5,
      items: byId([
        { id: website, count: 3 },
        { id: hiring, count: 1 },
      ]),
    },
  };
  return { fixture, website, hiring, empty, unfiltered };
}

beforeAll(async () => {
  admin = getTestPool();
  runtime = await createRuntimeRolePool(admin, "semprec_data");
  const role = await runAsSystem("verify mail thread facets test role", () =>
    runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    ),
  );
  expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  storageRoot = await mkdtemp(join(tmpdir(), "semprec-mail-thread-facets-"));
  storage = new LocalFsBlobStorageWriter(storageRoot);
});

beforeEach(async () => {
  await resetDatabase(admin);
  tenant = await createTestTenant(admin);
  foreign = await createTestTenant(admin);
  for (const id of [tenant, foreign]) await runInTenant(id, () => seedSystem(runtime));
});

afterAll(async () => {
  await runtime?.end();
  await admin?.end();
  await rm(storageRoot, { recursive: true, force: true });
});

describe("GET /api/mail/threads/facets (issue gh-1747)", () => {
  it("counts every visible thread in the totals and lists a project only with its threads", async () => {
    const scenario = await seedScenario(tenant);

    const answer = await facets(tenant);

    expect(answer).toEqual(scenario.unfiltered);
    expect(answer.projects.items.map((row) => row.id)).not.toContain(scenario.empty);
  });

  it("counts a thread whose only messages are in Junk or Trash nowhere", async () => {
    const fixture = await facetsFixture(tenant);
    const spam = await fixture.project("Spam");
    const rescued = await fixture.project("Rescued");
    await fixture.thread("junk", spam);
    await fixture.thread("trash", spam);
    const junked = await fixture.thread("junk", spam);
    await fixture.message("trash", junked);
    const mixed = await fixture.thread("junk", rescued);
    await fixture.message("inbox", mixed);

    expect(await facets(tenant)).toEqual({ total: 1, projects: { total: 1, items: [{ id: rescued, count: 1 }] } });
  });

  // The Gmail pass links one message to the folder of every label it carries, so a message in Trash or
  // in Junk keeps its edge to Sent, or to a user label (special purpose "none"), while it carries it.
  it.each([
    ["trash", "none"],
    ["junk", "none"],
    ["trash", "sent"],
  ])("counts a Gmail thread whose only message carries the labels %s and %s nowhere", async (...labels) => {
    const gmail = await facetsFixture(tenant, "label");
    const website = await gmail.project("Website");
    await gmail.thread(labels, website);

    expect(await facets(tenant)).toEqual({ total: 0, projects: { total: 0, items: [] } });
  });

  it("counts a Gmail thread once when one of its messages carries no Junk or Trash label", async () => {
    const gmail = await facetsFixture(tenant, "label");
    const website = await gmail.project("Website");
    await gmail.thread(["inbox", "none"], website);
    const trashed = await gmail.thread(["trash", "none"], website);
    await gmail.message("inbox", trashed);

    expect(await facets(tenant)).toEqual({ total: 2, projects: { total: 2, items: [{ id: website, count: 2 }] } });
  });

  it("counts a thread of a mailbox of folders whose only message lies in Junk or Trash and in another folder", async () => {
    const fixture = await facetsFixture(tenant, "folder");
    const website = await fixture.project("Website");
    // One Message-ID in two IMAP or Graph folders is two messages, and the one outside Trash, or
    // outside Junk, is visible. A Trash or Junk folder hides the whole copy only where folders are labels.
    await fixture.thread(["trash", "archive"], website);
    await fixture.thread(["junk", "none"], website);

    expect(await facets(tenant)).toEqual({ total: 2, projects: { total: 2, items: [{ id: website, count: 2 }] } });
  });

  it("counts a thread whose only message is deleted, or a draft, nowhere", async () => {
    const fixture = await facetsFixture(tenant);
    const website = await fixture.project("Website");
    const removed = await fixture.thread("inbox", website);
    await fixture.thread("drafts", website);
    expect(await facets(tenant)).toEqual({ total: 1, projects: { total: 1, items: [{ id: website, count: 1 }] } });

    await fixture.trash(fixture.ids.emailsDatabaseId, removed.emailItemId);

    expect(await facets(tenant)).toEqual({ total: 0, projects: { total: 0, items: [] } });
  });

  it("reads a project in the trash as no project: its threads stay in the totals and leave every item", async () => {
    const fixture = await facetsFixture(tenant);
    const website = await fixture.project("Website");
    const hiring = await fixture.project("Hiring");
    await fixture.thread("inbox", website);
    await fixture.thread("inbox", hiring);

    await fixture.trash(fixture.ids.projectsDatabaseId, website);

    expect(await facets(tenant)).toEqual({ total: 2, projects: { total: 2, items: [{ id: hiring, count: 1 }] } });
  });

  it("counts nothing of another tenant", async () => {
    const own = await seedScenario(tenant);
    const other = await facetsFixture(foreign);
    const otherProject = await other.project("Foreign project");
    await other.thread("inbox", otherProject);
    await other.thread("inbox");

    // The other tenant sees exactly its own rows, so its rows exist and are countable.
    expect(await facets(foreign)).toEqual({
      total: 2,
      projects: { total: 2, items: [{ id: otherProject, count: 1 }] },
    });
    expect(await facets(tenant)).toEqual(own.unfiltered);
  });

  it("answers zeros for a tenant with no mail and for a tenant that is not seeded", async () => {
    const empty = { total: 0, projects: { total: 0, items: [] } };
    expect(await facets(tenant)).toEqual(empty);
    expect(await facets(await createTestTenant(admin))).toEqual(empty);
  });
});
