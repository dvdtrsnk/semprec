import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createTenantZeroUser, getTestPool, inTenantZero, resetDatabase } from "@semprec/data/testSupport";
import {
  createChokePoint,
  createViewTypeRegistry,
  getDatabaseByModuleId,
  seedSystem,
  withTransaction,
  type ChokePoint,
  type CollectionMetadataResolver,
  type DatabaseRow,
} from "@semprec/data";
import { CAPABILITY_IDS, type AuthenticatedActor } from "@semprec/shared";
import { createGenericOperationGateway } from "../genericOperationGateway.js";

// The operations of the generic catalog that are keyed by the id of a property, a view, an item's page or by a database
// without reading its items (issue #1998): an external client on `/mcp` is refused the sensitive databases there as
// well, while REST and every open database keep working.

const metadataResolver: CollectionMetadataResolver = {
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

const ALL_CAPABILITIES = new Set(CAPABILITY_IDS);
const FORBIDDEN = { status: 403, code: "forbidden" };
const SEEDING_TEST_TIMEOUT_MS = 120_000;
const SECRET_PAGE_TEXT = "Private page text xyz";

let pool: Pool;
let chokePoint: ChokePoint;
let health: DatabaseRow;
let sleepNights: DatabaseRow;
let tasks: DatabaseRow;
let userId: string;

const gateway = () => createGenericOperationGateway(pool, metadataResolver);

/** `/mcp` on the user's own token: no run credential, so no project, and the external-client marker. */
const external = (): AuthenticatedActor => ({ userId, externalClient: true });
/** The same user over REST. */
const rest = (): AuthenticatedActor => ({ userId, restSession: true });

const newRecord = (name = "Object record") => chokePoint.createItem({ databaseId: health.id, properties: { name } });

async function newUserDatabase(name: string): Promise<DatabaseRow> {
  const database = await chokePoint.createDatabase({ name });
  await chokePoint.createProperty({ databaseId: database.id, key: "name", name: "Name", type: "title" });
  return database;
}

/**
 * The call is refused by the external-client check: a 403 `forbidden` whose message names the external client. A
 * refusal of another guard (a system database that cannot be archived, a locked schema) would not pass by accident.
 */
async function expectRefusedToExternalClient(label: string, call: () => Promise<unknown>): Promise<void> {
  let error: unknown;
  try {
    await call();
  } catch (caught) {
    error = caught;
  }
  expect(error, `${label} is refused`).toMatchObject(FORBIDDEN);
  expect(String(error), label).toContain("An external client has no");
}

/** The Markdown of a page as `actor` reads it. */
async function markdownOf(actor: AuthenticatedActor, itemId: string): Promise<string> {
  const page = await gateway().invoke("page.get", actor, ALL_CAPABILITIES, { itemId, format: "markdown" });
  if (!("markdown" in page)) throw new Error("Expected the Markdown of the page");
  return page.markdown;
}

const anHourAgo = () => new Date(Date.now() - 3_600_000).toISOString();

describe("an external client on /mcp: counts, facets, schema, views and pages (issue #1998)", () => {
  beforeAll(async () => {
    pool = getTestPool();
    chokePoint = createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    userId = (await createTenantZeroUser(pool)).id;
    const databases = await inTenantZero(async () => ({
      health: await withTransaction(pool, (client) => getDatabaseByModuleId(client, "healthRecords")),
      sleepNights: await withTransaction(pool, (client) => getDatabaseByModuleId(client, "sleepNights")),
      tasks: await withTransaction(pool, (client) => getDatabaseByModuleId(client, "tasks")),
    }));
    if (!databases.health || !databases.sleepNights || !databases.tasks) {
      throw new Error("System databases are missing");
    }
    health = databases.health;
    sleepNights = databases.sleepNights;
    tasks = databases.tasks;
  }, SEEDING_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await pool?.end();
  });

  it("refuses item.count and database.facets of a sensitive database, also inside a batch with an open one, and computes both for an open database", async () => {
    await inTenantZero(async () => {
      const board = await newUserDatabase("Counted board");
      await chokePoint.createProperty({
        databaseId: board.id,
        key: "stage",
        name: "Stage",
        type: "select",
        config: { options: [{ key: "todo" }, { key: "done" }] },
      });
      await chokePoint.createItem({ databaseId: board.id, properties: { name: "Card", stage: "todo" } });
      await newRecord("Counted record");

      for (const database of [health, sleepNights]) {
        await expectRefusedToExternalClient(`item.count ${database.key}`, () =>
          gateway().invoke("item.count", external(), ALL_CAPABILITIES, { items: [{ databaseId: database.id }] }),
        );
        await expectRefusedToExternalClient(`database.facets ${database.key}`, () =>
          gateway().invoke("database.facets", external(), ALL_CAPABILITIES, {
            databaseId: database.id,
            facets: ["type"],
          }),
        );
      }
      await expectRefusedToExternalClient("item.count with a grouping", () =>
        gateway().invoke("item.count", external(), ALL_CAPABILITIES, {
          items: [{ databaseId: health.id, groupBy: "type" }],
        }),
      );
      await expectRefusedToExternalClient("item.count in a batch with an open database", () =>
        gateway().invoke("item.count", external(), ALL_CAPABILITIES, {
          items: [{ databaseId: board.id }, { databaseId: health.id }],
        }),
      );

      // The same user over REST, and the open database for the external client, are computed.
      const restCount = await gateway().invoke("item.count", rest(), ALL_CAPABILITIES, {
        items: [{ databaseId: health.id }],
      });
      expect(restCount[0]?.databaseId).toBe(health.id);
      expect(
        await gateway().invoke("database.facets", rest(), ALL_CAPABILITIES, {
          databaseId: health.id,
          facets: ["type"],
        }),
      ).toBeDefined();
      const counted = await gateway().invoke("item.count", external(), ALL_CAPABILITIES, {
        items: [{ databaseId: board.id }, { databaseId: tasks.id }],
      });
      expect(counted.map((entry) => entry.databaseId)).toEqual([board.id, tasks.id]);
      const grouped = await gateway().invoke("item.count", external(), ALL_CAPABILITIES, {
        items: [{ databaseId: board.id, groupBy: "stage" }],
      });
      expect(JSON.stringify(grouped)).toContain("todo");
      const facets = await gateway().invoke("database.facets", external(), ALL_CAPABILITIES, {
        databaseId: board.id,
        facets: ["stage"],
      });
      expect(facets[0]?.values.map((value) => value.value)).toContain("todo");
    });
  });

  it("refuses property.list, get and getByKey of a sensitive database and reads those of an open one", async () => {
    await inTenantZero(async () => {
      const open = await newUserDatabase("Open properties");
      const [healthProperty] = await chokePoint.listProperties(health.id);
      const [openProperty] = await chokePoint.listProperties(open.id);
      if (!healthProperty || !openProperty) throw new Error("A property is missing");

      await expectRefusedToExternalClient("property.list", () =>
        gateway().invoke("property.list", external(), ALL_CAPABILITIES, { databaseId: health.id }),
      );
      await expectRefusedToExternalClient("property.get", () =>
        gateway().invoke("property.get", external(), ALL_CAPABILITIES, { propertyId: healthProperty.id }),
      );
      await expectRefusedToExternalClient("property.getByKey", () =>
        gateway().invoke("property.getByKey", external(), ALL_CAPABILITIES, {
          databaseId: health.id,
          key: healthProperty.key,
        }),
      );
      expect(
        (await gateway().invoke("property.list", rest(), ALL_CAPABILITIES, { databaseId: health.id })).length,
      ).toBeGreaterThan(0);
      expect(
        (await gateway().invoke("property.get", rest(), ALL_CAPABILITIES, { propertyId: healthProperty.id })).id,
      ).toBe(healthProperty.id);

      expect(
        (await gateway().invoke("property.list", external(), ALL_CAPABILITIES, { databaseId: open.id })).length,
      ).toBeGreaterThan(0);
      expect(
        (await gateway().invoke("property.get", external(), ALL_CAPABILITIES, { propertyId: openProperty.id })).id,
      ).toBe(openProperty.id);
      expect(
        (
          await gateway().invoke("property.getByKey", external(), ALL_CAPABILITIES, {
            databaseId: open.id,
            key: openProperty.key,
          })
        )[0]?.id,
      ).toBe(openProperty.id);
    });
  });

  it("refuses property.create, patch and delete in a sensitive database, also through the paired side of a relation, and changes nothing", async () => {
    await inTenantZero(async () => {
      const open = await newUserDatabase("Schema target");
      const healthPropertiesBefore = await chokePoint.listProperties(health.id);
      const openPropertiesBefore = await chokePoint.listProperties(open.id);
      const healthName = healthPropertiesBefore[0]!;
      // `tasks.healthRecords` is a user-owned relation from an open database whose paired side is in Health records.
      const [pairedWithHealth] = await chokePoint.findPropertiesByKey(tasks.id, "healthRecords", "relation");
      if (!pairedWithHealth) throw new Error("The Tasks -> Health records relation property is missing");
      const tasksPropertiesBefore = await chokePoint.listProperties(tasks.id);

      await expectRefusedToExternalClient("property.create", () =>
        gateway().invoke("property.create", external(), ALL_CAPABILITIES, {
          databaseId: health.id,
          key: "addedByClient",
          name: "Added",
          type: "text",
        }),
      );
      await expectRefusedToExternalClient("property.create of a relation into a sensitive database", () =>
        gateway().invoke("property.create", external(), ALL_CAPABILITIES, {
          databaseId: open.id,
          key: "intoHealth",
          name: "Into health",
          type: "relation",
          targetDatabaseId: health.id,
          cardinality: "many_to_many",
          locked: false,
          inverse: { key: "fromOpen", name: "From open", locked: false },
        }),
      );
      await expectRefusedToExternalClient("property.patch", () =>
        gateway().invoke("property.patch", external(), ALL_CAPABILITIES, {
          propertyId: healthName.id,
          patch: { name: "Renamed by a client" },
        }),
      );
      await expectRefusedToExternalClient("property.patch through the paired side", () =>
        gateway().invoke("property.patch", external(), ALL_CAPABILITIES, {
          propertyId: pairedWithHealth.id,
          patch: { name: "Renamed by a client" },
        }),
      );
      await expectRefusedToExternalClient("property.delete", () =>
        gateway().invoke("property.delete", external(), ALL_CAPABILITIES, { propertyId: healthName.id }),
      );
      await expectRefusedToExternalClient("property.delete through the paired side", () =>
        gateway().invoke("property.delete", external(), ALL_CAPABILITIES, { propertyId: pairedWithHealth.id }),
      );

      expect(await chokePoint.listProperties(health.id)).toEqual(healthPropertiesBefore);
      expect(await chokePoint.listProperties(open.id)).toEqual(openPropertiesBefore);
      expect(await chokePoint.listProperties(tasks.id)).toEqual(tasksPropertiesBefore);
    });
  });

  it("lets the external client create, patch and delete properties of an open database", async () => {
    await inTenantZero(async () => {
      const open = await newUserDatabase("Open schema");
      const second = await newUserDatabase("Open schema target");
      const created = await gateway().invoke("property.create", external(), ALL_CAPABILITIES, {
        databaseId: open.id,
        key: "notes",
        name: "Notes",
        type: "text",
      });
      const patched = await gateway().invoke("property.patch", external(), ALL_CAPABILITIES, {
        propertyId: created.id,
        patch: { name: "Remarks" },
      });
      expect(patched.name).toBe("Remarks");
      const relation = await gateway().invoke("property.create", external(), ALL_CAPABILITIES, {
        databaseId: open.id,
        key: "related",
        name: "Related",
        type: "relation",
        targetDatabaseId: second.id,
        cardinality: "many_to_many",
        locked: false,
      });
      expect(relation.type).toBe("relation");
      await gateway().invoke("property.delete", external(), ALL_CAPABILITIES, { propertyId: relation.id });
      await gateway().invoke("property.delete", external(), ALL_CAPABILITIES, { propertyId: created.id });
      expect((await chokePoint.listProperties(open.id)).map((property) => property.key)).toEqual(["name"]);
    });
  });

  it("refuses view.get, create, patch and delete of a sensitive database's view, and the curated-view membership of a sensitive record", async () => {
    await inTenantZero(async () => {
      const open = await newUserDatabase("Open views");
      const healthView = await chokePoint.createView({ databaseId: health.id, type: "table", name: "Health table" });
      const viewsBefore = (await chokePoint.listViewsByDatabase(health.id)).length;
      const curated = await chokePoint.createView({ type: "list", name: "Curated", config: { membership: "manual" } });
      const record = await newRecord("Curated record");
      const openItem = await chokePoint.createItem({ databaseId: open.id, properties: { name: "Open item" } });
      const member = await chokePoint.createItem({ databaseId: health.id, properties: { name: "Existing member" } });
      await chokePoint.addViewItem({ viewId: curated.id, itemId: member.id, actor: { type: "user" } });

      await expectRefusedToExternalClient("view.get", () =>
        gateway().invoke("view.get", external(), ALL_CAPABILITIES, { viewId: healthView.id }),
      );
      await expectRefusedToExternalClient("view.create", () =>
        gateway().invoke("view.create", external(), ALL_CAPABILITIES, {
          databaseId: health.id,
          type: "table",
          name: "Created by a client",
        }),
      );
      await expectRefusedToExternalClient("view.patch", () =>
        gateway().invoke("view.patch", external(), ALL_CAPABILITIES, {
          viewId: healthView.id,
          patch: { name: "Renamed by a client" },
        }),
      );
      await expectRefusedToExternalClient("view.delete", () =>
        gateway().invoke("view.delete", external(), ALL_CAPABILITIES, { viewId: healthView.id }),
      );
      await expectRefusedToExternalClient("viewItem.add", () =>
        gateway().invoke("viewItem.add", external(), ALL_CAPABILITIES, { viewId: curated.id, itemId: record.id }),
      );
      await expectRefusedToExternalClient("viewItem.reorder", () =>
        gateway().invoke("viewItem.reorder", external(), ALL_CAPABILITIES, {
          viewId: curated.id,
          itemId: member.id,
          position: 0,
        }),
      );
      await expectRefusedToExternalClient("viewItem.remove", () =>
        gateway().invoke("viewItem.remove", external(), ALL_CAPABILITIES, { viewId: curated.id, itemId: member.id }),
      );

      expect((await chokePoint.getView(healthView.id))?.name).toBe("Health table");
      expect(await chokePoint.listViewsByDatabase(health.id)).toHaveLength(viewsBefore);
      expect((await chokePoint.listViewItems(curated.id)).map((row) => row.itemId)).toEqual([member.id]);
      expect((await gateway().invoke("view.get", rest(), ALL_CAPABILITIES, { viewId: healthView.id })).id).toBe(
        healthView.id,
      );

      // An open database's views and the membership of its items are the external client's to change.
      const view = await gateway().invoke("view.create", external(), ALL_CAPABILITIES, {
        databaseId: open.id,
        type: "table",
        name: "Open table",
      });
      expect((await gateway().invoke("view.get", external(), ALL_CAPABILITIES, { viewId: view.id })).id).toBe(view.id);
      expect(
        (
          await gateway().invoke("view.patch", external(), ALL_CAPABILITIES, {
            viewId: view.id,
            patch: { name: "Open table 2" },
          })
        ).name,
      ).toBe("Open table 2");
      await gateway().invoke("view.delete", external(), ALL_CAPABILITIES, { viewId: view.id });
      await gateway().invoke("viewItem.add", external(), ALL_CAPABILITIES, { viewId: curated.id, itemId: openItem.id });
      await gateway().invoke("viewItem.reorder", external(), ALL_CAPABILITIES, {
        viewId: curated.id,
        itemId: openItem.id,
        position: 0,
      });
      await gateway().invoke("viewItem.remove", external(), ALL_CAPABILITIES, {
        viewId: curated.id,
        itemId: openItem.id,
      });
    });
  });

  it("refuses database.patch, archive, restore and a database nested under a sensitive record, and keeps an open database's own", async () => {
    await inTenantZero(async () => {
      const record = await newRecord("Nesting record");
      const databasesBefore = (await chokePoint.listDatabases()).length;

      await expectRefusedToExternalClient("database.patch", () =>
        gateway().invoke("database.patch", external(), ALL_CAPABILITIES, {
          databaseId: health.id,
          patch: { name: "Renamed by a client" },
        }),
      );
      await expectRefusedToExternalClient("database.archive", () =>
        gateway().invoke("database.archive", external(), ALL_CAPABILITIES, { databaseId: health.id }),
      );
      await expectRefusedToExternalClient("database.restore", () =>
        gateway().invoke("database.restore", external(), ALL_CAPABILITIES, { databaseId: health.id }),
      );
      await expectRefusedToExternalClient("database.create under a sensitive record", () =>
        gateway().invoke("database.create", external(), ALL_CAPABILITIES, {
          name: "Nested by a client",
          parentItemId: record.id,
        }),
      );
      expect((await chokePoint.getDatabase(health.id))?.name).toBe(health.name);
      expect((await chokePoint.getDatabase(health.id))?.archivedAt).toBeNull();
      expect(await chokePoint.listDatabases()).toHaveLength(databasesBefore);

      const created = await gateway().invoke("database.create", external(), ALL_CAPABILITIES, { name: "By a client" });
      expect(
        (
          await gateway().invoke("database.patch", external(), ALL_CAPABILITIES, {
            databaseId: created.id,
            patch: { name: "By a client 2" },
          })
        ).name,
      ).toBe("By a client 2");
      expect(
        (await gateway().invoke("database.archive", external(), ALL_CAPABILITIES, { databaseId: created.id }))
          .archivedAt,
      ).not.toBeNull();
      expect(
        (await gateway().invoke("database.restore", external(), ALL_CAPABILITIES, { databaseId: created.id }))
          .archivedAt,
      ).toBeNull();
    });
  });

  it("refuses every page operation on a record of a sensitive database and on a subpage of it, and changes no page", async () => {
    await inTenantZero(async () => {
      const record = await newRecord("Record with a page");
      await gateway().invoke("page.ensure", rest(), ALL_CAPABILITIES, { itemId: record.id });
      await gateway().invoke("page.insert", rest(), ALL_CAPABILITIES, {
        itemId: record.id,
        placement: "end",
        markdown: SECRET_PAGE_TEXT,
      });
      const created = await gateway().invoke("page.createSubpage", rest(), ALL_CAPABILITIES, {
        parent: { itemId: record.id },
        title: "Sub of a record",
      });
      const subpage = created.pages[0]!;
      const pageBefore = await markdownOf(rest(), record.id);
      const subpageBefore = await markdownOf(rest(), subpage.pageItemId);
      expect(pageBefore).toContain(SECRET_PAGE_TEXT);

      for (const itemId of [record.id, subpage.pageItemId]) {
        const calls: Record<string, () => Promise<unknown>> = {
          "page.get markdown": () =>
            gateway().invoke("page.get", external(), ALL_CAPABILITIES, { itemId, format: "markdown" }),
          "page.get summary": () => gateway().invoke("page.get", external(), ALL_CAPABILITIES, { itemId }),
          "page.changes": () =>
            gateway().invoke("page.changes", external(), ALL_CAPABILITIES, {
              itemId,
              since: anHourAgo(),
              by: "user",
            }),
          "page.ensure": () => gateway().invoke("page.ensure", external(), ALL_CAPABILITIES, { itemId }),
          "page.insert": () =>
            gateway().invoke("page.insert", external(), ALL_CAPABILITIES, {
              itemId,
              placement: "end",
              markdown: "Written by a client",
            }),
          "page.createSubpage": () =>
            gateway().invoke("page.createSubpage", external(), ALL_CAPABILITIES, {
              parent: { itemId },
              title: "Created by a client",
            }),
          "page.restoreVersion": () =>
            gateway().invoke("page.restoreVersion", external(), ALL_CAPABILITIES, { itemId, at: anHourAgo() }),
        };
        if (itemId === subpage.pageItemId) {
          calls["page.rename"] = () =>
            gateway().invoke("page.rename", external(), ALL_CAPABILITIES, { pageItemId: itemId, title: "Renamed" });
          calls["page.duplicate"] = () =>
            gateway().invoke("page.duplicate", external(), ALL_CAPABILITIES, { pageItemId: itemId });
        }
        for (const [operation, call] of Object.entries(calls)) {
          await expectRefusedToExternalClient(`${operation} of ${itemId}`, call);
        }
      }

      expect(await markdownOf(rest(), record.id)).toBe(pageBefore);
      expect(await markdownOf(rest(), subpage.pageItemId)).toBe(subpageBefore);
      const summary = await gateway().invoke("page.get", rest(), ALL_CAPABILITIES, { itemId: record.id });
      expect(JSON.stringify(summary)).not.toContain("Created by a client");
    });
  });

  it("carries no page text in the refusal of a page operation", async () => {
    await inTenantZero(async () => {
      const record = await newRecord("Record with a secret page");
      await gateway().invoke("page.ensure", rest(), ALL_CAPABILITIES, { itemId: record.id });
      await gateway().invoke("page.insert", rest(), ALL_CAPABILITIES, {
        itemId: record.id,
        placement: "end",
        markdown: SECRET_PAGE_TEXT,
      });
      try {
        await gateway().invoke("page.get", external(), ALL_CAPABILITIES, { itemId: record.id, format: "markdown" });
        throw new Error("Expected the call to be refused");
      } catch (error) {
        expect(error).toMatchObject(FORBIDDEN);
        expect(
          JSON.stringify({ message: String(error), details: Reflect.get(Object(error), "details") }),
        ).not.toContain("Private page text");
      }
    });
  });

  it("names an ancestor of a page in a sensitive database by its id only, and reads a page of an item nested under a sensitive record", async () => {
    await inTenantZero(async () => {
      const record = await newRecord("Record with a nested database");
      const nested = await chokePoint.createInlineDatabase({ name: "Nested notes", parentItemId: record.id });
      await chokePoint.createProperty({ databaseId: nested.id, key: "name", name: "Name", type: "title" });
      const note = await chokePoint.createItem({ databaseId: nested.id, properties: { name: "Open note" } });
      const breadcrumbsOf = async (actor: AuthenticatedActor) => {
        const page = await gateway().invoke("page.get", actor, ALL_CAPABILITIES, { itemId: note.id });
        if (!("breadcrumbs" in page)) throw new Error("Expected the summary format");
        return page.breadcrumbs;
      };
      const trail = (ancestor: object) => [ancestor, { itemId: note.id, title: "Open note", databaseKey: nested.key }];

      // The page of the note is decided by the database that owns it, the one resolver an agent's project is held to;
      // the sensitive record above it is shown to the external client as an id and nothing else.
      expect(await breadcrumbsOf(external())).toEqual(
        trail({ itemId: record.id, title: "", databaseKey: null, hidden: true }),
      );
      expect(await breadcrumbsOf(rest())).toEqual(
        trail({ itemId: record.id, title: "Record with a nested database", databaseKey: health.key }),
      );
    });
  });

  it("lets the external client use the pages of an open database", async () => {
    await inTenantZero(async () => {
      const open = await newUserDatabase("Open pages");
      const item = await chokePoint.createItem({ databaseId: open.id, properties: { name: "Open page item" } });

      await gateway().invoke("page.ensure", external(), ALL_CAPABILITIES, { itemId: item.id });
      const afterTheEnsure = new Date().toISOString();
      await gateway().invoke("page.insert", external(), ALL_CAPABILITIES, {
        itemId: item.id,
        placement: "end",
        markdown: "Open page text",
      });
      expect(await markdownOf(external(), item.id)).toContain("Open page text");
      expect(await gateway().invoke("page.get", external(), ALL_CAPABILITIES, { itemId: item.id })).toBeDefined();
      expect(
        await gateway().invoke("page.changes", external(), ALL_CAPABILITIES, {
          itemId: item.id,
          since: afterTheEnsure,
          by: "ai_agent",
        }),
      ).toBeDefined();
      const subpage = (
        await gateway().invoke("page.createSubpage", external(), ALL_CAPABILITIES, {
          parent: { itemId: item.id },
          title: "Open sub",
        })
      ).pages[0]!;
      await gateway().invoke("page.rename", external(), ALL_CAPABILITIES, {
        pageItemId: subpage.pageItemId,
        title: "Open sub renamed",
      });
      await gateway().invoke("page.duplicate", external(), ALL_CAPABILITIES, { pageItemId: subpage.pageItemId });
    });
  });
});
