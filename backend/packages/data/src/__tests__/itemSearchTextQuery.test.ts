import "../domainWriteHooks.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import type { ItemCountEntryInput } from "../chokePoint/itemReads.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { withTransaction } from "../db/pool.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { createCollectionMetadataResolver, type CollectionMetadataResolver } from "../manifest/collectionMetadata.js";
import { loadFullModuleRegistry } from "../manifest/fullModuleRegistry.js";
import { searchItemGroups } from "../search/searchItemsQuery.js";
import { seedSystem } from "../seed/seedSystem.js";
import { queryDatabaseItems } from "../views/viewQuery.js";
import type { ItemRow } from "../types.js";

// The `q` text match of `database.query`, `view.query` and `item.count` (issue #1857), through the runtime-role pool
// (RLS applies) and the real choke point. The match is the predicate global search uses (`itemSearchMatch.ts`).

let admin: Pool;
let pool: Pool;
let cp: ChokePoint;
let tenantA: string;
let tenantB: string;
let resolver: CollectionMetadataResolver;

const ACTIVE = { type: "equals", property: "status", value: "inProgress" };

async function databaseId(key: string): Promise<string> {
  const db = await withTransaction(pool, (client) => getDatabaseByModuleId(client, key));
  if (!db) throw new Error(`Missing seeded database '${key}'`);
  return db.id;
}

async function make(key: string, properties: Record<string, unknown>): Promise<ItemRow> {
  return cp.createItem({ databaseId: await databaseId(key), properties });
}

/** The Projects fixture of a tenant: names are what the assertions read, ids are what they compare. */
async function seedProjects(): Promise<{
  web: ItemRow;
  redesign: ItemRow;
  archive: ItemRow;
  plan: ItemRow;
}> {
  return {
    web: await make("projects", { name: "Web pro klienta", agents: "Klient Novák", status: "inProgress" }),
    redesign: await make("projects", { name: "Redesign webu", status: "inProgress" }),
    archive: await make("projects", { name: "Novák archiv", status: "done" }),
    plan: await make("projects", { name: "Novák roční plán", status: "longTerm" }),
  };
}

/** How many projects a freshly seeded tenant already holds (system projects); the fixtures add to it. */
async function seededProjectCount(): Promise<number> {
  const page = await cp.queryDatabaseItems(await databaseId("projects"), { includeCount: true });
  if (page.totalCount === undefined) throw new Error("Expected a totalCount");
  return page.totalCount;
}

const idsOf = (items: ItemRow[]): string[] => items.map((item) => item.id);
const sorted = (ids: string[]): string[] => [...ids].sort();

