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
import { ValidationError } from "../../errors.js";
import { THREADS_MODULE_ID } from "../../seed/emailModuleKeys.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { AREAS_MODULE_ID, PROJECTS_MODULE_ID } from "../../seed/tenDatabaseKeys.js";
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

/** Runs `fn` in one transaction of `tenantId`, on the runtime role row-level security applies to. */
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
    const areasDatabaseId = await databaseId(AREAS_MODULE_ID);
    const projectsDatabaseId = await databaseId(PROJECTS_MODULE_ID);
    return {
      ...mail,
      areasDatabaseId,
      projectsDatabaseId,
      emailFolderProperty: await propertyId(mail.emailsDatabaseId, "folder"),
      emailAttachmentsProperty: await propertyId(mail.emailsDatabaseId, "attachments"),
      folderMailboxProperty: await propertyId(mail.foldersDatabaseId, "mailbox"),
      threadProjectProperty: await propertyId(await databaseId(THREADS_MODULE_ID), "project"),
      projectAreaProperty: await propertyId(projectsDatabaseId, "area"),
      seededAreaIds: (
        await client.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1 AND deleted_at IS NULL", [
          areasDatabaseId,
        ])
      ).rows.map((row) => row.id),
    };
  });
}

interface SeededThread {
  /** The Message-ID of the thread's first message, for a reply to refer to. */
  messageId: string;
  /** The Emails item of that message. */
  emailItemId: string;
}

