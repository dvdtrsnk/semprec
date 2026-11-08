import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../testSupport/testDb.js";
import { withTransaction } from "../db/pool.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { getValueLinksForItems } from "../chokePoint/valueLinkReads.js";
import { insertValueLink } from "../chokePoint/valueLinksStore.js";
import type { DatabaseRow, ItemRow } from "../types.js";

/** Issue #1403: the batched read behind `include=links`. */
let pool: Pool;
let chokePoint: ChokePoint;

/** A database with a `title` property; `moduleId` makes it a system database whose `owner_module_id` is the source's `databaseKey`. */
async function makeDatabase(name: string, moduleId?: string, cp: ChokePoint = chokePoint): Promise<DatabaseRow> {
  const database = await cp.createDatabase({ name, ownerModuleId: moduleId, system: moduleId !== undefined });
  await cp.createProperty({ databaseId: database.id, key: "title", name: "Title", type: "title" });
  return database;
}

async function makeItem(database: DatabaseRow, title: string, cp: ChokePoint = chokePoint): Promise<ItemRow> {
  return cp.createItem({ databaseId: database.id, properties: { title } });
}

describe("getValueLinksForItems (issue #1403)", () => {
  beforeAll(() => {
    pool = getTestPool();
    chokePoint = createChokePoint(pool);
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("returns the entry with the source title, databaseKey and propertyKey", async () => {
    const tasks = await makeDatabase("Tasks", "linksTasks");
    const files = await makeDatabase("Files");
    const task = await makeItem(tasks, "Send the invoice");
    const file = await makeItem(files, "invoice.pdf");
    await withTransaction(pool, (client) =>
      insertValueLink(client, {
        itemId: file.id,
        propertyKey: "projects",
        ruleKey: "fileProject",
        sources: [{ kind: "item", sourceItemId: task.id, sourcePropertyKey: "project" }],
      }),
    );

    const links = await chokePoint.getValueLinksForItems([file.id]);

    expect(links.get(file.id)).toEqual({
      projects: {
        valueKind: "inherited",
        sources: [
          {
            kind: "item",
            itemId: task.id,
            databaseKey: "linksTasks",
            title: "Send the invoice",
            propertyKey: "project",
          },
        ],
        brokenBy: null,
        brokenAt: null,
      },
    });
  });

  it("returns every source of a link with two sources", async () => {
    const projects = await makeDatabase("Projects", "linksProjects");
    const files = await makeDatabase("Files");
    const alpha = await makeItem(projects, "Alpha");
    const beta = await makeItem(projects, "Beta");
    const file = await makeItem(files, "brief.pdf");
    await withTransaction(pool, (client) =>
      insertValueLink(client, {
        itemId: file.id,
        propertyKey: "company",
        ruleKey: "fileCompany",
        sources: [
          { kind: "item", sourceItemId: alpha.id, sourcePropertyKey: "company" },
          { kind: "item", sourceItemId: beta.id, sourcePropertyKey: "company" },
        ],
      }),
    );

    const entry = (await chokePoint.getValueLinksForItems([file.id])).get(file.id)?.company;

    expect(entry?.sources.map((source) => (source.kind === "item" ? source.title : source.domain)).sort()).toEqual([
      "Alpha",
      "Beta",
    ]);
  });

  it("reads a broken row as inheritedBroken with brokenBy and brokenAt", async () => {
    const tasks = await makeDatabase("Tasks", "linksTasks");
    const files = await makeDatabase("Files");
    const task = await makeItem(tasks, "Send the invoice");
    const file = await makeItem(files, "invoice.pdf");
    const brokenAt = new Date("2026-10-20T10:00:00.000Z");
    await withTransaction(pool, (client) =>
      insertValueLink(client, {
        itemId: file.id,
        propertyKey: "projects",
        ruleKey: "fileProject",
        state: "broken",
        brokenBy: "agent",
        brokenAt,
        sources: [{ kind: "item", sourceItemId: task.id, sourcePropertyKey: "project" }],
      }),
    );

    const entry = (await chokePoint.getValueLinksForItems([file.id])).get(file.id)?.projects;

    expect(entry).toMatchObject({ valueKind: "inheritedBroken", brokenBy: "agent", brokenAt: brokenAt.toISOString() });
    expect(entry?.sources).toHaveLength(1);
  });

  it("has no entry for an item without a link row", async () => {
    const files = await makeDatabase("Files");
    const file = await makeItem(files, "plain.pdf");

    const links = await chokePoint.getValueLinksForItems([file.id]);

    expect(links.has(file.id)).toBe(false);
  });

  it("returns a senderDomain source as stored", async () => {
    const files = await makeDatabase("Files");
    const file = await makeItem(files, "mail.eml");
    await withTransaction(pool, (client) =>
      insertValueLink(client, {
        itemId: file.id,
        propertyKey: "company",
        ruleKey: "senderCompany",
        sources: [{ kind: "senderDomain", domain: "example.com", sourcePropertyKey: "domains" }],
      }),
    );

    const entry = (await chokePoint.getValueLinksForItems([file.id])).get(file.id)?.company;

    expect(entry?.sources).toEqual([{ kind: "senderDomain", domain: "example.com", propertyKey: "domains" }]);
  });

  it("leaves a trashed or missing source out of sources but still returns the entry", async () => {
    const tasks = await makeDatabase("Tasks", "linksTasks");
    const files = await makeDatabase("Files");
    const live = await makeItem(tasks, "Live task");
    const trashed = await makeItem(tasks, "Trashed task");
    const file = await makeItem(files, "invoice.pdf");
    await withTransaction(pool, (client) =>
      insertValueLink(client, {
        itemId: file.id,
        propertyKey: "projects",
        ruleKey: "fileProject",
        sources: [
          { kind: "item", sourceItemId: live.id, sourcePropertyKey: "project" },
          { kind: "item", sourceItemId: trashed.id, sourcePropertyKey: "project" },
          { kind: "item", sourceItemId: randomUUID(), sourcePropertyKey: "project" },
        ],
      }),
    );
    await chokePoint.softDeleteItem(tasks.id, trashed.id);

    const entry = (await chokePoint.getValueLinksForItems([file.id])).get(file.id)?.projects;

    expect(entry?.valueKind).toBe("inherited");
    expect(entry?.sources.map((source) => (source.kind === "item" ? source.itemId : null))).toEqual([live.id]);
  });

  it("runs a constant number of queries whatever the number of items and sources", async () => {
    const tasks = await makeDatabase("Tasks", "linksTasks");
    const files = await makeDatabase("Files");
    async function seed(count: number): Promise<string[]> {
      const ids: string[] = [];
      for (let i = 0; i < count; i += 1) {
        const task = await makeItem(tasks, `Task ${i}`);
        const file = await makeItem(files, `File ${i}`);
        await withTransaction(pool, (client) =>
          insertValueLink(client, {
            itemId: file.id,
            propertyKey: "projects",
            ruleKey: "fileProject",
            sources: [{ kind: "item", sourceItemId: task.id, sourcePropertyKey: "project" }],
          }),
        );
        ids.push(file.id);
      }
      return ids;
    }

    async function countQueries(itemIds: string[]): Promise<number> {
      return withTransaction(pool, async (client) => {
        const spy = vi.spyOn(client, "query");
        try {
          const links = await getValueLinksForItems(client, itemIds);
          expect(links.size).toBe(itemIds.length);
          return spy.mock.calls.length;
        } finally {
          spy.mockRestore();
        }
      });
    }

    const small = await countQueries(await seed(1));
    const large = await countQueries([...(await seed(5)), ...(await seed(5))]);

    expect(small).toBeGreaterThan(0);
    expect(large).toBe(small);
  });
});

describe("getValueLinksForItems tenant isolation (issue #1403)", () => {
  let adminPool: Pool;
  let runtimePool: Pool;

  beforeAll(async () => {
    adminPool = getTestPool();
    runtimePool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  afterAll(async () => {
    await runtimePool.end();
    await adminPool.end();
  });

  it("never returns another tenant's links, nor resolves a source item that belongs to another tenant", async () => {
    await resetDatabase(adminPool);
    const tenantA = await createTestTenant(adminPool);
    const tenantB = await createTestTenant(adminPool);
    const choke = createChokePoint(runtimePool);

    const aDatabase = await runInTenant(tenantA, () => makeDatabase("A tasks", "linksTasks", choke));
    const aTask = await runInTenant(tenantA, () => makeItem(aDatabase, "A secret task", choke));
    const bDatabase = await runInTenant(tenantB, () => makeDatabase("B files", undefined, choke));
    const bFile = await runInTenant(tenantB, () => makeItem(bDatabase, "B file", choke));
    const aFile = await runInTenant(tenantA, () => makeItem(aDatabase, "A file", choke));

    // Tenant A has a link on its own item; tenant B has a link whose source id belongs to tenant A.
    await withTenantTransaction(runtimePool, tenantA, (client) =>
      insertValueLink(client, {
        itemId: aFile.id,
        propertyKey: "projects",
        ruleKey: "fileProject",
        sources: [{ kind: "item", sourceItemId: aTask.id, sourcePropertyKey: "project" }],
      }),
    );
    await withTenantTransaction(runtimePool, tenantB, (client) =>
      insertValueLink(client, {
        itemId: bFile.id,
        propertyKey: "projects",
        ruleKey: "fileProject",
        sources: [{ kind: "item", sourceItemId: aTask.id, sourcePropertyKey: "project" }],
      }),
    );

    const seenByB = await runInTenant(tenantB, () => choke.getValueLinksForItems([aFile.id, bFile.id]));
    expect([...seenByB.keys()]).toEqual([bFile.id]);
    expect(seenByB.get(bFile.id)?.projects).toEqual({
      valueKind: "inherited",
      sources: [],
      brokenBy: null,
      brokenAt: null,
    });

    const seenByA = await runInTenant(tenantA, () => choke.getValueLinksForItems([aFile.id, bFile.id]));
    expect([...seenByA.keys()]).toEqual([aFile.id]);
    expect(seenByA.get(aFile.id)?.projects?.sources).toEqual([
      { kind: "item", itemId: aTask.id, databaseKey: "linksTasks", title: "A secret task", propertyKey: "project" },
    ]);
  });
});
