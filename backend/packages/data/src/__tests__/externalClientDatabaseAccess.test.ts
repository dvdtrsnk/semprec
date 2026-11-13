import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { ModuleRegistry } from "@semprec/module-registry";
import { runInTenant } from "@semprec/shared";
import {
  assertReaderDatabaseAccess,
  assertWriterDatabaseAccess,
  listUnreadableDatabaseIds,
  readerOfWriter,
  type DatabaseReader,
} from "../agentGrants/agentDatabaseAccess.js";
import { setAgentDatabaseGrant } from "../agentGrants/agentDatabaseGrantsAdminStore.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { createRelationIfAbsentWithClient } from "../chokePoint/relationOps.js";
import {
  assertReaderItemPathAccess,
  assertReaderPropertyAccess,
  assertReaderViewAccess,
} from "../chokePoint/readerObjectAccess.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { withTransaction } from "../db/pool.js";
import { createDocStore } from "../docs/docStore.js";
import { createSubpageWithClient } from "../docs/pageOperations.js";
import { assertAgentPageAccess } from "../docs/pageOwnerDatabase.js";
import { generateSchemaProjection } from "../manifest/schemaProjection.js";
import { seedSystem } from "../seed/seedSystem.js";
import { SENSITIVE_DATABASE_KEYS } from "../seed/sensitiveDatabaseKeys.js";
import { HEALTH_RECORDS_MODULE_ID, TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import {
  createRuntimeRolePool,
  createTestProjectItem,
  createTestTenant,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";
import type { DatabaseRow, ItemRow } from "../types.js";

// Seeding the system databases of one tenant is the slow part of this file.
const SEEDING_TEST_TIMEOUT_MS = 120_000;
const FORBIDDEN = { status: 403, code: "forbidden" };
const EXTERNAL: DatabaseReader = { externalClient: true };

let adminPool: Pool;
let dataPool: Pool;
let cp: ChokePoint;
let tenantId: string;
let health: DatabaseRow;
let tasks: DatabaseRow;

function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  return runInTenant(tenantId, fn);
}

function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return inTenant(() => withTransaction(dataPool, fn));
}

/** The writer `writerIdentityOf` derives for an `/mcp` call on a human token. */
const externalWriter = (): WriterIdentity => ({
  writerKind: "agent",
  onBehalfOfUserId: randomUUID(),
  externalClient: true,
});

/** A user-created database with a title property. */
async function newUserDatabase(name = "Notes"): Promise<DatabaseRow> {
  return inTenant(async () => {
    const database = await cp.createDatabase({ name });
    await cp.createProperty({ databaseId: database.id, key: "name", name: "Name", type: "title" });
    return database;
  });
}

function newHealthRecord(name = "Private diagnosis"): Promise<ItemRow> {
  return inTenant(() => cp.createItem({ databaseId: health.id, properties: { name } }));
}

async function systemDatabase(moduleId: string): Promise<DatabaseRow> {
  const database = await inTransaction((client) => getDatabaseByModuleId(client, moduleId));
  if (!database) throw new Error(`System database ${moduleId} is missing`);
  return database;
}

function check(reader: DatabaseReader, databaseId: string, access: "read" | "write") {
  return inTransaction((client) => assertReaderDatabaseAccess(client, reader, databaseId, access));
}