/** A client that records the statements it runs, for a test that has to read the SQL a request produced. */
function recordingClient(client: PoolClient, statements: string[]): PoolClient {
  const query = client.query.bind(client);
  return new Proxy(client, {
    get(target, property) {
      if (property === "query") {
        return (text: string, values?: unknown[]) => {
          statements.push(text);
          return query(text, values);
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** What a refused request says, whole: the message and the details together. */
function errorText(error: ValidationError): string {
  return `${error.message} ${JSON.stringify(error.details)}`;
}

/** The `ValidationError` a request is refused with; any other outcome fails the test. */
async function refusalOf(request: Promise<unknown>): Promise<ValidationError> {
  try {
    await request;
  } catch (error) {
    if (error instanceof ValidationError) return error;
    throw error;
  }
  throw new Error("Expected the request to be refused");
}

describe("q on database.query, view.query and item.count (issue #1857)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
    cp = createChokePoint(pool);
    resolver = await createCollectionMetadataResolver(await loadFullModuleRegistry());
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenantA = await createTestTenant(admin);
    tenantB = await createTestTenant(admin);
    await runInTenant(tenantA, () => seedSystem(pool));
    await runInTenant(tenantB, () => seedSystem(pool));
  });

  afterAll(async () => {
    await pool.end();
    await admin.end();
  });

  describe("database.query", () => {
    it("returns the project the text and the filter both match, and leaves totalCount at the filter-only count", () =>
      runInTenant(tenantA, async () => {
        const projects = await seedProjects();
        const projectsId = await databaseId("projects");

        const page = await cp.queryDatabaseItems(projectsId, { q: "novak", filter: ACTIVE, includeCount: true });
        const filterOnly = await cp.queryDatabaseItems(projectsId, { filter: ACTIVE, includeCount: true });

        expect(page.items.map((item) => item.properties.name)).toEqual(["Web pro klienta"]);
        expect(idsOf(page.items)).toEqual([projects.web.id]);
        expect(filterOnly.totalCount).toBe(2);
        expect(page.totalCount).toBe(2);
        expect(page.totalCount).toBeGreaterThan(page.items.length);
      }));

    it("applies the text without a filter, so the filter above is what removed the other Novák projects", () =>
      runInTenant(tenantA, async () => {
        const seeded = await seededProjectCount();
        const projects = await seedProjects();
        const page = await cp.queryDatabaseItems(await databaseId("projects"), { q: "novak", includeCount: true });
        expect(sorted(idsOf(page.items))).toEqual(sorted([projects.web.id, projects.archive.id, projects.plan.id]));
        expect(page.totalCount).toBe(seeded + 4);
      }));

    it("pages a text match in the requested sort order with the cursor, and its cursor never leaves the match", () =>
      runInTenant(tenantA, async () => {
        const projectsId = await databaseId("projects");
        const seeded = await seededProjectCount();
        const named = new Map<string, string>();
        for (const name of ["Novák E", "Novák B", "Novák D", "Novák A", "Novák C"]) {
          named.set(name, (await make("projects", { name, status: "inProgress" })).id);
        }
        await make("projects", { name: "Beta bez shody", status: "inProgress" });
        await make("projects", { name: "Zeta bez shody", status: "inProgress" });
        const sort = [{ property: "name", direction: "desc" as const }];

        const seen: string[] = [];
        let cursor: string | undefined;
        let pages = 0;
        do {
          const page = await cp.queryDatabaseItems(projectsId, {
            q: "novak",
            sort,
            limit: 2,
            cursor,
            includeCount: true,
          });
          expect(page.totalCount).toBe(seeded + 7);
          seen.push(...page.items.map((item) => String(item.properties.name)));
          cursor = page.nextCursor ?? undefined;
          pages += 1;
        } while (cursor !== undefined && pages < 6);

        expect(pages).toBe(3);
        expect(seen).toEqual(["Novák E", "Novák D", "Novák C", "Novák B", "Novák A"]);
        expect(sorted(seen.map((name) => named.get(name) ?? ""))).toEqual(sorted([...named.values()]));
      }));

    it("pages a text match without a sort by item id", () =>
      runInTenant(tenantA, async () => {
        const projectsId = await databaseId("projects");
        const matching = [];
        for (const name of ["Novák 1", "Novák 2", "Novák 3"]) matching.push((await make("projects", { name })).id);
        await make("projects", { name: "Jiný projekt" });

        const first = await cp.queryDatabaseItems(projectsId, { q: "novak", limit: 2 });
        const second = await cp.queryDatabaseItems(projectsId, {
          q: "novak",
          limit: 2,
          cursor: first.nextCursor ?? "",
        });

        expect(first.nextCursor).not.toBeNull();
        expect(second.nextCursor).toBeNull();
        expect([...idsOf(first.items), ...idsOf(second.items)]).toEqual(sorted(matching));
      }));

    it("matches a diacritic-free word, a prefix and several words, and gives the global search's ids for the same text", () =>
      runInTenant(tenantA, async () => {
        const projects = await seedProjects();
        const projectsId = await databaseId("projects");
        for (const text of ["novak", "NOVÁK", "nov", "klient novak", "web klien"]) {
          const page = await cp.queryDatabaseItems(projectsId, { q: text });
          const global = await searchItemGroups(pool, {
            q: text,
            scope: ["project"],
            perGroupLimit: 50,
          });
          const projectGroup = global.groups.find((group) => group.type === "project");
          expect(page.items.length, text).toBeGreaterThan(0);
          expect(sorted(idsOf(page.items)), text).toEqual(
            sorted(projectGroup?.type === "project" ? projectGroup.items.map((item) => item.itemId) : []),
          );
        }
        expect(idsOf((await cp.queryDatabaseItems(projectsId, { q: "klient novak" })).items)).toEqual([
          projects.web.id,
        ]);
      }));

    it("treats query syntax characters as plain text and matches nothing for text with no word", () =>
      runInTenant(tenantA, async () => {
        const seeded = await seededProjectCount();
        const projects = await seedProjects();
        const projectsId = await databaseId("projects");

        const withSyntax = await cp.queryDatabaseItems(projectsId, {
          q: "(klient & | ! : ' novak)",
          includeCount: true,
        });
        const onlySyntax = await cp.queryDatabaseItems(projectsId, { q: "& | ! : ' ( ) \\", includeCount: true });

        expect(idsOf(withSyntax.items)).toEqual([projects.web.id]);
        expect(onlySyntax.items).toEqual([]);
        expect(onlySyntax.nextCursor).toBeNull();
        expect(onlySyntax.totalCount).toBe(seeded + 4);
      }));

    it("does not match an item without a search index row, and finds it again once the row exists", () =>
      runInTenant(tenantA, async () => {
        const projects = await seedProjects();
        const projectsId = await databaseId("projects");
        // The index row is written by the item's own write hook; only a raw delete can produce an unindexed item.
        await admin.query("DELETE FROM item_search_index WHERE item_id = $1", [projects.web.id]);
        expect(idsOf((await cp.queryDatabaseItems(projectsId, { q: "novak", filter: ACTIVE })).items)).toEqual([]);
        expect(idsOf((await cp.queryDatabaseItems(projectsId, { filter: ACTIVE })).items)).toContain(projects.web.id);
      }));

    it("restricts the match to the queried database and never returns another tenant's row", async () => {
      // Tenant B holds a project the text matches; its own scope finds it, tenant A's never does.
      const foreign = await runInTenant(tenantB, async () => {
        const project = await make("projects", { name: "Novák cizí", status: "inProgress" });
        const found = await cp.queryDatabaseItems(project.databaseId, { q: "novak" });
        expect(idsOf(found.items)).toEqual([project.id]);
        return project;
      });
      await runInTenant(tenantA, async () => {
        const projects = await seedProjects();
        const task = await make("tasks", { name: "Zavolat Novákovi, Novák" });

        const own = await cp.queryDatabaseItems(await databaseId("projects"), { q: "novak" });
        const tasksPage = await cp.queryDatabaseItems(await databaseId("tasks"), { q: "novak" });
        const foreignDatabase = await cp.queryDatabaseItems(foreign.databaseId, { q: "novak" });

        expect(idsOf(own.items)).not.toContain(task.id);
        expect(idsOf(own.items)).not.toContain(foreign.id);
        expect(idsOf(own.items)).toContain(projects.web.id);
        expect(idsOf(tasksPage.items)).toEqual([task.id]);
        expect(foreignDatabase.items).toEqual([]);
      });
    });

    it("leaves the statements of a request without q exactly as they were, and adds the index match only with q", () =>
      runInTenant(tenantA, async () => {
        await seedProjects();
        const projectsId = await databaseId("projects");
        const withoutQ: string[] = [];
        const withQ: string[] = [];

        await withTransaction(pool, (client) =>
          queryDatabaseItems(recordingClient(client, withoutQ), projectsId, { filter: ACTIVE, includeCount: true }),
        );
        await withTransaction(pool, (client) =>
          queryDatabaseItems(recordingClient(client, withQ), projectsId, {
            filter: ACTIVE,
            includeCount: true,
            q: "novak",
          }),
        );

        const listSql = (statements: string[]): string => {
          const found = statements.filter((sql) => sql.includes("FROM items WHERE") && sql.includes("ORDER BY"));
          expect(found).toHaveLength(1);
          return found[0] ?? "";
        };
        const countSql = (statements: string[]): string => {
          const found = statements.filter((sql) => sql.startsWith("SELECT count(*)::text AS count FROM items"));
          expect(found).toHaveLength(1);
          return found[0] ?? "";
        };
        expect(withoutQ.some((sql) => sql.includes("item_search_index"))).toBe(false);
        expect(listSql(withoutQ).replace(/\s+/g, " ")).toBe(
          "SELECT id, database_id, properties, computed, created_at, updated_at, deleted_at FROM items WHERE database_id = $1 AND deleted_at IS NULL AND properties ->> $2 = $3 ORDER BY id ASC LIMIT $4",
        );
        expect(countSql(withoutQ)).toBe(
          "SELECT count(*)::text AS count FROM items WHERE database_id = $1 AND deleted_at IS NULL AND properties ->> $2 = $3",
        );
        expect(listSql(withQ)).toContain("item_search_index");
        // The count of the same request carries no text match: it stays the filter-only count.
        expect(countSql(withQ)).toBe(countSql(withoutQ));
      }));

    it("refuses a q that is empty, too long or not a string on the field q, without repeating it", () =>
      runInTenant(tenantA, async () => {
        const projectsId = await databaseId("projects");
        const tooLong = "x".repeat(201);
        for (const bad of ["", tooLong, 42, ["novak"]]) {
          const error = await refusalOf(cp.queryDatabaseItems(projectsId, { q: bad }));
          expect(error.details).toEqual({ field: "q" });
          expect(errorText(error)).not.toContain(tooLong);
        }
        // The longest text the schema takes is accepted.
        await expect(cp.queryDatabaseItems(projectsId, { q: "x".repeat(200) })).resolves.toMatchObject({ items: [] });
      }));

    it("does not repeat q in a refusal that has another cause", () =>
      runInTenant(tenantA, async () => {
        const projectsId = await databaseId("projects");
        const marker = "zzmarkerzz";
        const badCursor = await refusalOf(cp.queryDatabaseItems(projectsId, { q: marker, cursor: "not-a-uuid" }));
        const badFilter = await refusalOf(
          cp.queryDatabaseItems(projectsId, { q: marker, filter: { type: "nonsense" } }),
        );
        expect(errorText(badCursor)).not.toContain(marker);
        expect(errorText(badFilter)).not.toContain(marker);
      }));
  });

  describe("view.query", () => {
    it("narrows a filtered view by the text with the view's own filter, and keeps totalCount at the filter-only count", () =>
      runInTenant(tenantA, async () => {
        const projects = await seedProjects();
        const projectsId = await databaseId("projects");
        const view = await cp.createView({
          databaseId: projectsId,
          type: "table",
          name: "Active",
          config: { filter: ACTIVE },
        });

        const page = await cp.queryViewItems(view.id, { q: "novak", includeCount: true });

        expect(idsOf(page.items)).toEqual([projects.web.id]);
        expect(page.totalCount).toBe(2);
        expect(page.totalCount).toBe((await cp.queryViewItems(view.id, { includeCount: true })).totalCount);
      }));

    it("applies the text with a request filter that replaces the view's, and with a sort and a cursor", () =>
      runInTenant(tenantA, async () => {
        const seeded = await seededProjectCount();
        await seedProjects();
        const projectsId = await databaseId("projects");
        const view = await cp.createView({ databaseId: projectsId, type: "table", name: "Everything" });
        const sort = [{ property: "name", direction: "asc" as const }];

        const first = await cp.queryViewItems(view.id, { q: "novak", sort, limit: 2, includeCount: true });
        const second = await cp.queryViewItems(view.id, {
          q: "novak",
          sort,
          limit: 2,
          cursor: first.nextCursor ?? "",
          includeCount: true,
        });

        expect(first.items.map((item) => item.properties.name)).toEqual(["Novák archiv", "Novák roční plán"]);
        expect(second.items.map((item) => item.properties.name)).toEqual(["Web pro klienta"]);
        expect(second.nextCursor).toBeNull();
        expect([first.totalCount, second.totalCount]).toEqual([seeded + 4, seeded + 4]);

        const overridden = await cp.queryViewItems(view.id, {
          q: "novak",
          filter: { type: "equals", property: "status", value: "done" },
        });
        expect(overridden.items.map((item) => item.properties.name)).toEqual(["Novák archiv"]);
      }));

    it("refuses q on a curated view, which has no single database, and still serves the view without it", () =>
      runInTenant(tenantA, async () => {
        const projects = await seedProjects();
        const view = await cp.createView({ type: "list", name: "Picked", config: { membership: "manual" } });
        await cp.addViewItem({ viewId: view.id, itemId: projects.web.id, actor: { type: "user" } });

        const refused = await refusalOf(cp.queryViewItems(view.id, { q: "novak" }));

        expect(refused.details).toEqual({ field: "q" });
        expect(errorText(refused)).not.toContain("novak");
        expect(idsOf((await cp.queryViewItems(view.id, {})).items)).toEqual([projects.web.id]);
      }));

    it("refuses an invalid q on a filtered view on the field q", () =>
      runInTenant(tenantA, async () => {
        const view = await cp.createView({ databaseId: await databaseId("projects"), type: "table", name: "All" });
        const refused = await refusalOf(cp.queryViewItems(view.id, { q: "" }));
        expect(refused.details).toEqual({ field: "q" });
      }));
  });

  describe("item.count", () => {
    const count = (entries: ItemCountEntryInput[]) => cp.countItemsBatch(entries, { resolver });

    it("counts only the matching rows of that database, ANDed with the filter, and an entry without q as before", () =>
      runInTenant(tenantA, async () => {
        const seeded = await seededProjectCount();
        await seedProjects();
        const task = await make("tasks", { name: "Novák telefonát" });
        const projectsId = await databaseId("projects");
        const tasksId = await databaseId("tasks");

        const counts = await count([
          { databaseId: projectsId },
          { databaseId: projectsId, q: "novak" },
          { databaseId: projectsId, q: "novak", filter: ACTIVE },
          { databaseId: projectsId, q: "nenalezeno" },
          { databaseId: tasksId, q: "novak" },
        ]);

        expect(task.databaseId).toBe(tasksId);
        expect(counts.map((entry) => entry.count)).toEqual([seeded + 4, 3, 1, 0, 1]);
      }));

    it("applies the text to every group of a grouped count and to the total", () =>
      runInTenant(tenantA, async () => {
        await seedProjects();
        const projectsId = await databaseId("projects");

        const [grouped] = await count([{ databaseId: projectsId, q: "novak", groupBy: "status" }]);

        expect(grouped?.count).toBe(3);
        expect(grouped?.groups).toEqual([
          { key: "inProgress", count: 1 },
          { key: "longTerm", count: 1 },
          { key: "done", count: 1 },
        ]);
      }));

    it("counts text with query syntax as plain text and text with no word as zero", () =>
      runInTenant(tenantA, async () => {
        await seedProjects();
        const projectsId = await databaseId("projects");
        const counts = await count([
          { databaseId: projectsId, q: "(klient & | ! : ' novak)" },
          { databaseId: projectsId, q: "& | ! : '" },
        ]);
        expect(counts.map((entry) => entry.count)).toEqual([1, 0]);
      }));

    it("counts another tenant's database as not found, whether or not q is sent", async () => {
      const foreignId = await runInTenant(tenantB, () => databaseId("projects"));
      await runInTenant(tenantA, async () => {
        await expect(count([{ databaseId: foreignId, q: "novak" }])).rejects.toBeInstanceOf(NotFoundError);
        await expect(count([{ databaseId: foreignId }])).rejects.toBeInstanceOf(NotFoundError);
      });
    });
  });
});
