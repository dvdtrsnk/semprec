import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import type { ItemCountEntryInput } from "../chokePoint/itemReads.js";
import type { ItemCountGroup } from "../chokePoint/itemsStore.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { withTransaction } from "../db/pool.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { createCollectionMetadataResolver, type CollectionMetadataResolver } from "../manifest/collectionMetadata.js";
import { loadFullModuleRegistry } from "../manifest/fullModuleRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import type { DatabaseRow, ItemRow } from "../types.js";

let admin: Pool;
let pool: Pool;
let cp: ChokePoint;
let tenant: string;
let resolver: CollectionMetadataResolver;

async function database(key: string): Promise<DatabaseRow> {
  const db = await withTransaction(pool, (client) => getDatabaseByModuleId(client, key));
  if (!db) throw new Error(`Missing seeded database '${key}'`);
  return db;
}

async function make(key: string, properties: Record<string, unknown>): Promise<ItemRow> {
  return cp.createItem({ databaseId: (await database(key)).id, properties });
}

async function link(item: ItemRow, key: string, target: ItemRow): Promise<void> {
  const property = (await cp.listProperties(item.databaseId)).find((candidate) => candidate.key === key);
  if (!property) throw new Error(`Missing relation property '${key}'`);
  await cp.createRelation({ relationPropertyId: property.id, callerItemId: item.id, targetItemId: target.id });
}

function count(entries: ItemCountEntryInput[], now?: Date) {
  return cp.countItemsBatch(entries, { resolver, now });
}

/** The live items of a database, counted by a plain statement of the test's own as the expected value. */
async function liveItems(databaseId: string): Promise<number> {
  const { rows } = await withTransaction(pool, (client) =>
    client.query<{ n: number }>("SELECT count(*)::int AS n FROM items WHERE database_id = $1 AND deleted_at IS NULL", [
      databaseId,
    ]),
  );
  const row = rows[0];
  if (!row) throw new Error("Expected a count row");
  return row.n;
}

/** Relation groups in the order the operation returns them: by target id, the `null` group last. */
function byKey(groups: ItemCountGroup[]): ItemCountGroup[] {
  return [...groups].sort((left, right) => {
    if (left.key === null || right.key === null) return left.key === right.key ? 0 : left.key === null ? 1 : -1;
    return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
  });
}

/** What a refused count reports, with the requested id masked so two requests can be compared. */
async function notFoundAnswer(databaseId: string, entries: ItemCountEntryInput[]): Promise<Record<string, unknown>> {
  try {
    await count(entries);
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
    return {
      status: error.status,
      code: error.code,
      message: error.message.replaceAll(databaseId, "<id>"),
      details: JSON.stringify(error.details).replaceAll(databaseId, "<id>"),
    };
  }
  throw new Error("Expected the count to be refused");
}