describe("an external client's access to databases (issue #1998)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
    await resetDatabase(adminPool);
    tenantId = await createTestTenant(adminPool);
    await inTenant(() => seedSystem(dataPool, createViewTypeRegistry()));
    cp = createChokePoint(dataPool);
    health = await systemDatabase(HEALTH_RECORDS_MODULE_ID);
    tasks = await systemDatabase(TASKS_MODULE_ID);
  }, SEEDING_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await dataPool?.end();
  });

  describe("objects named by their own id", () => {
    it("decides a property, a view and an item by the database it belongs to, and lets an unknown id pass to its own not found", async () => {
      const open = await newUserDatabase("Object access");
      const [healthProperty] = await inTenant(() => cp.listProperties(health.id));
      const [openProperty] = await inTenant(() => cp.listProperties(open.id));
      const healthView = await inTenant(() => cp.createView({ databaseId: health.id, type: "table", name: "Health" }));
      const openView = await inTenant(() => cp.createView({ databaseId: open.id, type: "table", name: "Open" }));
      const curated = await inTenant(() =>
        cp.createView({ type: "list", name: "Curated", config: { membership: "manual" } }),
      );
      const record = await newHealthRecord("Object access record");
      const item = await inTenant(() => cp.createItem({ databaseId: open.id, properties: { name: "Open item" } }));

      for (const access of ["read", "write"] as const) {
        await expect(
          inTransaction((client) => assertReaderPropertyAccess(client, EXTERNAL, healthProperty!.id, access)),
          `property ${access}`,
        ).rejects.toMatchObject(FORBIDDEN);
        await inTransaction((client) => assertReaderPropertyAccess(client, EXTERNAL, openProperty!.id, access));
        await expect(
          inTransaction((client) => assertReaderViewAccess(client, EXTERNAL, healthView.id, access)),
          `view ${access}`,
        ).rejects.toMatchObject(FORBIDDEN);
        await inTransaction((client) => assertReaderViewAccess(client, EXTERNAL, openView.id, access));
        await inTransaction((client) => assertReaderViewAccess(client, EXTERNAL, curated.id, access));
        await expect(
          inTransaction((client) => assertReaderItemPathAccess(client, EXTERNAL, record.id, access)),
          `item ${access}`,
        ).rejects.toMatchObject(FORBIDDEN);
        await inTransaction((client) => assertReaderItemPathAccess(client, EXTERNAL, item.id, access));
        await inTransaction((client) => assertReaderViewAccess(client, EXTERNAL, randomUUID(), access));
        await inTransaction((client) => assertReaderPropertyAccess(client, EXTERNAL, randomUUID(), access));
        await inTransaction((client) => assertReaderItemPathAccess(client, EXTERNAL, randomUUID(), access));
      }
    });

    it("refuses an item that sits in a database nested under a sensitive record, and allows one nested under an open item", async () => {
      const open = await newUserDatabase("Nesting parents");
      const record = await newHealthRecord("Nesting record");
      const openParent = await inTenant(() => cp.createItem({ databaseId: open.id, properties: { name: "Parent" } }));
      const underRecord = await inTenant(() => cp.createDatabase({ name: "Under record", parentItemId: record.id }));
      const underOpen = await inTenant(() => cp.createDatabase({ name: "Under open", parentItemId: openParent.id }));
      for (const nested of [underRecord, underOpen]) {
        await inTenant(() => cp.createProperty({ databaseId: nested.id, key: "name", name: "Name", type: "title" }));
      }
      const hiddenChild = await inTenant(() =>
        cp.createItem({ databaseId: underRecord.id, properties: { name: "Child of a record" } }),
      );
      const openChild = await inTenant(() =>
        cp.createItem({ databaseId: underOpen.id, properties: { name: "Child of an open item" } }),
      );

      await expect(
        inTransaction((client) => assertReaderItemPathAccess(client, EXTERNAL, hiddenChild.id, "read")),
      ).rejects.toMatchObject(FORBIDDEN);
      await inTransaction((client) => assertReaderItemPathAccess(client, EXTERNAL, openChild.id, "write"));
    });

    it("refuses to nest a new database under a sensitive record and creates nothing", async () => {
      const record = await newHealthRecord("Nesting target");
      const before = (await inTenant(() => cp.listDatabases())).length;
      await expect(
        inTenant(() => cp.createDatabase({ name: "Nested by a client", parentItemId: record.id }, undefined, EXTERNAL)),
      ).rejects.toMatchObject(FORBIDDEN);
      expect(await inTenant(() => cp.listDatabases())).toHaveLength(before);
    });
  });

  describe("the access decision", () => {
    it("refuses read and write of a sensitive database and allows both for every other database", async () => {
      expect(health.sensitive).toBe(true);
      expect(tasks.sensitive).toBe(false);
      const open = await newUserDatabase();
      for (const access of ["read", "write"] as const) {
        await expect(check(EXTERNAL, health.id, access), `health ${access}`).rejects.toMatchObject(FORBIDDEN);
        await check(EXTERNAL, open.id, access);
        await check(EXTERNAL, tasks.id, access);
      }
    });

    it("refuses every database the sensitive keys name", async () => {
      for (const key of SENSITIVE_DATABASE_KEYS) {
        const database = await systemDatabase(key);
        await expect(check(EXTERNAL, database.id, "read"), key).rejects.toMatchObject(FORBIDDEN);
      }
    });

    it("is not changed by a project's rows: a grant does not open a sensitive database and a none row does not close another", async () => {
      const project = await inTenant(() => createTestProjectItem(dataPool));
      const open = await newUserDatabase("Switched off for a project");
      await inTransaction(async (client) => {
        await setAgentDatabaseGrant(client, { projectItemId: project, databaseId: health.id, access: "write" });
        await setAgentDatabaseGrant(client, { projectItemId: project, databaseId: open.id, access: "none" });
      });
      await check(project, health.id, "write");
      await expect(check(project, open.id, "read")).rejects.toMatchObject(FORBIDDEN);
      await expect(check(EXTERNAL, health.id, "read")).rejects.toMatchObject(FORBIDDEN);
      await check(EXTERNAL, open.id, "write");
    });

    it("answers not found for a database the tenant does not have", async () => {
      await expect(check(EXTERNAL, randomUUID(), "read")).rejects.toMatchObject({ status: 404 });
    });

    it("names the database and the access in a refusal and carries no content of an item", async () => {
      const record = await newHealthRecord("Secret diagnosis xyz");
      const refusal = await inTenant(() => cp.findItem(record.id, undefined, EXTERNAL)).catch(
        (error: unknown) => error,
      );
      expect(refusal).toMatchObject({ ...FORBIDDEN, details: { databaseId: health.id, access: "read" } });
      expect(String(refusal)).toContain("An external client");
      expect(
        JSON.stringify({ message: String(refusal), details: Reflect.get(Object(refusal), "details") }),
      ).not.toContain("Secret diagnosis");
    });

    it("lists the sensitive databases as unreadable and no other", async () => {
      const open = await newUserDatabase("Open for the list");
      const unreadable = await inTransaction((client) => listUnreadableDatabaseIds(client, EXTERNAL));
      const sensitiveIds = await Promise.all(
        SENSITIVE_DATABASE_KEYS.map(async (key) => (await systemDatabase(key)).id),
      );
      expect([...unreadable].sort()).toEqual([...sensitiveIds].sort());
      expect(unreadable.has(open.id)).toBe(false);
      expect(unreadable.has(tasks.id)).toBe(false);
    });
  });

  describe("the reader of a writer", () => {
    it("names the project of an agent, the marker of an external client and nothing for a person, the system or no writer", () => {
      expect(readerOfWriter({ agentProjectItemId: "project-1" })).toBe("project-1");
      expect(readerOfWriter({ externalClient: true })).toEqual({ externalClient: true });
      expect(readerOfWriter({ agentProjectItemId: "project-1", externalClient: true })).toBe("project-1");
      expect(readerOfWriter({})).toBeUndefined();
      expect(readerOfWriter({ ...externalWriter(), externalClient: undefined })).toBeUndefined();
      expect(readerOfWriter(undefined)).toBeUndefined();
    });

    it("checks a writer with the marker and passes a person, the system and an unmarked agent untouched", async () => {
      await expect(
        inTransaction((client) => assertWriterDatabaseAccess(client, externalWriter(), health.id, "write")),
      ).rejects.toMatchObject(FORBIDDEN);
      await inTransaction((client) => assertWriterDatabaseAccess(client, externalWriter(), tasks.id, "write"));
      const unchecked: WriterIdentity[] = [
        { writerKind: "user" },
        { writerKind: "system" },
        { writerKind: "agent", onBehalfOfUserId: randomUUID() },
      ];
      for (const writer of unchecked) {
        await inTransaction((client) => assertWriterDatabaseAccess(client, writer, health.id, "write"));
      }
      await inTransaction((client) => assertWriterDatabaseAccess(client, undefined, health.id, "write"));
    });
  });

  describe("pages", () => {
    // The page operations use the one page-owner resolver of the per-database grants (`resolvePageOwnerDatabase`) for an
    // external client as for an agent's project: the database of the page's item, or of the root host of a subpage.
    const pageAccess = (reader: DatabaseReader | undefined, itemId: string, access: "read" | "write") =>
      inTransaction((client) => assertAgentPageAccess(client, reader, itemId, access));

    const subpageOf = async (parentItemId: string): Promise<string> => {
      const output = await inTransaction((client) =>
        createSubpageWithClient(client, { parent: { itemId: parentItemId }, title: "Sub" }, "user"),
      );
      const page = output.pages[0];
      if (!page) throw new Error("Missing subpage");
      return page.pageItemId;
    };

    it("refuses the page of a record of a sensitive database and of its subpage, and allows the pages of an open database", async () => {
      const record = await newHealthRecord("Page record");
      const recordSubpage = await subpageOf(record.id);
      const openDatabase = await newUserDatabase("Open page host");
      const openItem = await inTenant(() =>
        cp.createItem({ databaseId: openDatabase.id, properties: { name: "Host" } }),
      );
      const openSubpage = await subpageOf(openItem.id);

      for (const access of ["read", "write"] as const) {
        for (const itemId of [record.id, recordSubpage]) {
          await expect(pageAccess(EXTERNAL, itemId, access), `${access} ${itemId}`).rejects.toMatchObject(FORBIDDEN);
        }
        for (const itemId of [openItem.id, openSubpage]) {
          await pageAccess(EXTERNAL, itemId, access);
        }
        // A person and the system carry no reader and are not checked.
        await pageAccess(undefined, record.id, access);
      }
    });

    it("decides the page of an item in a database nested under a sensitive record by its own database, as every item read does", async () => {
      const record = await newHealthRecord("Page nesting record");
      const nested = await inTenant(() => cp.createDatabase({ name: "Under a record", parentItemId: record.id }));
      await inTenant(() => cp.createProperty({ databaseId: nested.id, key: "name", name: "Name", type: "title" }));
      const child = await inTenant(() => cp.createItem({ databaseId: nested.id, properties: { name: "Child" } }));
      await pageAccess(EXTERNAL, child.id, "read");
      await pageAccess(EXTERNAL, child.id, "write");
    });

    it("answers not found for the page of an unknown item", async () => {
      await expect(pageAccess(EXTERNAL, randomUUID(), "read")).rejects.toMatchObject({ status: 404 });
    });

    it("refuses replacePageMarkdown of a writer with the marker on a sensitive record and writes nothing, and replaces an open page", async () => {
      const docStore = createDocStore(dataPool);
      const record = await newHealthRecord("Replace record");
      await inTenant(() =>
        docStore.insertPageMarkdown(record.id, { placement: "end", markdown: "Original text", origin: "user" }),
      );
      const before = await inTenant(() => docStore.readPageMarkdown(record.id));
      const replace = (itemId: string, expectedEtag: string) =>
        inTenant(() =>
          docStore.replacePageMarkdown(itemId, {
            markdown: "Replaced text",
            expectedEtag,
            origin: "ai_agent",
            writer: externalWriter(),
            actingUserId: randomUUID(),
          }),
        );

      await expect(replace(record.id, before.etag)).rejects.toMatchObject(FORBIDDEN);
      expect(await inTenant(() => docStore.readPageMarkdown(record.id))).toEqual(before);

      const openDatabase = await newUserDatabase("Replace open");
      const openItem = await inTenant(() =>
        cp.createItem({ databaseId: openDatabase.id, properties: { name: "Open" } }),
      );
      await inTenant(() =>
        docStore.insertPageMarkdown(openItem.id, { placement: "end", markdown: "Open original", origin: "user" }),
      );
      const openBefore = await inTenant(() => docStore.readPageMarkdown(openItem.id));
      await replace(openItem.id, openBefore.etag);
      expect((await inTenant(() => docStore.readPageMarkdown(openItem.id))).markdown).toContain("Replaced text");
    });

    it("refuses restoreVersion of a sensitive record's page for the reader, before it looks at the page's history", async () => {
      const docStore = createDocStore(dataPool);
      const record = await newHealthRecord("Restore record");
      await inTenant(() => docStore.ensurePage(record.id));
      await expect(
        inTenant(() => docStore.restoreVersion(record.id, new Date(Date.now() - 3_600_000), EXTERNAL)),
      ).rejects.toMatchObject(FORBIDDEN);
    });
  });

  describe("reads", () => {
    it("refuses an item read by id and by database and an item list of a sensitive database, while a person reads them", async () => {
      const record = await newHealthRecord();
      await expect(inTenant(() => cp.findItem(record.id, undefined, EXTERNAL))).rejects.toMatchObject(FORBIDDEN);
      await expect(inTenant(() => cp.getItem(health.id, record.id, undefined, EXTERNAL))).rejects.toMatchObject(
        FORBIDDEN,
      );
      await expect(inTenant(() => cp.listItems(health.id, { reader: EXTERNAL }))).rejects.toMatchObject(FORBIDDEN);
      expect((await inTenant(() => cp.findItem(record.id)))?.id).toBe(record.id);
      expect((await inTenant(() => cp.getItem(health.id, record.id)))?.id).toBe(record.id);
      expect((await inTenant(() => cp.listItems(health.id))).items.map((item) => item.id)).toContain(record.id);
    });

    it("keeps a missing item not found for an external client", async () => {
      expect(await inTenant(() => cp.findItem(randomUUID(), undefined, EXTERNAL))).toBeNull();
    });

    it("reads an item of an open database by id, by database and in a list", async () => {
      const open = await newUserDatabase();
      const note = await inTenant(() => cp.createItem({ databaseId: open.id, properties: { name: "Open note" } }));
      expect((await inTenant(() => cp.findItem(note.id, undefined, EXTERNAL)))?.id).toBe(note.id);
      expect((await inTenant(() => cp.getItem(open.id, note.id, undefined, EXTERNAL)))?.id).toBe(note.id);
      expect(
        (await inTenant(() => cp.listItems(open.id, { reader: EXTERNAL }))).items.map((item) => item.id),
      ).toContain(note.id);
    });

    it("refuses database.query and a view query over a sensitive database and answers for an open one", async () => {
      const record = await newHealthRecord();
      const view = await inTenant(() => cp.createView({ databaseId: health.id, type: "table", name: "All records" }));
      await expect(inTenant(() => cp.queryDatabaseItems(health.id, {}, undefined, EXTERNAL))).rejects.toMatchObject(
        FORBIDDEN,
      );
      await expect(inTenant(() => cp.queryViewItems(view.id, {}, undefined, EXTERNAL))).rejects.toMatchObject(
        FORBIDDEN,
      );
      expect((await inTenant(() => cp.queryViewItems(view.id, {}))).items.map((item) => item.id)).toContain(record.id);

      const open = await newUserDatabase();
      const note = await inTenant(() => cp.createItem({ databaseId: open.id, properties: { name: "Open note" } }));
      const openView = await inTenant(() => cp.createView({ databaseId: open.id, type: "table", name: "All notes" }));
      expect(
        (await inTenant(() => cp.queryDatabaseItems(open.id, {}, undefined, EXTERNAL))).items.map((item) => item.id),
      ).toContain(note.id);
      expect(
        (await inTenant(() => cp.queryViewItems(openView.id, {}, undefined, EXTERNAL))).items.map((item) => item.id),
      ).toContain(note.id);
    });

    it("counts, pages and ends a curated view over the members of open databases only", async () => {
      const open = await newUserDatabase();
      const curated = await inTenant(() =>
        cp.createView({ type: "list", name: "Mixed", config: { membership: "manual" } }),
      );
      // Position order: sensitive, open, sensitive, open, so a page of one cannot end on the sensitive members' count.
      const members: ItemRow[] = [];
      for (const [index, databaseId] of [health.id, open.id, health.id, open.id].entries()) {
        const member = await inTenant(() => cp.createItem({ databaseId, properties: { name: `Member ${index}` } }));
        await inTenant(() => cp.addViewItem({ viewId: curated.id, itemId: member.id, actor: { type: "user" } }));
        members.push(member);
      }
      const readable = [members[1], members[3]].map((member) => member?.id);

      const first = await inTenant(() =>
        cp.queryViewItems(curated.id, { limit: 1, includeCount: true }, undefined, EXTERNAL),
      );
      expect(first.items.map((item) => item.id)).toEqual([readable[0]]);
      expect(first.totalCount).toBe(2);
      const second = await inTenant(() =>
        cp.queryViewItems(
          curated.id,
          { limit: 1, cursor: first.nextCursor ?? undefined, includeCount: true },
          undefined,
          EXTERNAL,
        ),
      );
      expect(second.items.map((item) => item.id)).toEqual([readable[1]]);
      expect(second.nextCursor).toBeNull();

      const forPerson = await inTenant(() => cp.queryViewItems(curated.id, { includeCount: true }));
      expect(forPerson.totalCount).toBe(4);
    });

    it("refuses database.get of a sensitive database and lists the open ones", async () => {
      const open = await newUserDatabase();
      await expect(inTenant(() => cp.getDatabase(health.id, EXTERNAL))).rejects.toMatchObject(FORBIDDEN);
      expect((await inTenant(() => cp.getDatabase(health.id)))?.id).toBe(health.id);
      expect((await inTenant(() => cp.getDatabase(open.id, EXTERNAL)))?.id).toBe(open.id);

      const listed = (await inTenant(() => cp.listDatabases(EXTERNAL))).map((database) => database.id);
      expect(listed).toContain(open.id);
      expect(listed).toContain(tasks.id);
      expect(listed).not.toContain(health.id);
      const forPerson = (await inTenant(() => cp.listDatabases())).map((database) => database.id);
      expect(forPerson).toContain(health.id);
    });

    it("omits the sensitive databases from the schema projection of an external client, and decides by the project when one is given", async () => {
      const open = await newUserDatabase();
      const projected = async (options: Parameters<typeof generateSchemaProjection>[2]) =>
        (
          await inTransaction((client) =>
            generateSchemaProjection(client, new ModuleRegistry(() => new Set()), options),
          )
        ).databases.map((database) => database.databaseId);

      const forExternal = await projected({ externalClient: true });
      expect(forExternal).toContain(open.id);
      expect(forExternal).toContain(tasks.id);
      for (const key of SENSITIVE_DATABASE_KEYS) {
        expect(forExternal).not.toContain((await systemDatabase(key)).id);
      }
      expect(await projected({})).toContain(health.id);

      const project = await inTenant(() => createTestProjectItem(dataPool));
      await inTransaction((client) =>
        setAgentDatabaseGrant(client, { projectItemId: project, databaseId: health.id, access: "read" }),
      );
      expect(await projected({ externalClient: true, agentProjectItemId: project })).toContain(health.id);
    });

    it("hides a relation target in a sensitive database as an id, in an expansion and in the relation list", async () => {
      const source = await newUserDatabase("Source");
      const { property } = await inTenant(() =>
        cp.createRelationProperty({
          sourceDatabaseId: source.id,
          key: "records",
          name: "Records",
          targetDatabaseId: health.id,
        }),
      );
      const sourceItem = await inTenant(() => cp.createItem({ databaseId: source.id, properties: { name: "S" } }));
      const record = await newHealthRecord("Hidden title");
      await inTenant(() =>
        cp.createRelation({ relationPropertyId: property.id, callerItemId: sourceItem.id, targetItemId: record.id }),
      );
      const resolver = {
        resolve: () => ({
          icon: null,
          color: null,
          overviewOrder: null,
          switcherOrder: null,
          clientVisible: true,
          overviewHidden: false,
        }),
        collectionFilter: () => undefined,
        overviewHideable: () => false,
      };
      const expansion = { relations: { records: [] }, resolver };

      const expanded = await inTenant(() => cp.findItem(sourceItem.id, expansion, EXTERNAL));
      expect(JSON.stringify(expanded)).toContain(JSON.stringify({ id: record.id, hidden: true }));
      expect(JSON.stringify(expanded)).not.toContain("Hidden title");
      const asPerson = await inTenant(() => cp.findItem(sourceItem.id, expansion));
      expect(JSON.stringify(asPerson)).toContain("Hidden title");

      expect(await inTenant(() => cp.listItemRelations(sourceItem.id, undefined, EXTERNAL))).toEqual([
        { relationPropertyId: property.id, propertyKey: "records", targetItemId: record.id, hidden: true },
      ]);
      await expect(inTenant(() => cp.listItemRelations(record.id, undefined, EXTERNAL))).rejects.toMatchObject(
        FORBIDDEN,
      );
    });
  });

  describe("writes", () => {
    it("refuses an item create in a sensitive database, also the replay of an idempotent one, and writes nothing", async () => {
      const key = randomUUID();
      await inTenant(() => cp.createItem({ databaseId: health.id, properties: { name: "Once" }, idempotencyKey: key }));
      const before = (await inTenant(() => cp.listItems(health.id))).items.length;
      const create = (idempotencyKey?: string) =>
        inTenant(() =>
          cp.createItem(
            { databaseId: health.id, properties: { name: "Once" }, idempotencyKey },
            undefined,
            undefined,
            externalWriter(),
          ),
        );
      await expect(create()).rejects.toMatchObject(FORBIDDEN);
      await expect(create(key)).rejects.toMatchObject(FORBIDDEN);
      expect((await inTenant(() => cp.listItems(health.id))).items).toHaveLength(before);
    });

    it("refuses a patch, a delete and a restore of an item in a sensitive database and leaves it unchanged", async () => {
      const record = await newHealthRecord("Before");
      const trashed = await newHealthRecord("Trashed");
      await inTenant(() => cp.softDeleteItem(health.id, trashed.id));
      await expect(
        inTenant(() =>
          cp.updateItem(
            { databaseId: health.id, itemId: record.id, propertiesPatch: { name: "After" } },
            undefined,
            undefined,
            externalWriter(),
          ),
        ),
      ).rejects.toMatchObject(FORBIDDEN);
      await expect(
        inTenant(() => cp.softDeleteItem(health.id, record.id, undefined, externalWriter())),
      ).rejects.toMatchObject(FORBIDDEN);
      await expect(
        inTenant(() => cp.restoreItem(health.id, trashed.id, undefined, externalWriter())),
      ).rejects.toMatchObject(FORBIDDEN);
      const unchanged = await inTenant(() => cp.findItem(record.id));
      expect(unchanged?.properties.name).toBe("Before");
      expect(unchanged?.deletedAt).toBeNull();
      expect((await inTenant(() => cp.findItemIncludingDeleted(trashed.id)))?.deletedAt).not.toBeNull();
    });

    it("lets the external client write, delete and restore in an open database, a cascade into its nested databases included", async () => {
      const parentDatabase = await newUserDatabase("Parents");
      const writer = externalWriter();
      const parent = await inTenant(() =>
        cp.createItem({ databaseId: parentDatabase.id, properties: { name: "P" } }, undefined, undefined, writer),
      );
      const nested = await inTenant(() => cp.createDatabase({ name: "Nested", parentItemId: parent.id }));
      await inTenant(() => cp.createProperty({ databaseId: nested.id, key: "name", name: "Name", type: "title" }));
      const child = await inTenant(() => cp.createItem({ databaseId: nested.id, properties: { name: "C" } }));

      await inTenant(() =>
        cp.updateItem(
          { databaseId: parentDatabase.id, itemId: parent.id, propertiesPatch: { name: "P2" } },
          undefined,
          undefined,
          writer,
        ),
      );
      expect(
        (await inTenant(() => cp.softDeleteItem(parentDatabase.id, parent.id, undefined, writer)))?.deletedAt,
      ).not.toBeNull();
      expect((await inTenant(() => cp.findItemIncludingDeleted(child.id)))?.deletedAt).not.toBeNull();
      expect(
        (await inTenant(() => cp.restoreItem(parentDatabase.id, parent.id, undefined, writer)))?.deletedAt,
      ).toBeNull();
    });

    it("refuses a relation edge to or from a sensitive database through every edge entry point that takes a writer", async () => {
      const open = await newUserDatabase("Linked");
      const { property } = await inTenant(() =>
        cp.createRelationProperty({
          sourceDatabaseId: open.id,
          key: "record",
          name: "Record",
          targetDatabaseId: health.id,
          cardinality: "one_to_one",
        }),
      );
      const item = await inTenant(() => cp.createItem({ databaseId: open.id, properties: { name: "Linked item" } }));
      const record = await newHealthRecord();
      const edge = { relationPropertyId: property.id, callerItemId: item.id, targetItemId: record.id };

      await expect(inTenant(() => cp.createRelation(edge, externalWriter()))).rejects.toMatchObject(FORBIDDEN);
      await expect(
        inTransaction(async (client) => {
          await createRelationIfAbsentWithClient(client, edge, undefined, externalWriter());
        }),
      ).rejects.toMatchObject(FORBIDDEN);
      expect(await inTenant(() => cp.listItemRelations(item.id))).toEqual([]);

      await inTenant(() => cp.createRelation(edge));
      await expect(
        inTenant(() => cp.updateRelation({ ...edge, metadata: { note: "n" } }, externalWriter())),
      ).rejects.toMatchObject(FORBIDDEN);
      await expect(inTenant(() => cp.deleteRelation(edge, externalWriter()))).rejects.toMatchObject(FORBIDDEN);
      await expect(
        inTenant(() => cp.setRelation({ ...edge, targetItemId: null }, externalWriter())),
      ).rejects.toMatchObject(FORBIDDEN);
      expect(await inTenant(() => cp.listItemRelations(item.id))).toHaveLength(1);
    });

    it("refuses a relation edge whose relation property belongs to a sensitive database although its target is open", async () => {
      // `healthRecords.tasks` is a user-owned relation from the sensitive Health records database to Tasks: the
      // property's database is the sensitive source endpoint and the target database is open.
      const [property] = await inTenant(() => cp.findPropertiesByKey(health.id, "tasks", "relation"));
      if (!property) throw new Error("The Health records -> Tasks relation property is missing");
      const record = await newHealthRecord("Follow-up needed");
      const task = await inTenant(() => cp.createItem({ databaseId: tasks.id, properties: { name: "Follow up" } }));
      const edge = { relationPropertyId: property.id, callerItemId: record.id, targetItemId: task.id };

      await expect(inTenant(() => cp.createRelation(edge, externalWriter()))).rejects.toMatchObject(FORBIDDEN);
      await expect(
        inTransaction(async (client) => {
          await createRelationIfAbsentWithClient(client, edge, undefined, externalWriter());
        }),
      ).rejects.toMatchObject(FORBIDDEN);
      expect(await inTenant(() => cp.listItemRelations(record.id))).toEqual([]);

      await inTenant(() => cp.createRelation(edge));
      await expect(
        inTenant(() => cp.updateRelation({ ...edge, metadata: { note: "n" } }, externalWriter())),
      ).rejects.toMatchObject(FORBIDDEN);
      await expect(inTenant(() => cp.deleteRelation(edge, externalWriter()))).rejects.toMatchObject(FORBIDDEN);
      await expect(
        inTenant(() => cp.setRelation({ ...edge, targetItemId: null }, externalWriter())),
      ).rejects.toMatchObject(FORBIDDEN);
      expect(await inTenant(() => cp.listItemRelations(record.id))).toHaveLength(1);
    });

    it("lets the external client update, set and delete a relation edge between open databases", async () => {
      const [first, second] = [await newUserDatabase("Edge source"), await newUserDatabase("Edge target")];
      const { property } = await inTenant(() =>
        cp.createRelationProperty({
          sourceDatabaseId: first.id,
          key: "other",
          name: "Other",
          targetDatabaseId: second.id,
          cardinality: "one_to_one",
        }),
      );
      const from = await inTenant(() => cp.createItem({ databaseId: first.id, properties: { name: "From" } }));
      const one = await inTenant(() => cp.createItem({ databaseId: second.id, properties: { name: "One" } }));
      const two = await inTenant(() => cp.createItem({ databaseId: second.id, properties: { name: "Two" } }));
      const writer = externalWriter();
      const edge = { relationPropertyId: property.id, callerItemId: from.id, targetItemId: one.id };

      await inTenant(() => cp.createRelation(edge, writer));
      await inTenant(() => cp.updateRelation({ ...edge, metadata: { note: "n" } }, writer));
      await inTenant(() => cp.setRelation({ ...edge, targetItemId: two.id }, writer));
      const targets = (await inTenant(() => cp.listItemRelations(from.id))) ?? [];
      expect(targets.map((entry) => entry.targetItemId)).toEqual([two.id]);
      await inTenant(() => cp.deleteRelation({ ...edge, targetItemId: two.id }, writer));
      expect(await inTenant(() => cp.listItemRelations(from.id))).toEqual([]);
    });
  });
});