/**
 * One tenant's fixture: one mailbox, and every row written through the writers production uses.
 * `behavior` is what a folder of that mailbox is: "folder" as the IMAP and Graph passes write it, or
 * "label" as the Gmail pass writes it.
 */
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

  /** The mailbox's folder of `specialPurpose`, through folder discovery, created on first use. */
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
   * One message through the ingest writer; `replyTo` joins it to that thread. `placement` is the
   * special purpose of its folder, or of each of its folders: the message is then ingested once per
   * folder under one Message-ID, which leaves one Emails item with an edge to every folder. That is a
   * Gmail message that carries several labels (`reconcileGmailAccount` ingests it once per label), or
   * a message that lies in several folders of an IMAP or Graph mailbox.
   */
  const message = async (placement: string | readonly string[], replyTo?: SeededThread): Promise<SeededThread> => {
    const messageId = `<${randomUUID()}@example.test>`;
    const references = replyTo === undefined ? [] : [replyTo.messageId];
    const emailItemIds = new Set<string>();
    for (const specialPurpose of [placement].flat()) {
      const folderItemId = await folder(specialPurpose);
      const emailItemId = await inTenant(tenantId, async (client) => {
        const result = await ingestEmailMessage(client, {
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

  const area = (name: string): Promise<string> => item(ids.areasDatabaseId, name);

  /** A Projects item, in `areaId` through `Projects.area` when one is given. */
  const project = async (name: string, areaId?: string): Promise<string> => {
    const projectId = await item(ids.projectsDatabaseId, name);
    if (areaId !== undefined) {
      await runInTenant(tenantId, () =>
        chokePoint.createRelation({
          relationPropertyId: ids.projectAreaProperty,
          callerItemId: projectId,
          targetItemId: areaId,
        }),
      );
    }
    return projectId;
  };

  /** Gives the thread of `seeded` the project through `Threads.project`, the relation a user or Semp writes. */
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

  /** One new thread of one message placed as `message` places it, with `projectId` when one is given. */
  const thread = async (placement: string | readonly string[], projectId?: string): Promise<SeededThread> => {
    const seeded = await message(placement);
    if (projectId !== undefined) await assign(seeded, projectId);
    return seeded;
  };

  /** Moves one item to the trash through the choke point and fails if nothing was deleted. */
  const trash = async (databaseId: string, itemId: string): Promise<void> => {
    const deleted = await runInTenant(tenantId, () => chokePoint.softDeleteItem(databaseId, itemId));
    if (deleted === null) throw new Error(`item ${itemId} was not moved to the trash`);
  };

  return { ids, message, area, project, thread, trash };
}

const facetsBody = z
  .object({
    total: z.number(),
    areas: z.object({ total: z.number(), items: z.array(z.object({ id: z.string(), count: z.number() }).strict()) }),
    projects: z.object({
      total: z.number(),
      items: z.array(z.object({ id: z.string(), areaId: z.string().nullable(), count: z.number() }).strict()),
    }),
  })
  .strict();

type FacetsBody = z.infer<typeof facetsBody>;

/** `GET /api/mail/threads/facets?<query>` as `tenantId`, the way the adapter calls it: inside the session's tenant. */
async function facets(tenantId: string, query = ""): Promise<FacetsBody> {
  const url = `/api/mail/threads/facets${query === "" ? "" : `?${query}`}`;
  const answer = await runInTenant(tenantId, () => createMailThreadFacetsRouteHandler(runtime)({ req: { url } }));
  expect(answer.status).toBe(200);
  return facetsBody.parse(answer.body);
}

/** The rejection of `GET /api/mail/threads/facets?<query>`, failing when the request is answered. */
async function refusal(tenantId: string, query: string): Promise<unknown> {
  const url = `/api/mail/threads/facets?${query}`;
  try {
    await runInTenant(tenantId, () => createMailThreadFacetsRouteHandler(runtime)({ req: { url } }));
  } catch (error) {
    return error;
  }
  throw new Error("expected the facets request to be refused");
}

/** Rows in the order the route returns them: by id. */
function byId<T extends { id: string }>(rows: T[]): T[] {
  return [...rows].sort((left, right) => (left.id < right.id ? -1 : 1));
}

/**
 * The scenario of the count tests: three areas next to the seeded one, four projects (two in Work,
 * one in Home, one in no area) and seven visible threads, one of them without a project.
 */
async function seedScenario(tenantId: string) {
  const fixture = await facetsFixture(tenantId);
  const [unplanned] = fixture.ids.seededAreaIds;
  if (unplanned === undefined || fixture.ids.seededAreaIds.length !== 1) {
    throw new Error("expected exactly the seeded area before the scenario");
  }
  const work = await fixture.area("Work");
  const home = await fixture.area("Home");
  const empty = await fixture.area("Empty");
  const website = await fixture.project("Website", work);
  const hiring = await fixture.project("Hiring", work);
  const garden = await fixture.project("Garden", home);
  const loose = await fixture.project("Loose");

  // Two messages of one thread: one thread, not two.
  const first = await fixture.thread("inbox", website);
  await fixture.message("inbox", first);
  // Outside the inbox: no box or folder filter applies.
  await fixture.thread("archive", website);
  await fixture.thread("sent", website);
  await fixture.thread("inbox", hiring);
  await fixture.thread("inbox", garden);
  await fixture.thread("inbox", loose);
  await fixture.thread("inbox");

  const unfiltered: FacetsBody = {
    total: 7,
    areas: {
      total: 7,
      items: byId([
        { id: unplanned, count: 0 },
        { id: work, count: 4 },
        { id: home, count: 1 },
        { id: empty, count: 0 },
      ]),
    },
    projects: {
      total: 7,
      items: byId([
        { id: website, areaId: work, count: 3 },
        { id: hiring, areaId: work, count: 1 },
        { id: garden, areaId: home, count: 1 },
        { id: loose, areaId: null, count: 1 },
      ]),
    },
  };
  return { fixture, unplanned, work, home, empty, website, hiring, garden, loose, unfiltered };
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
  it("counts every visible thread in the totals, lists an area without threads with 0 and a project only with its threads", async () => {
    const scenario = await seedScenario(tenant);

    expect(await facets(tenant)).toEqual(scenario.unfiltered);
  });

  it("narrows the project counts to the selected area's projects and leaves the area counts as they were", async () => {
    const scenario = await seedScenario(tenant);

    expect(await facets(tenant, `areaId=${scenario.work}`)).toEqual({
      total: 7,
      areas: scenario.unfiltered.areas,
      projects: {
        total: 4,
        items: byId([
          { id: scenario.website, areaId: scenario.work, count: 3 },
          { id: scenario.hiring, areaId: scenario.work, count: 1 },
        ]),
      },
    });
  });

  it("narrows the area counts to the selected project's threads and leaves the project counts as they were", async () => {
    const scenario = await seedScenario(tenant);

    expect(await facets(tenant, `projectId=${scenario.website}`)).toEqual({
      total: 7,
      areas: {
        total: 3,
        items: byId([
          { id: scenario.unplanned, count: 0 },
          { id: scenario.work, count: 3 },
          { id: scenario.home, count: 0 },
          { id: scenario.empty, count: 0 },
        ]),
      },
      projects: scenario.unfiltered.projects,
    });
  });

  it("narrows each group by the other group's selection when an area and a project are both selected", async () => {
    const scenario = await seedScenario(tenant);

    expect(await facets(tenant, `areaId=${scenario.home}&projectId=${scenario.hiring}`)).toEqual({
      total: 7,
      areas: {
        total: 1,
        items: byId([
          { id: scenario.unplanned, count: 0 },
          { id: scenario.work, count: 1 },
          { id: scenario.home, count: 0 },
          { id: scenario.empty, count: 0 },
        ]),
      },
      projects: { total: 1, items: [{ id: scenario.garden, areaId: scenario.home, count: 1 }] },
    });
  });

  it("counts the threads of a selected project that has no area in the area total and in no area", async () => {
    const scenario = await seedScenario(tenant);

    const answer = await facets(tenant, `projectId=${scenario.loose}`);

    expect(answer.areas).toEqual({
      total: 1,
      items: scenario.unfiltered.areas.items.map((row) => ({ id: row.id, count: 0 })),
    });
    expect(answer.projects).toEqual(scenario.unfiltered.projects);
  });

  it("selects no thread for an id that names no area or project", async () => {
    const scenario = await seedScenario(tenant);

    const unknownArea = await facets(tenant, `areaId=${randomUUID()}`);
    expect(unknownArea).toEqual({ ...scenario.unfiltered, projects: { total: 0, items: [] } });

    const unknownProject = await facets(tenant, `projectId=${randomUUID()}`);
    expect(unknownProject).toEqual({
      ...scenario.unfiltered,
      areas: { total: 0, items: scenario.unfiltered.areas.items.map((row) => ({ id: row.id, count: 0 })) },
    });
  });

  it("counts a thread whose only messages are in Junk or Trash nowhere", async () => {
    const fixture = await facetsFixture(tenant);
    const hidden = await fixture.area("Hidden");
    const spam = await fixture.project("Spam", hidden);
    const kept = await fixture.area("Kept");
    const rescued = await fixture.project("Rescued", kept);
    await fixture.thread("junk", spam);
    await fixture.thread("trash", spam);
    // Two messages in Junk and Trash: still no visible message.
    const junked = await fixture.thread("junk", spam);
    await fixture.message("trash", junked);
    // One message in Junk and its reply in the inbox: one visible message, so the thread counts once.
    const mixed = await fixture.thread("junk", rescued);
    await fixture.message("inbox", mixed);

    const answer = await facets(tenant);

    expect(answer.total).toBe(1);
    expect(answer.areas.total).toBe(1);
    expect(answer.areas.items).toEqual(
      byId([
        ...fixture.ids.seededAreaIds.map((id) => ({ id, count: 0 })),
        { id: hidden, count: 0 },
        { id: kept, count: 1 },
      ]),
    );
    expect(answer.projects).toEqual({ total: 1, items: [{ id: rescued, areaId: kept, count: 1 }] });
    // Selecting the project of the hidden threads finds none of them either.
    expect((await facets(tenant, `projectId=${spam}`)).areas.total).toBe(0);
    expect((await facets(tenant, `areaId=${hidden}`)).projects).toEqual({ total: 0, items: [] });
  });

  // The Gmail pass links one message to the folder of every label it carries, so a message in Trash or
  // in Junk keeps its edge to Sent, or to a user label (special purpose "none"), while it carries it.
  it.each([
    ["trash", "none"],
    ["junk", "none"],
    ["trash", "sent"],
  ])("counts a Gmail thread whose only message carries the labels %s and %s nowhere", async (...labels) => {
    const gmail = await facetsFixture(tenant, "label");
    const work = await gmail.area("Work");
    const website = await gmail.project("Website", work);
    await gmail.thread(labels, website);

    expect(await facets(tenant)).toEqual({
      total: 0,
      areas: {
        total: 0,
        items: byId([...gmail.ids.seededAreaIds.map((id) => ({ id, count: 0 })), { id: work, count: 0 }]),
      },
      projects: { total: 0, items: [] },
    });
    // Selecting the project or the area of the hidden thread does not find it either.
    expect((await facets(tenant, `projectId=${website}`)).areas.total).toBe(0);
    expect((await facets(tenant, `areaId=${work}`)).projects).toEqual({ total: 0, items: [] });
  });

  it("counts a Gmail thread once when one of its messages carries no Junk or Trash label", async () => {
    const gmail = await facetsFixture(tenant, "label");
    const work = await gmail.area("Work");
    const website = await gmail.project("Website", work);
    // Two labels, neither of them Junk or Trash.
    await gmail.thread(["inbox", "none"], website);
    // A trashed message that keeps its user label, and a reply in the inbox: the reply is visible.
    const trashed = await gmail.thread(["trash", "none"], website);
    await gmail.message("inbox", trashed);

    expect(await facets(tenant)).toEqual({
      total: 2,
      areas: {
        total: 2,
        items: byId([...gmail.ids.seededAreaIds.map((id) => ({ id, count: 0 })), { id: work, count: 2 }]),
      },
      projects: { total: 2, items: [{ id: website, areaId: work, count: 2 }] },
    });
  });

  it("counts a thread of a mailbox of folders whose only message lies in Junk or Trash and in another folder", async () => {
    const fixture = await facetsFixture(tenant, "folder");
    const work = await fixture.area("Work");
    const website = await fixture.project("Website", work);
    // One Message-ID in two IMAP or Graph folders is two messages, and the one outside Trash, or
    // outside Junk, is visible. A Trash or Junk folder hides the whole copy only where folders are labels.
    await fixture.thread(["trash", "archive"], website);
    await fixture.thread(["junk", "none"], website);

    expect(await facets(tenant)).toEqual({
      total: 2,
      areas: {
        total: 2,
        items: byId([...fixture.ids.seededAreaIds.map((id) => ({ id, count: 0 })), { id: work, count: 2 }]),
      },
      projects: { total: 2, items: [{ id: website, areaId: work, count: 2 }] },
    });
  });

  it("counts a thread whose only message is deleted, or a draft, nowhere", async () => {
    const fixture = await facetsFixture(tenant);
    const work = await fixture.area("Work");
    const website = await fixture.project("Website", work);
    const removed = await fixture.thread("inbox", website);
    await fixture.thread("drafts", website);
    const before = await facets(tenant);
    expect({ total: before.total, projects: before.projects }).toEqual({
      total: 1,
      projects: { total: 1, items: [{ id: website, areaId: work, count: 1 }] },
    });

    await fixture.trash(fixture.ids.emailsDatabaseId, removed.emailItemId);

    const after = await facets(tenant);
    expect(after.total).toBe(0);
    expect(after.areas.total).toBe(0);
    expect(after.areas.items).toContainEqual({ id: work, count: 0 });
    expect(after.projects).toEqual({ total: 0, items: [] });
  });

  it("reads a project in the trash as no project: its threads stay in the totals and leave every item", async () => {
    const fixture = await facetsFixture(tenant);
    const work = await fixture.area("Work");
    const website = await fixture.project("Website", work);
    const hiring = await fixture.project("Hiring", work);
    await fixture.thread("inbox", website);
    await fixture.thread("inbox", hiring);
    expect((await facets(tenant)).areas.items).toContainEqual({ id: work, count: 2 });

    await fixture.trash(fixture.ids.projectsDatabaseId, website);

    const answer = await facets(tenant);
    expect(answer.total).toBe(2);
    expect(answer.areas.total).toBe(2);
    expect(answer.areas.items).toContainEqual({ id: work, count: 1 });
    expect(answer.projects).toEqual({ total: 2, items: [{ id: hiring, areaId: work, count: 1 }] });
    expect((await facets(tenant, `projectId=${website}`)).areas.total).toBe(0);
  });

  it("lists no area in the trash and reads its project as a project without an area", async () => {
    const fixture = await facetsFixture(tenant);
    const work = await fixture.area("Work");
    const home = await fixture.area("Home");
    const website = await fixture.project("Website", work);
    const garden = await fixture.project("Garden", home);
    await fixture.thread("inbox", website);
    await fixture.thread("inbox", garden);

    await fixture.trash(fixture.ids.areasDatabaseId, home);

    const answer = await facets(tenant);
    expect(answer.areas).toEqual({
      total: 2,
      items: byId([...fixture.ids.seededAreaIds.map((id) => ({ id, count: 0 })), { id: work, count: 1 }]),
    });
    expect(answer.projects).toEqual({
      total: 2,
      items: byId([
        { id: website, areaId: work, count: 1 },
        { id: garden, areaId: null, count: 1 },
      ]),
    });
    expect((await facets(tenant, `areaId=${home}`)).projects).toEqual({ total: 0, items: [] });
  });

  it.each(["areaId", "projectId"])("refuses %s when its value is not a UUID, with a 400 naming it", async (field) => {
    for (const value of ["not-a-uuid", ""]) {
      const error = await refusal(tenant, `${field}=${value}`);
      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject({ status: 400, details: { field } });
    }
  });

  it("counts nothing of another tenant and answers its ids like unknown ids", async () => {
    const own = await seedScenario(tenant);
    const other = await facetsFixture(foreign);
    const otherArea = await other.area("Foreign area");
    const otherProject = await other.project("Foreign project", otherArea);
    await other.thread("inbox", otherProject);
    await other.thread("inbox");

    // The other tenant sees exactly its own rows, so its rows exist and are countable.
    expect(await facets(foreign)).toEqual({
      total: 2,
      areas: {
        total: 2,
        items: byId([...other.ids.seededAreaIds.map((id) => ({ id, count: 0 })), { id: otherArea, count: 1 }]),
      },
      projects: { total: 2, items: [{ id: otherProject, areaId: otherArea, count: 1 }] },
    });
    expect(await facets(tenant)).toEqual(own.unfiltered);

    const unknown = await facets(tenant, `areaId=${randomUUID()}&projectId=${randomUUID()}`);
    expect(await facets(tenant, `areaId=${otherArea}&projectId=${otherProject}`)).toEqual(unknown);
    expect(unknown.areas.total).toBe(0);
    expect(unknown.projects).toEqual({ total: 0, items: [] });
  });

  it("answers zeros with the seeded area for a tenant with no mail, and with no item for a tenant that is not seeded", async () => {
    const seeded = await seededIds(tenant);

    expect(await facets(tenant)).toEqual({
      total: 0,
      areas: { total: 0, items: byId(seeded.seededAreaIds.map((id) => ({ id, count: 0 }))) },
      projects: { total: 0, items: [] },
    });
    expect(seeded.seededAreaIds).toHaveLength(1);
    expect(await facets(await createTestTenant(admin))).toEqual({
      total: 0,
      areas: { total: 0, items: [] },
      projects: { total: 0, items: [] },
    });
  });
});