describe("choke-point countItemsBatch (issue #1709)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("test:verify-runtime-role", () =>
      pool.query<{ role_name: string; rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT current_user::text AS role_name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ role_name: "semprec_data", rolsuper: false, rolbypassrls: false }]);
    cp = createChokePoint(pool);
    resolver = await createCollectionMetadataResolver(await loadFullModuleRegistry());
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(pool));
  });

  afterAll(async () => {
    await pool.end();
    await admin.end();
  });

  it("counts nine collections in one call, in request order, without trashed items and without system projects", () =>
    runInTenant(tenant, async () => {
      const keys = ["projects", "events", "people", "companies", "files", "healthRecords", "books", "movies", "tasks"];
      const entries: ItemCountEntryInput[] = [];
      const expected: Array<{ databaseId: string; count: number }> = [];
      for (const [index, key] of keys.entries()) {
        const { id } = await database(key);
        const seeded = await liveItems(id);
        // An event is refused without a date; no other of these databases requires a property.
        const required = key === "events" ? { date: "2026-06-15" } : {};
        for (let n = 0; n <= index; n += 1) await make(key, { name: `${key} ${n}`, ...required });
        const trashed = await make(key, { name: `${key} trashed`, ...required });
        await cp.softDeleteItem(id, trashed.id);
        if (key === "projects") {
          // The seeded projects are the system projects, which the collection filter leaves out.
          expect(seeded).toBeGreaterThan(0);
          entries.push({ databaseId: id, collection: true });
          expected.push({ databaseId: id, count: index + 1 });
        } else {
          entries.push({ databaseId: id });
          expected.push({ databaseId: id, count: seeded + index + 1 });
        }
      }

      expect(await count(entries)).toEqual(expected);
      // The same entries in another order come back in that order.
      expect(await count([...entries].reverse())).toEqual([...expected].reverse());
    }));

  it("leaves system projects out of Projects under the collection filter", () =>
    runInTenant(tenant, async () => {
      const projects = await database("projects");
      const systemProjects = await liveItems(projects.id);
      expect(systemProjects).toBeGreaterThan(0);
      await make("projects", { name: "Garden", status: "inProgress" });
      await make("projects", { name: "Taxes", status: "done" });

      expect(
        await count([
          { databaseId: projects.id },
          { databaseId: projects.id, collection: true },
          { databaseId: projects.id, collection: true, filter: { type: "equals", property: "status", value: "done" } },
          // Matches system projects only, so together with the collection filter it matches nothing.
          { databaseId: projects.id, filter: { type: "is_not_empty", property: "systemActive" } },
          { databaseId: projects.id, collection: true, filter: { type: "is_not_empty", property: "systemActive" } },
        ]),
      ).toEqual([
        { databaseId: projects.id, count: systemProjects + 2 },
        { databaseId: projects.id, count: 2 },
        { databaseId: projects.id, count: 1 },
        { databaseId: projects.id, count: systemProjects },
        { databaseId: projects.id, count: 0 },
      ]);
    }));

  it("counts a database without a declared collection filter unfiltered under collection: true", () =>
    runInTenant(tenant, async () => {
      const tasks = await database("tasks");
      const custom = await cp.createDatabase({ name: "Gifts" });
      await make("tasks", { name: "Call" });
      await cp.createItem({ databaseId: custom.id, properties: {} });
      await cp.createItem({ databaseId: custom.id, properties: {} });

      expect(
        await count([
          { databaseId: tasks.id, collection: true },
          { databaseId: custom.id, collection: true },
        ]),
      ).toEqual([
        { databaseId: tasks.id, count: 1 },
        { databaseId: custom.id, count: 2 },
      ]);
    }));

  it("drops a soft-deleted item from the count and its group, and counts it again once restored", () =>
    runInTenant(tenant, async () => {
      const people = await database("people");
      const company = await make("companies", { name: "Acme" });
      const first = await make("people", { name: "Ada" });
      const second = await make("people", { name: "Bob" });
      await link(first, "companies", company);
      await link(second, "companies", company);
      const entries = [{ databaseId: people.id }, { databaseId: people.id, groupBy: "companies" }];
      const counted = (total: number) => [
        { databaseId: people.id, count: total },
        { databaseId: people.id, count: total, groups: [{ key: company.id, count: total }] },
      ];

      expect(await count(entries)).toEqual(counted(2));
      await cp.softDeleteItem(people.id, second.id);
      expect(await count(entries)).toEqual(counted(1));
      await cp.restoreItem(people.id, second.id);
      expect(await count(entries)).toEqual(counted(2));
    }));

  it("counts nothing in an archived database, drops its items as relation targets, and counts both again after the restore", () =>
    runInTenant(tenant, async () => {
      const source = await cp.createDatabase({ name: "Source" });
      const target = await cp.createDatabase({ name: "Target" });
      const other = await cp.createDatabase({ name: "Other target" });
      await cp.createProperty({
        databaseId: target.id,
        key: "stage",
        name: "Stage",
        type: "select",
        config: { options: [{ key: "open" }] },
      });
      const { property: targets } = await cp.createRelationProperty({
        sourceDatabaseId: source.id,
        key: "targets",
        name: "Targets",
        targetDatabaseId: target.id,
      });
      const { property: others } = await cp.createRelationProperty({
        sourceDatabaseId: source.id,
        key: "others",
        name: "Others",
        targetDatabaseId: other.id,
      });
      const targetItem = await cp.createItem({ databaseId: target.id, properties: { stage: "open" } });
      const otherItem = await cp.createItem({ databaseId: other.id, properties: {} });
      const first = await cp.createItem({ databaseId: source.id, properties: {} });
      const second = await cp.createItem({ databaseId: source.id, properties: {} });
      await cp.createItem({ databaseId: source.id, properties: {} });
      for (const caller of [first, second]) {
        await cp.createRelation({
          relationPropertyId: targets.id,
          callerItemId: caller.id,
          targetItemId: targetItem.id,
        });
      }
      await cp.createRelation({ relationPropertyId: others.id, callerItemId: second.id, targetItemId: otherItem.id });
      const entries = [
        { databaseId: target.id },
        { databaseId: target.id, groupBy: "stage" },
        { databaseId: source.id, groupBy: "targets" },
        { databaseId: source.id, groupBy: "others" },
      ];
      const untouched = {
        databaseId: source.id,
        count: 3,
        groups: [
          { key: otherItem.id, count: 1 },
          { key: null, count: 2 },
        ],
      };
      const live = [
        { databaseId: target.id, count: 1 },
        { databaseId: target.id, count: 1, groups: [{ key: "open", count: 1 }] },
        {
          databaseId: source.id,
          count: 3,
          groups: [
            { key: targetItem.id, count: 2 },
            { key: null, count: 1 },
          ],
        },
        untouched,
      ];

      expect(await count(entries)).toEqual(live);
      await cp.archiveDatabase(target.id);
      expect(await count(entries)).toEqual([
        { databaseId: target.id, count: 0 },
        { databaseId: target.id, count: 0, groups: [] },
        // The items whose every edge ends in the archived database are counted without a target.
        { databaseId: source.id, count: 3, groups: [{ key: null, count: 3 }] },
        untouched,
      ]);
      await cp.restoreDatabase(target.id);
      expect(await count(entries)).toEqual(live);
    }));

  it("groups active projects by area: one count per area that occurs, the projects without one, and the total", () =>
    runInTenant(tenant, async () => {
      const projects = await database("projects");
      const work = await make("areas", { name: "Work" });
      const home = await make("areas", { name: "Home" });
      // An area no active project belongs to gets no group.
      const unused = await make("areas", { name: "Unused" });
      const active = [
        await make("projects", { name: "Launch", status: "inProgress" }),
        await make("projects", { name: "Hiring", status: "longTerm" }),
        await make("projects", { name: "Garden", status: "inProgress" }),
        await make("projects", { name: "Someday", status: "inProgress" }),
      ];
      const finished = await make("projects", { name: "Old", status: "done" });
      await link(active[0]!, "area", work);
      await link(active[1]!, "area", work);
      await link(active[2]!, "area", home);
      await link(finished, "area", unused);

      const [answer] = await count([
        {
          databaseId: projects.id,
          collection: true,
          filter: { type: "in", property: "status", value: ["inProgress", "longTerm"] },
          groupBy: "area",
        },
      ]);

      expect(answer).toEqual({
        databaseId: projects.id,
        count: 4,
        groups: byKey([
          { key: work.id, count: 2 },
          { key: home.id, count: 1 },
          { key: null, count: 1 },
        ]),
      });
    }));

  it("counts an item with several targets in each of their groups and once in the total", () =>
    runInTenant(tenant, async () => {
      const people = await database("people");
      const acme = await make("companies", { name: "Acme" });
      const globex = await make("companies", { name: "Globex" });
      const both = await make("people", { name: "Ada" });
      const one = await make("people", { name: "Bob" });
      await link(both, "companies", acme);
      await link(both, "companies", globex);
      await link(one, "companies", acme);

      expect(await count([{ databaseId: people.id, groupBy: "companies" }])).toEqual([
        {
          databaseId: people.id,
          count: 2,
          groups: byKey([
            { key: acme.id, count: 2 },
            { key: globex.id, count: 1 },
          ]),
        },
      ]);
    }));

  it("counts an item whose only target is in the trash without a target, until the target is restored", () =>
    runInTenant(tenant, async () => {
      const people = await database("people");
      const company = await make("companies", { name: "Acme" });
      const person = await make("people", { name: "Ada" });
      await link(person, "companies", company);
      const entries = [{ databaseId: people.id, groupBy: "companies" }];

      await cp.softDeleteItem(company.databaseId, company.id);
      expect(await count(entries)).toEqual([{ databaseId: people.id, count: 1, groups: [{ key: null, count: 1 }] }]);
      await cp.restoreItem(company.databaseId, company.id);
      expect(await count(entries)).toEqual([
        { databaseId: people.id, count: 1, groups: [{ key: company.id, count: 1 }] },
      ]);
    }));

  it("returns not-done tasks per project, and those of today, from one batch", () =>
    runInTenant(tenant, async () => {
      const tasks = await database("tasks");
      const now = new Date("2026-06-15T10:00:00.000Z");
      const garden = await make("projects", { name: "Garden" });
      const taxes = await make("projects", { name: "Taxes" });
      const task = async (name: string, status: string, date: string, project?: ItemRow) => {
        const created = await make("tasks", { name, status, date });
        if (project) await link(created, "project", project);
      };
      await task("Dig", "notDone", "2026-06-15", garden);
      await task("Plant", "notDone", "2026-06-16", garden);
      await task("Mow", "done", "2026-06-15", garden);
      await task("File", "notDone", "2026-06-15", taxes);
      await task("Loose", "notDone", "2026-06-14");
      const notDone = { type: "equals", property: "status", value: "notDone" };

      const answer = await count(
        [
          { databaseId: tasks.id, filter: notDone, groupBy: "project" },
          {
            databaseId: tasks.id,
            filter: { type: "and", nodes: [notDone, { type: "date_relative", property: "date", preset: "today" }] },
            groupBy: "project",
          },
        ],
        now,
      );

      expect(answer).toEqual([
        {
          databaseId: tasks.id,
          count: 4,
          groups: byKey([
            { key: garden.id, count: 2 },
            { key: taxes.id, count: 1 },
            { key: null, count: 1 },
          ]),
        },
        {
          databaseId: tasks.id,
          count: 2,
          groups: byKey([
            { key: garden.id, count: 1 },
            { key: taxes.id, count: 1 },
          ]),
        },
      ]);
    }));

  it("groups by a select property in option order, then other stored values, then the items without a value", () =>
    runInTenant(tenant, async () => {
      const board = await cp.createDatabase({ name: "Board" });
      await cp.createProperty({
        databaseId: board.id,
        key: "stage",
        name: "Stage",
        type: "select",
        // Deliberately not in alphabetical order, and with an option no item uses.
        config: { options: [{ key: "todo" }, { key: "doing" }, { key: "done" }, { key: "blocked" }] },
      });
      const stages: unknown[] = ["done", "zeta", "doing", "todo", "done", "alpha", "done", "", null, undefined, "todo"];
      for (const stage of stages) {
        await cp.createItem({ databaseId: board.id, properties: stage === undefined ? {} : { stage } });
      }

      expect(await count([{ databaseId: board.id, groupBy: "stage" }])).toEqual([
        {
          databaseId: board.id,
          count: stages.length,
          groups: [
            { key: "todo", count: 2 },
            { key: "doing", count: 1 },
            { key: "done", count: 3 },
            { key: "alpha", count: 1 },
            { key: "zeta", count: 1 },
            { key: null, count: 3 },
          ],
        },
      ]);
    }));

  it("groups tasks by their status in option order under a filter", () =>
    runInTenant(tenant, async () => {
      const tasks = await database("tasks");
      for (const [name, status] of [
        ["Missed", "missed"],
        ["Done", "done"],
        ["Open", "notDone"],
        ["Also open", "notDone"],
        ["Skipped", "wontDo"],
      ] as const) {
        await make("tasks", { name, status });
      }

      expect(
        await count([
          {
            databaseId: tasks.id,
            filter: { type: "not_equals", property: "status", value: "wontDo" },
            groupBy: "status",
          },
        ]),
      ).toEqual([
        {
          databaseId: tasks.id,
          count: 4,
          groups: [
            { key: "notDone", count: 2 },
            { key: "done", count: 1 },
            { key: "missed", count: 1 },
          ],
        },
      ]);
    }));

  it("refuses an unknown, an ungroupable and an unresolvable groupBy on that field", () =>
    runInTenant(tenant, async () => {
      const source = await cp.createDatabase({ name: "Source" });
      const target = await cp.createDatabase({ name: "Target" });
      await cp.createProperty({ databaseId: source.id, key: "note", name: "Note", type: "text" });
      await cp.createProperty({ databaseId: source.id, key: "tags", name: "Tags", type: "multi_select" });
      const { property: broken } = await cp.createRelationProperty({
        sourceDatabaseId: source.id,
        key: "broken",
        name: "Broken",
        targetDatabaseId: target.id,
      });
      // Raw SQL: no production write removes a relation definition and keeps its property.
      const definitionId = broken.config.relationDefinitionId;
      if (typeof definitionId !== "string") throw new Error("Expected the relation property to name its definition");
      const removed = await withTransaction(pool, (client) =>
        client.query("DELETE FROM relation_definitions WHERE id = $1", [definitionId]),
      );
      expect(removed.rowCount).toBe(1);

      for (const groupBy of ["missing", "note", "tags", "broken"]) {
        const refused = count([{ databaseId: source.id, groupBy }]);
        await expect(refused, groupBy).rejects.toBeInstanceOf(ValidationError);
        await expect(refused, groupBy).rejects.toMatchObject({ status: 400, details: { field: "groupBy" } });
      }
    }));

  it("refuses the filters a database query refuses, naming the same field", () =>
    runInTenant(tenant, async () => {
      const tasks = await database("tasks");
      const malformed = count([{ databaseId: tasks.id, filter: { type: "unknown" } }]);
      await expect(malformed).rejects.toBeInstanceOf(ValidationError);
      await expect(malformed).rejects.toMatchObject({ details: { field: "filter" } });
      const unknownProperty = { type: "equals", property: "nope", value: "x" };
      const forCount = count([{ databaseId: tasks.id, filter: unknownProperty }]);
      await expect(forCount).rejects.toBeInstanceOf(ValidationError);
      await expect(forCount).rejects.toMatchObject({ details: { field: "nope" } });
      await expect(cp.queryDatabaseItems(tasks.id, { filter: unknownProperty })).rejects.toMatchObject({
        details: { field: "nope" },
      });
    }));

  it("answers another tenant's database exactly as an unknown one, and fails the whole batch on it", async () => {
    const otherTenant = await createTestTenant(admin);
    const foreign = await runInTenant(otherTenant, async () => {
      await seedSystem(pool);
      const tasks = await database("tasks");
      await make("tasks", { name: "Foreign task" });
      // The other tenant counts its own database, so the refusal below is not a missing row.
      expect(await count([{ databaseId: tasks.id }])).toEqual([{ databaseId: tasks.id, count: 1 }]);
      return tasks.id;
    });

    await runInTenant(tenant, async () => {
      const own = await database("tasks");
      const unknown = randomUUID();
      for (const entry of [{}, { groupBy: "status" }, { collection: true }]) {
        expect(await notFoundAnswer(foreign, [{ databaseId: foreign, ...entry }])).toEqual(
          await notFoundAnswer(unknown, [{ databaseId: unknown, ...entry }]),
        );
      }
      expect(await notFoundAnswer(foreign, [{ databaseId: own.id }, { databaseId: foreign }])).toEqual({
        status: 404,
        code: "not_found",
        message: "Database <id> not found",
        details: JSON.stringify({ resource: "database", databaseId: "<id>" }),
      });
    });
  });

  it("never names another tenant's item as a group, even through a dangling edge", async () => {
    const otherTenant = await createTestTenant(admin);
    const foreign = await runInTenant(otherTenant, async () => {
      await seedSystem(pool);
      return make("companies", { name: "Foreign company" });
    });

    await runInTenant(tenant, async () => {
      const people = await database("people");
      const own = await make("companies", { name: "Own company" });
      const linked = await make("people", { name: "Ada" });
      const dangling = await make("people", { name: "Bob" });
      const property = (await cp.listProperties(people.id)).find((candidate) => candidate.key === "companies");
      if (!property) throw new Error("Missing relation property 'companies'");
      const edge = await cp.createRelation({
        relationPropertyId: property.id,
        callerItemId: linked.id,
        targetItemId: own.id,
      });
      // The malformed edge sits the way the stored one does: the person on the same side, the company on the other.
      const [itemA, itemB] = edge.itemA === linked.id ? [dangling.id, foreign.id] : [foreign.id, dangling.id];
      // Raw SQL: a relation write refuses an endpoint of another tenant, so only a malformed edge points at one.
      await withTransaction(pool, (client) =>
        client.query("INSERT INTO item_relations (relation_definition_id, item_a, item_b) VALUES ($1, $2, $3)", [
          edge.relationDefinitionId,
          itemA,
          itemB,
        ]),
      );

      expect(await count([{ databaseId: people.id, groupBy: "companies" }])).toEqual([
        {
          databaseId: people.id,
          count: 2,
          groups: [
            { key: own.id, count: 1 },
            { key: null, count: 1 },
          ],
        },
      ]);
    });
  });

  it("reads the items table with one statement per entry, grouped or not", async () => {
    const statements: string[] = [];
    const originals = new Map<PoolClient, PoolClient["query"]>();
    const record = (client: PoolClient) => {
      if (originals.has(client)) return;
      // eslint-disable-next-line @typescript-eslint/unbound-method
      originals.set(client, client.query);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      client.query = new Proxy(client.query, {
        apply(target, receiver, args: unknown[]) {
          if (typeof args[0] === "string") statements.push(args[0]);
          return Reflect.apply(target, receiver, args);
        },
      });
    };
    // A dedicated pool, so no instrumented client goes back into the pool the other tests use.
    const observed = await createRuntimeRolePool(admin, "semprec_data");
    try {
      await runInTenant(tenant, async () => {
        const people = await database("people");
        const tasks = await database("tasks");
        const person = await make("people", { name: "Ada" });
        await link(person, "companies", await make("companies", { name: "Acme" }));
        await make("tasks", { name: "Call", status: "notDone" });
        observed.on("acquire", record);

        const answer = await createChokePoint(observed).countItemsBatch(
          [
            { databaseId: people.id },
            { databaseId: people.id, groupBy: "companies" },
            { databaseId: tasks.id, groupBy: "status", filter: { type: "is_not_empty", property: "name" } },
          ],
          { resolver },
        );

        expect(answer.map((entry) => entry.count)).toEqual([1, 1, 1]);
        expect(statements.filter((sql) => /\bitems\b/.test(sql))).toHaveLength(3);
      });
    } finally {
      observed.off("acquire", record);
      for (const [client, query] of originals) client.query = query;
      await observed.end();
    }
  });
});
