import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runAsSystem, runInTenant } from "@alldots/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { withTransaction } from "../db/pool.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { seedSystem } from "../seed/seedSystem.js";
import type { DatabaseRow, ItemRow } from "../types.js";
import type { DatabaseFacetsInput, DatabaseFacetsOptions, DatabaseFacetValue } from "../views/facetQuery.js";

let admin: Pool;
let pool: Pool;
let cp: ChokePoint;
let tenant: string;

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

function facets(input: DatabaseFacetsInput, options?: DatabaseFacetsOptions) {
  return cp.getDatabaseFacets(input, options);
}

function byCountThenId(values: DatabaseFacetValue[]): DatabaseFacetValue[] {
  return [...values].sort((left, right) => {
    if (left.count !== right.count) return right.count - left.count;
    return String(left.value) < String(right.value) ? -1 : String(left.value) > String(right.value) ? 1 : 0;
  });
}

/** What a refused facet call reports, with the requested id masked so two requests can be compared. */
async function notFoundAnswer(databaseId: string, input: DatabaseFacetsInput): Promise<Record<string, unknown>> {
  try {
    await facets(input);
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
    return {
      status: error.status,
      code: error.code,
      message: error.message.replaceAll(databaseId, "<id>"),
      details: JSON.stringify(error.details).replaceAll(databaseId, "<id>"),
    };
  }
  throw new Error("Expected the facets to be refused");
}

const PROJECT_STATUS_ZERO = [
  { value: "inProgress", label: "In progress", color: "#007AFF", count: 0 },
  { value: "longTerm", label: "Long-term", color: "#AF52DE", count: 0 },
  { value: "done", label: "Done", color: "#34C759", count: 0 },
  { value: "archived", label: "Archived", color: "#8E8E93", count: 0 },
];

function projectStatuses(counts: [number, number, number, number]): DatabaseFacetValue[] {
  return PROJECT_STATUS_ZERO.map((option, index) => ({ ...option, count: counts[index] ?? 0 }));
}

describe("choke-point getDatabaseFacets (issue #1759)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "alldots_data");
    const role = await runAsSystem("test:verify-runtime-role", () =>
      pool.query<{ role_name: string; rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT current_user::text AS role_name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ role_name: "alldots_data", rolsuper: false, rolbypassrls: false }]);
    cp = createChokePoint(pool);
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

  async function seedProjects() {
    const work = await make("companies", { name: "Work" });
    const home = await make("companies", { name: "Home" });
    const project = async (name: string, status: string, company?: ItemRow) => {
      const created = await make("projects", { name, status });
      if (company) await link(created, "company", company);
      return created;
    };
    await project("Launch", "inProgress", work);
    await project("Hiring", "inProgress", work);
    await project("Brand", "longTerm", work);
    await project("Audit", "done", work);
    await project("Garden", "inProgress", home);
    await project("Someday", "inProgress");
    return { projects: await database("projects"), work, home };
  }

  it("lists every status option in option order with its count inside the company, also one no project holds, whatever the status condition says", () =>
    runInTenant(tenant, async () => {
      const { projects, work } = await seedProjects();
      const inWork = { type: "relation_contains", property: "company", value: work.id };
      const expected = [
        { property: "status", all: 4, values: [...projectStatuses([2, 1, 1, 0]), { value: null, count: 0 }] },
      ];

      for (const status of [
        { type: "equals", property: "status", value: "inProgress" },
        { type: "in", property: "status", value: ["done", "archived"] },
      ]) {
        expect(
          await facets({
            databaseId: projects.id,
            filter: { type: "and", nodes: [status, inWork] },
            facets: ["status"],
          }),
          JSON.stringify(status),
        ).toEqual(expected);
      }
    }));

  it("removes for each facet of one call only the conditions on that facet, and lists only the companies projects have", () =>
    runInTenant(tenant, async () => {
      const { projects, work, home } = await seedProjects();
      await make("companies", { name: "Unused" });
      const filter = {
        type: "and",
        nodes: [
          { type: "is_empty", property: "systemActive" },
          { type: "equals", property: "status", value: "inProgress" },
          { type: "relation_contains", property: "company", value: work.id },
        ],
      };

      const answer = await facets({ databaseId: projects.id, filter, facets: ["status", "company"] });

      expect(answer).toEqual([
        // Inside Work, whatever the status: the company condition stays and the status condition goes.
        { property: "status", all: 4, values: [...projectStatuses([2, 1, 1, 0]), { value: null, count: 0 }] },
        // In progress, whatever the company: the status condition stays and the company condition goes.
        {
          property: "company",
          all: 4,
          values: [
            { value: work.id, label: "Work", count: 2 },
            { value: home.id, label: "Home", count: 1 },
            { value: null, count: 1 },
          ],
        },
      ]);
    }));

  it("removes a facet condition nested in a second and, and the filter that is nothing but that condition", () =>
    runInTenant(tenant, async () => {
      const { projects, work } = await seedProjects();
      const inProgress = { type: "equals", property: "status", value: "inProgress" };
      const inWork = { type: "relation_contains", property: "company", value: work.id };
      const insideWork = [
        { property: "status", all: 4, values: [...projectStatuses([2, 1, 1, 0]), { value: null, count: 0 }] },
      ];

      expect(
        await facets({
          databaseId: projects.id,
          filter: { type: "and", nodes: [{ type: "and", nodes: [inProgress, inWork] }] },
          facets: ["status"],
        }),
      ).toEqual(insideWork);
      // Without the nested status condition the inner `and` keeps the company condition; without both it is gone.
      expect(
        await facets({
          databaseId: projects.id,
          filter: { type: "and", nodes: [{ type: "and", nodes: [inProgress] }, inWork] },
          facets: ["status"],
        }),
      ).toEqual(insideWork);

      const user = { type: "is_empty", property: "systemActive" };
      const unfiltered = await facets({ databaseId: projects.id, filter: user, facets: ["status"] });
      expect(unfiltered).toEqual([
        { property: "status", all: 6, values: [...projectStatuses([4, 1, 1, 0]), { value: null, count: 0 }] },
      ]);
      // The root itself is a condition on the facet: nothing remains, so every project of the database counts.
      const [withoutFilter] = await facets({ databaseId: projects.id, facets: ["status"] });
      expect(await facets({ databaseId: projects.id, filter: inProgress, facets: ["status"] })).toEqual([
        withoutFilter,
      ]);
      expect(withoutFilter?.all).toBeGreaterThan(6);
    }));

  it("lists only the projects tasks have, each with its own color, and the tasks without a live project", () =>
    runInTenant(tenant, async () => {
      const tasks = await database("tasks");
      const launch = await make("projects", { name: "Launch", color: "#FF3B30" });
      const garden = await make("projects", { name: "Garden", color: "#34C759" });
      await make("projects", { name: "Idle", color: "#007AFF" });
      const loose = await make("projects", { name: "Loose" });
      const task = async (name: string, project?: ItemRow) => {
        const created = await make("tasks", { name });
        if (project) await link(created, "project", project);
        return created;
      };
      await task("Announce", launch);
      await task("Invite", launch);
      await task("Dig", garden);
      await task("Sort", loose);
      await task("Call");
      const trashed = await task("Dropped", launch);
      await cp.softDeleteItem(tasks.id, trashed.id);

      const request = { databaseId: tasks.id, facets: ["project"] };
      expect(await facets(request)).toEqual([
        {
          property: "project",
          all: 5,
          values: [
            { value: launch.id, label: "Launch", color: "#FF3B30", count: 2 },
            ...byCountThenId([
              { value: garden.id, label: "Garden", color: "#34C759", count: 1 },
              // A project without a color of its own carries none.
              { value: loose.id, label: "Loose", count: 1 },
            ]),
            { value: null, count: 1 },
          ],
        },
      ]);

      // A project in the trash is no value: its task joins the tasks without a project.
      await cp.softDeleteItem(garden.databaseId, garden.id);
      expect(await facets(request)).toEqual([
        {
          property: "project",
          all: 5,
          values: [
            { value: launch.id, label: "Launch", color: "#FF3B30", count: 2 },
            { value: loose.id, label: "Loose", count: 1 },
            { value: null, count: 2 },
          ],
        },
      ]);

      // The color follows the project's own color when it changes.
      await cp.updateItem({ databaseId: launch.databaseId, itemId: launch.id, propertiesPatch: { color: "#AF52DE" } });
      const [afterRecolor] = await facets(request);
      expect(afterRecolor?.values[0]).toEqual({ value: launch.id, label: "Launch", color: "#AF52DE", count: 2 });
    }));

  it("counts the tasks of each company through their project, and the open ones, under the filter", () =>
    runInTenant(tenant, async () => {
      const tasks = await database("tasks");
      const work = await make("companies", { name: "Work" });
      const home = await make("companies", { name: "Home" });
      await make("companies", { name: "Unused" });
      const launch = await make("projects", { name: "Launch" });
      const garden = await make("projects", { name: "Garden" });
      await link(launch, "company", work);
      await link(garden, "company", home);
      const task = async (name: string, properties: Record<string, unknown>, project?: ItemRow) => {
        const created = await make("tasks", { name, ...properties });
        if (project) await link(created, "project", project);
      };
      await task("Announce", { status: "notDone", flagged: true }, launch);
      await task("Invite", { status: "done", flagged: true }, launch);
      await task("Dig", { status: "notDone", flagged: true }, garden);
      await task("Call", { status: "notDone", flagged: true });
      await task("Later", { status: "notDone", flagged: false }, launch);
      const flagged = { type: "equals", property: "flagged", value: true };
      const open = { type: "equals", property: "status", value: "notDone" };
      const expected = [
        {
          path: ["project", "company"],
          all: 4,
          open: 3,
          values: [
            { value: work.id, label: "Work", count: 2 },
            { value: home.id, label: "Home", count: 1 },
            { value: null, count: 1 },
          ],
        },
      ];

      const path: [string, string] = ["project", "company"];
      expect(await facets({ databaseId: tasks.id, filter: flagged, facets: [{ path }], extra: { open } })).toEqual(
        expected,
      );
      // A condition on the same path is the facet's own and is left out; the answer does not change.
      const inHome = { type: "relation_path_contains", path, value: home.id };
      expect(
        await facets({
          databaseId: tasks.id,
          filter: { type: "and", nodes: [flagged, inHome] },
          facets: [{ path }],
          extra: { open },
        }),
      ).toEqual(expected);
      // A checkbox and a date facet count the open tasks too. The flag condition is the checkbox facet's own, so
      // the fifth task counts there; no task has a date.
      expect(
        await facets({ databaseId: tasks.id, filter: flagged, facets: ["flagged", "date"], extra: { open } }),
      ).toEqual([
        {
          property: "flagged",
          all: 5,
          open: 4,
          values: [
            { value: true, count: 4 },
            { value: false, count: 1 },
          ],
        },
        { property: "date", all: 4, open: 3, values: [{ value: null, count: 4 }] },
      ]);
      expect(
        await facets({ databaseId: tasks.id, filter: { type: "and", nodes: [flagged, inHome] }, facets: ["flagged"] }),
      ).toEqual([
        {
          property: "flagged",
          all: 1,
          values: [
            { value: true, count: 1 },
            { value: false, count: 0 },
          ],
        },
      ]);
    }));

  it("refuses a condition on the facet itself inside or and inside not on filter, and accepts the same filter for another facet", () =>
    runInTenant(tenant, async () => {
      const tasks = await database("tasks");
      await make("tasks", { name: "Call", status: "done" });
      const done = { type: "equals", property: "status", value: "done" };
      const flagged = { type: "equals", property: "flagged", value: true };
      const path: [string, string] = ["project", "company"];
      const inCompany = { type: "relation_path_contains", path, value: randomUUID() };
      const refusedCases: Array<{ filter: unknown; facet: string | { path: [string, string] } }> = [
        { filter: { type: "or", nodes: [done, flagged] }, facet: "status" },
        { filter: { type: "not", node: done }, facet: "status" },
        {
          filter: { type: "and", nodes: [flagged, { type: "not", node: { type: "and", nodes: [done] } }] },
          facet: "status",
        },
        { filter: { type: "or", nodes: [inCompany, flagged] }, facet: { path } },
        { filter: { type: "not", node: inCompany }, facet: { path } },
      ];
      for (const { filter, facet } of refusedCases) {
        const refused = facets({ databaseId: tasks.id, filter, facets: ["date", facet] });
        await expect(refused, JSON.stringify(filter)).rejects.toBeInstanceOf(ValidationError);
        await expect(refused, JSON.stringify(filter)).rejects.toMatchObject({
          status: 400,
          code: "validation_failed",
          details: { field: "filter" },
        });
      }

      const [underOr] = await facets({
        databaseId: tasks.id,
        filter: { type: "or", nodes: [done, flagged] },
        facets: ["notifications"],
      });
      expect(underOr).toMatchObject({ property: "notifications", all: 1 });
      const [underNot] = await facets({
        databaseId: tasks.id,
        filter: { type: "not", node: done },
        facets: ["notifications"],
      });
      expect(underNot).toMatchObject({ property: "notifications", all: 0 });
      // A path condition is not a condition on the property facet of its first relation.
      const [pathUnderOr] = await facets({
        databaseId: tasks.id,
        filter: { type: "or", nodes: [inCompany, done] },
        facets: ["project"],
      });
      expect(pathUnderOr).toMatchObject({ property: "project", all: 1 });
    }));

  it("lists each relative-date preset an item matches and none that counts 0, and no date only when an item has none", () =>
    runInTenant(tenant, async () => {
      const board = await cp.createDatabase({ name: "Board" });
      await cp.createProperty({ databaseId: board.id, key: "due", name: "Due", type: "date" });
      const now = new Date("2026-10-22T10:00:00.000Z");
      for (const due of ["2026-10-22", "2026-10-23", "2026-09-01"]) {
        await cp.createItem({ databaseId: board.id, properties: { due } });
      }
      const dated = [
        { value: "today", count: 1 },
        { value: "tomorrow", count: 1 },
        { value: "thisWeek", count: 2 },
        { value: "thisMonth", count: 2 },
        { value: "upcoming", count: 2 },
        { value: "past", count: 1 },
        { value: "onOrBeforeToday", count: 2 },
        { value: "last7", count: 1 },
        { value: "last30", count: 1 },
        { value: "thisYear", count: 3 },
        { value: "olderThan30", count: 1 },
        { value: "beforeNow", count: 1 },
      ];

      expect(await facets({ databaseId: board.id, facets: ["due"] }, { now })).toEqual([
        { property: "due", all: 3, values: dated },
      ]);
      // A custom range on the date is the facet's own condition: it is left out and gets no entry.
      const custom = { type: "date_relative", property: "due", preset: { fromDays: 0, toDays: 0 } };
      expect(await facets({ databaseId: board.id, filter: custom, facets: ["due"] }, { now })).toEqual([
        { property: "due", all: 3, values: dated },
      ]);

      await cp.createItem({ databaseId: board.id, properties: {} });
      expect(await facets({ databaseId: board.id, facets: ["due"] }, { now })).toEqual([
        { property: "due", all: 4, values: [...dated, { value: null, count: 1 }] },
      ]);
    }));

  it("lists no target of an archived database and counts the items linked only there without a value", () =>
    runInTenant(tenant, async () => {
      const source = await cp.createDatabase({ name: "Source" });
      const target = await cp.createDatabase({ name: "Target" });
      const other = await cp.createDatabase({ name: "Other target" });
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
      const targetItem = await cp.createItem({ databaseId: target.id, properties: {} });
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
      const request = { databaseId: source.id, facets: ["targets", "others"] };
      const untouched = {
        property: "others",
        all: 3,
        values: [
          { value: otherItem.id, label: "", count: 1 },
          { value: null, count: 2 },
        ],
      };
      const live = [
        {
          property: "targets",
          all: 3,
          values: [
            { value: targetItem.id, label: "", count: 2 },
            { value: null, count: 1 },
          ],
        },
        untouched,
      ];

      expect(await facets(request)).toEqual(live);
      await cp.archiveDatabase(target.id);
      expect(await facets(request)).toEqual([
        { property: "targets", all: 3, values: [{ value: null, count: 3 }] },
        untouched,
      ]);
      await cp.restoreDatabase(target.id);
      expect(await facets(request)).toEqual(live);
    }));

  it("leaves out of a path facet the items reached through an archived database or ending in one", () =>
    runInTenant(tenant, async () => {
      const source = await cp.createDatabase({ name: "Source" });
      const between = await cp.createDatabase({ name: "Between" });
      const reached = await cp.createDatabase({ name: "Reached" });
      const { property: toBetween } = await cp.createRelationProperty({
        sourceDatabaseId: source.id,
        key: "between",
        name: "Between",
        targetDatabaseId: between.id,
      });
      const { property: toReached } = await cp.createRelationProperty({
        sourceDatabaseId: between.id,
        key: "reached",
        name: "Reached",
        targetDatabaseId: reached.id,
      });
      const reachedItem = await cp.createItem({ databaseId: reached.id, properties: {} });
      const betweenItem = await cp.createItem({ databaseId: between.id, properties: {} });
      const item = await cp.createItem({ databaseId: source.id, properties: {} });
      await cp.createRelation({
        relationPropertyId: toBetween.id,
        callerItemId: item.id,
        targetItemId: betweenItem.id,
      });
      await cp.createRelation({
        relationPropertyId: toReached.id,
        callerItemId: betweenItem.id,
        targetItemId: reachedItem.id,
      });
      const path: [string, string] = ["between", "reached"];
      const request = { databaseId: source.id, facets: [{ path }] };
      const live = [
        {
          path,
          all: 1,
          values: [
            { value: reachedItem.id, label: "", count: 1 },
            { value: null, count: 0 },
          ],
        },
      ];
      const none = [{ path, all: 1, values: [{ value: null, count: 1 }] }];

      expect(await facets(request)).toEqual(live);
      await cp.archiveDatabase(between.id);
      expect(await facets(request)).toEqual(none);
      await cp.restoreDatabase(between.id);
      await cp.archiveDatabase(reached.id);
      expect(await facets(request)).toEqual(none);
      await cp.restoreDatabase(reached.id);
      expect(await facets(request)).toEqual(live);
      // An item in between that is in the trash reaches nothing either.
      await cp.softDeleteItem(between.id, betweenItem.id);
      expect(await facets(request)).toEqual(none);
    }));

  it("counts 0 everywhere for an archived database, and the same as before once it is restored", () =>
    runInTenant(tenant, async () => {
      const board = await cp.createDatabase({ name: "Board" });
      const target = await cp.createDatabase({ name: "Target" });
      await cp.createProperty({
        databaseId: board.id,
        key: "status",
        name: "Status",
        type: "select",
        config: { options: [{ key: "open" }, { key: "closed" }] },
      });
      await cp.createProperty({ databaseId: board.id, key: "urgent", name: "Urgent", type: "checkbox" });
      await cp.createProperty({ databaseId: board.id, key: "who", name: "Who", type: "text" });
      await cp.createProperty({ databaseId: board.id, key: "due", name: "Due", type: "date" });
      const { property: targets } = await cp.createRelationProperty({
        sourceDatabaseId: board.id,
        key: "targets",
        name: "Targets",
        targetDatabaseId: target.id,
      });
      const targetItem = await cp.createItem({ databaseId: target.id, properties: {} });
      const item = await cp.createItem({
        databaseId: board.id,
        properties: { status: "open", urgent: true, who: "Ada", due: "2026-10-22" },
      });
      await cp.createRelation({ relationPropertyId: targets.id, callerItemId: item.id, targetItemId: targetItem.id });
      const request = {
        databaseId: board.id,
        facets: ["status", "urgent", "who", "due", "targets"],
        extra: { open: { type: "equals", property: "status", value: "open" } },
      };
      const now = new Date("2026-10-22T10:00:00.000Z");

      const live = await facets(request, { now });
      expect(live.map((facet) => [facet.all, facet.open])).toEqual(Array.from({ length: 5 }, () => [1, 1]));

      await cp.archiveDatabase(board.id);
      expect(await facets(request, { now })).toEqual([
        {
          property: "status",
          all: 0,
          open: 0,
          values: [
            { value: "open", label: "open", count: 0 },
            { value: "closed", label: "closed", count: 0 },
            { value: null, count: 0 },
          ],
        },
        {
          property: "urgent",
          all: 0,
          open: 0,
          values: [
            { value: true, count: 0 },
            { value: false, count: 0 },
          ],
        },
        { property: "who", all: 0, open: 0, values: [] },
        { property: "due", all: 0, open: 0, values: [] },
        { property: "targets", all: 0, open: 0, values: [{ value: null, count: 0 }] },
      ]);

      await cp.restoreDatabase(board.id);
      expect(await facets(request, { now })).toEqual(live);
    }));

  it("answers another tenant's database exactly as an unknown one", async () => {
    const otherTenant = await createTestTenant(admin);
    const foreign = await runInTenant(otherTenant, async () => {
      await seedSystem(pool);
      const tasks = await database("tasks");
      await make("tasks", { name: "Foreign task" });
      // The other tenant reads the facets of its own database, so the refusal below is not a missing row.
      const [own] = await facets({ databaseId: tasks.id, facets: ["status"] });
      expect(own?.all).toBe(1);
      return tasks.id;
    });

    await runInTenant(tenant, async () => {
      const unknown = randomUUID();
      const path: [string, string] = ["project", "company"];
      const requests: Array<Omit<DatabaseFacetsInput, "databaseId">> = [
        { facets: ["status"] },
        { facets: ["project", { path }], filter: { type: "equals", property: "status", value: "done" } },
        { facets: ["missing"] },
      ];
      for (const request of requests) {
        expect(await notFoundAnswer(foreign, { databaseId: foreign, ...request })).toEqual(
          await notFoundAnswer(unknown, { databaseId: unknown, ...request }),
        );
      }
      expect(await notFoundAnswer(foreign, { databaseId: foreign, facets: ["status"] })).toEqual({
        status: 404,
        code: "not_found",
        message: "Database <id> not found",
        details: JSON.stringify({ resource: "database", databaseId: "<id>" }),
      });
    });
  });

  it("lists the companies and the projects of the caller's tenant only", async () => {
    const otherTenant = await createTestTenant(admin);
    const foreign = await runInTenant(otherTenant, async () => {
      await seedSystem(pool);
      const company = await make("companies", { name: "Foreign company" });
      const project = await make("projects", { name: "Foreign project" });
      await link(project, "company", company);
      const task = await make("tasks", { name: "Foreign task" });
      await link(task, "project", project);
      return { company, project };
    });

    await runInTenant(tenant, async () => {
      const tasks = await database("tasks");
      const work = await make("companies", { name: "Work" });
      const launch = await make("projects", { name: "Launch" });
      await link(launch, "company", work);
      await link(await make("tasks", { name: "Announce" }), "project", launch);

      const answer = await facets({ databaseId: tasks.id, facets: ["project", { path: ["project", "company"] }] });

      expect(answer).toEqual([
        {
          property: "project",
          all: 1,
          values: [
            { value: launch.id, label: "Launch", count: 1 },
            { value: null, count: 0 },
          ],
        },
        {
          path: ["project", "company"],
          all: 1,
          values: [
            { value: work.id, label: "Work", count: 1 },
            { value: null, count: 0 },
          ],
        },
      ]);
      const text = JSON.stringify(answer);
      for (const id of [foreign.company.id, foreign.project.id]) expect(text).not.toContain(id);
    });
  });

  it("lists only the options a select that is not status-like holds, then other stored values, then the items without one", () =>
    runInTenant(tenant, async () => {
      const gifts = await cp.createDatabase({ name: "Gifts" });
      await cp.createProperty({
        databaseId: gifts.id,
        key: "stage",
        name: "Stage",
        type: "select",
        config: { options: [{ key: "idea", label: "Idea", color: "#FF9500" }, { key: "bought" }, { key: "wrapped" }] },
      });
      const stages: unknown[] = ["bought", "zeta", "idea", "bought", "alpha", "", null, undefined];
      for (const stage of stages) {
        await cp.createItem({ databaseId: gifts.id, properties: stage === undefined ? {} : { stage } });
      }
      const trashed = await cp.createItem({ databaseId: gifts.id, properties: { stage: "idea" } });
      await cp.softDeleteItem(gifts.id, trashed.id);

      expect(await facets({ databaseId: gifts.id, facets: ["stage"] })).toEqual([
        {
          property: "stage",
          all: stages.length,
          values: [
            { value: "idea", label: "Idea", color: "#FF9500", count: 1 },
            // An option without a stored label in a database without a catalog is labelled by its key.
            { value: "bought", label: "bought", count: 2 },
            { value: "alpha", count: 1 },
            { value: "zeta", count: 1 },
            { value: null, count: 3 },
          ],
        },
      ]);
    }));

  it("lists every option of a status-like select of a user database, and other stored values after them", () =>
    runInTenant(tenant, async () => {
      const board = await cp.createDatabase({ name: "Board" });
      for (const key of ["status", "type", "relationship"]) {
        await cp.createProperty({
          databaseId: board.id,
          key,
          name: key,
          type: "select",
          config: { options: [{ key: "first" }, { key: "second" }] },
        });
      }
      await cp.createItem({ databaseId: board.id, properties: { status: "second", type: "gone", relationship: "" } });

      expect(await facets({ databaseId: board.id, facets: ["status", "type", "relationship"] })).toEqual([
        {
          property: "status",
          all: 1,
          values: [
            { value: "first", label: "first", count: 0 },
            { value: "second", label: "second", count: 1 },
            { value: null, count: 0 },
          ],
        },
        {
          property: "type",
          all: 1,
          values: [
            { value: "first", label: "first", count: 0 },
            { value: "second", label: "second", count: 0 },
            { value: "gone", count: 1 },
            { value: null, count: 0 },
          ],
        },
        {
          property: "relationship",
          all: 1,
          values: [
            { value: "first", label: "first", count: 0 },
            { value: "second", label: "second", count: 0 },
            { value: null, count: 1 },
          ],
        },
      ]);
    }));

  it("counts a multi-select item in each of its options and once in all, and lists only options that occur", () =>
    runInTenant(tenant, async () => {
      const gifts = await cp.createDatabase({ name: "Gifts" });
      await cp.createProperty({
        databaseId: gifts.id,
        // A status-like key lists every option only on a select, not on a multi-select.
        key: "type",
        name: "Type",
        type: "multi_select",
        config: { options: [{ key: "toy" }, { key: "book", label: "Book", color: "#007AFF" }, { key: "game" }] },
      });
      const stored: unknown[] = [["book", "toy"], ["book"], ["book", "book"], ["other"], [], undefined];
      for (const type of stored) {
        await cp.createItem({ databaseId: gifts.id, properties: type === undefined ? {} : { type } });
      }

      expect(await facets({ databaseId: gifts.id, facets: ["type"] })).toEqual([
        {
          property: "type",
          all: stored.length,
          values: [
            { value: "toy", label: "toy", count: 1 },
            { value: "book", label: "Book", color: "#007AFF", count: 3 },
            { value: "other", count: 1 },
            { value: null, count: 2 },
          ],
        },
      ]);
    }));

  it("lists the twenty most frequent texts, the most frequent first and equal counts in byte order", () =>
    runInTenant(tenant, async () => {
      const gifts = await cp.createDatabase({ name: "Gifts" });
      await cp.createProperty({ databaseId: gifts.id, key: "who", name: "Who", type: "text" });
      const names = Array.from({ length: 22 }, (_, index) => `v${String(index + 1).padStart(2, "0")}`);
      const stored: unknown[] = [...names, "v07", "v07", "v03", "", undefined];
      for (const who of stored) {
        await cp.createItem({ databaseId: gifts.id, properties: who === undefined ? {} : { who } });
      }

      const [answer] = await facets({ databaseId: gifts.id, facets: ["who"] });

      const singles = names.filter((name) => name !== "v07" && name !== "v03");
      expect(answer).toEqual({
        property: "who",
        all: stored.length,
        values: [
          { value: "v07", count: 3 },
          { value: "v03", count: 2 },
          // 18 of the 20 texts stored once; `v21` and `v22` are beyond the twenty.
          ...singles.slice(0, 18).map((value) => ({ value, count: 1 })),
        ],
      });
      expect(answer?.values).toHaveLength(20);
    }));

  it("returns true and false for a checkbox, with the items without a value under false", () =>
    runInTenant(tenant, async () => {
      const gifts = await cp.createDatabase({ name: "Gifts" });
      await cp.createProperty({ databaseId: gifts.id, key: "wrapped", name: "Wrapped", type: "checkbox" });
      for (const wrapped of [true, true, false, null, undefined]) {
        await cp.createItem({ databaseId: gifts.id, properties: wrapped === undefined ? {} : { wrapped } });
      }

      expect(
        await facets({
          databaseId: gifts.id,
          filter: { type: "equals", property: "wrapped", value: true },
          facets: ["wrapped"],
        }),
      ).toEqual([
        {
          property: "wrapped",
          all: 5,
          values: [
            { value: true, count: 2 },
            { value: false, count: 3 },
          ],
        },
      ]);
    }));

  it("counts each stored number preset by its comparison and the empty preset with or without zero", () =>
    runInTenant(tenant, async () => {
      const gifts = await cp.createDatabase({ name: "Gifts" });
      await cp.createProperty({
        databaseId: gifts.id,
        key: "price",
        name: "Price",
        type: "number",
        config: {
          filterPresets: [
            { value: 100, op: "lte", labelKey: "price.low", label: "Up to 100" },
            { value: 500, op: "gte", labelKey: "price.high" },
            { value: 5000, op: "gte", labelKey: "price.top", label: "Luxury" },
          ],
          emptyPreset: { labelKey: "price.none", label: "No price", matchZero: true },
        },
      });
      await cp.createProperty({
        databaseId: gifts.id,
        key: "weight",
        name: "Weight",
        type: "number",
        config: {
          filterPresets: [{ value: 1, op: "gte", labelKey: "weight.any", label: "Weighed" }],
          emptyPreset: { labelKey: "weight.none", label: "Not weighed", matchZero: false },
        },
      });
      await cp.createProperty({
        databaseId: gifts.id,
        key: "height",
        name: "Height",
        type: "number",
        config: { filterPresets: [{ value: 10, op: "lte", labelKey: "height.low", label: "Low" }] },
      });
      await cp.createProperty({ databaseId: gifts.id, key: "plain", name: "Plain", type: "number" });
      for (const price of [50, 100, 300, 500, 900, 0, undefined]) {
        await cp.createItem({
          databaseId: gifts.id,
          properties: price === undefined ? {} : { price, weight: price, height: price, plain: price },
        });
      }

      expect(await facets({ databaseId: gifts.id, facets: ["price", "weight", "height", "plain"] })).toEqual([
        {
          property: "price",
          all: 7,
          values: [
            { value: 100, label: "Up to 100", count: 3 },
            // A preset without a stored label in a database without a catalog is labelled by its label key.
            { value: 500, label: "price.high", count: 2 },
            { value: 5000, label: "Luxury", count: 0 },
            { value: null, label: "No price", count: 2 },
          ],
        },
        {
          property: "weight",
          all: 7,
          values: [
            { value: 1, label: "Weighed", count: 5 },
            { value: null, label: "Not weighed", count: 1 },
          ],
        },
        // Without a stored empty preset there is no choice for the items without a value.
        { property: "height", all: 7, values: [{ value: 10, label: "Low", count: 1 }] },
        { property: "plain", all: 7, values: [] },
      ]);

      const [withOpen] = await facets({
        databaseId: gifts.id,
        facets: ["height"],
        extra: { open: { type: "gte", property: "price", value: 300 } },
      });
      expect(withOpen).toEqual({
        property: "height",
        all: 7,
        open: 3,
        values: [{ value: 10, label: "Low", count: 1 }],
      });
    }));

  it("lists the twenty related items most items have, counts an item in each of its targets, and takes label and color from the target", () =>
    runInTenant(tenant, async () => {
      const gifts = await cp.createDatabase({ name: "Gifts" });
      const projects = await database("projects");
      const { property: forProject } = await cp.createRelationProperty({
        sourceDatabaseId: gifts.id,
        key: "project",
        name: "Project",
        targetDatabaseId: projects.id,
      });
      const targets: ItemRow[] = [];
      for (let index = 0; index < 22; index += 1) {
        targets.push(
          await make("projects", { name: `Project ${index}`, ...(index === 0 ? { color: "#AF52DE" } : {}) }),
        );
      }
      const first = targets[0];
      const second = targets[1];
      if (!first || !second) throw new Error("Expected the created projects");
      for (const target of targets) {
        const gift = await cp.createItem({ databaseId: gifts.id, properties: {} });
        await cp.createRelation({ relationPropertyId: forProject.id, callerItemId: gift.id, targetItemId: target.id });
      }
      const shared = await cp.createItem({ databaseId: gifts.id, properties: {} });
      for (const target of [first, second]) {
        await cp.createRelation({
          relationPropertyId: forProject.id,
          callerItemId: shared.id,
          targetItemId: target.id,
        });
      }
      await cp.createItem({ databaseId: gifts.id, properties: {} });

      const [answer] = await facets({ databaseId: gifts.id, facets: ["project"] });

      const others = byCountThenId(
        targets.slice(2).map((target) => ({ value: target.id, label: String(target.properties.name), count: 1 })),
      );
      expect(answer).toEqual({
        property: "project",
        all: 24,
        values: [
          ...byCountThenId([
            { value: first.id, label: "Project 0", color: "#AF52DE", count: 2 },
            { value: second.id, label: "Project 1", count: 2 },
          ]),
          // 18 of the 20 projects one gift has; a project no gift has is not listed.
          ...others.slice(0, 18),
          { value: null, count: 1 },
        ],
      });
    }));

  it("lists no company at all while the database of the companies is archived", () =>
    runInTenant(tenant, async () => {
      const tasks = await database("tasks");
      const companies = await database("companies");
      const work = await make("companies", { name: "Work" });
      const launch = await make("projects", { name: "Launch" });
      await link(launch, "company", work);
      await link(await make("tasks", { name: "Announce" }), "project", launch);
      const path: [string, string] = ["project", "company"];
      const request = { databaseId: tasks.id, facets: [{ path }] };
      const [live] = await facets(request);
      expect(live?.values.map((choice) => choice.count)).toEqual([1, 0]);

      // Raw SQL: archiving a system database is not a production write.
      const archived = await withTransaction(pool, (client) =>
        client.query("UPDATE databases SET archived_at = now() WHERE id = $1", [companies.id]),
      );
      expect(archived.rowCount).toBe(1);

      expect(await facets(request)).toEqual([{ path, all: 1, values: [{ value: null, count: 1 }] }]);
    }));

  it("lists only occurring items for a relation of a system database, without a color the target does not have", () =>
    runInTenant(tenant, async () => {
      const people = await database("people");
      const acme = await make("companies", { name: "Acme" });
      await make("companies", { name: "Unused" });
      await link(await make("people", { name: "Ada" }), "companies", acme);
      await make("people", { name: "Bob" });

      expect(await facets({ databaseId: people.id, facets: ["companies"] })).toEqual([
        {
          property: "companies",
          all: 2,
          values: [
            { value: acme.id, label: "Acme", count: 1 },
            { value: null, count: 1 },
          ],
        },
      ]);
    }));

  it("returns a related item's own color only when it is #RRGGBB", () =>
    runInTenant(tenant, async () => {
      const gifts = await cp.createDatabase({ name: "Gifts" });
      const shops = await cp.createDatabase({ name: "Shops" });
      await cp.createProperty({ databaseId: shops.id, key: "label", name: "Label", type: "title" });
      await cp.createProperty({ databaseId: shops.id, key: "color", name: "Color", type: "text" });
      const { property: shop } = await cp.createRelationProperty({
        sourceDatabaseId: gifts.id,
        key: "shop",
        name: "Shop",
        targetDatabaseId: shops.id,
      });
      const shopItems: ItemRow[] = [];
      for (const properties of [{ label: "Hex", color: "#a1B2c3" }, { label: "Named", color: "red" }, {}]) {
        const item = await cp.createItem({ databaseId: shops.id, properties });
        shopItems.push(item);
        const gift = await cp.createItem({ databaseId: gifts.id, properties: {} });
        await cp.createRelation({ relationPropertyId: shop.id, callerItemId: gift.id, targetItemId: item.id });
      }
      const [hex, named, bare] = shopItems;
      if (!hex || !named || !bare) throw new Error("Expected the created shops");

      expect(await facets({ databaseId: gifts.id, facets: ["shop"] })).toEqual([
        {
          property: "shop",
          all: 3,
          values: [
            ...byCountThenId([
              { value: hex.id, label: "Hex", color: "#a1B2c3", count: 1 },
              { value: named.id, label: "Named", count: 1 },
              { value: bare.id, label: "", count: 1 },
            ]),
            { value: null, count: 0 },
          ],
        },
      ]);
    }));

  it("labels options and presets from the catalog in the caller's language, and keeps a stored label in every language", () =>
    runInTenant(tenant, async () => {
      const projects = await database("projects");
      const books = await database("books");
      const status = (await cp.listProperties(projects.id)).find((candidate) => candidate.key === "status");
      if (!status) throw new Error("Missing the Projects status property");
      const added = await cp.addPropertyOption(status.id, { label: "Paused", color: "#FF9500" });
      const user = { type: "is_empty", property: "systemActive" };
      const czech = [
        { value: "inProgress", label: "Probíhá", color: "#007AFF", count: 0 },
        { value: "longTerm", label: "Dlouhodobé", color: "#AF52DE", count: 0 },
        { value: "done", label: "Hotovo", color: "#34C759", count: 0 },
        { value: "archived", label: "Archivováno", color: "#8E8E93", count: 0 },
      ];
      const paused = { value: added.key, label: "Paused", color: "#FF9500", count: 0 };

      expect(await facets({ databaseId: projects.id, filter: user, facets: ["status"] }, { locale: "cs" })).toEqual([
        { property: "status", all: 0, values: [...czech, paused, { value: null, count: 0 }] },
      ]);
      // English is the language of a call without a locale and of a locale the catalogs do not have.
      for (const options of [undefined, {}, { locale: "en" }, { locale: "de" }]) {
        expect(await facets({ databaseId: projects.id, filter: user, facets: ["status"] }, options)).toEqual([
          { property: "status", all: 0, values: [...projectStatuses([0, 0, 0, 0]), paused, { value: null, count: 0 }] },
        ]);
      }

      expect(await facets({ databaseId: books.id, facets: ["rating"] }, { locale: "cs" })).toEqual([
        {
          property: "rating",
          all: 0,
          values: [
            { value: 5, label: "5 hvězd", count: 0 },
            { value: 4, label: "4 a víc", count: 0 },
            { value: 3, label: "3 a víc", count: 0 },
            { value: null, label: "Bez hodnocení", count: 0 },
          ],
        },
      ]);
    }));

  it("refuses an unknown key, a property that cannot be a facet and an unresolvable relation or path on facets", () =>
    runInTenant(tenant, async () => {
      const source = await cp.createDatabase({ name: "Source" });
      const target = await cp.createDatabase({ name: "Target" });
      await cp.createProperty({ databaseId: source.id, key: "note", name: "Note", type: "longText" });
      await cp.createProperty({ databaseId: source.id, key: "link", name: "Link", type: "url" });
      await cp.createProperty({ databaseId: target.id, key: "plain", name: "Plain", type: "text" });
      await cp.createRelationProperty({
        sourceDatabaseId: source.id,
        key: "targets",
        name: "Targets",
        targetDatabaseId: target.id,
      });
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

      const refusedFacets: Array<string | { path: [string, string] }> = [
        "missing",
        "note",
        "link",
        "broken",
        { path: ["note", "targets"] },
        { path: ["missing", "targets"] },
        { path: ["broken", "plain"] },
        { path: ["targets", "plain"] },
        { path: ["targets", "missing"] },
      ];
      for (const facet of refusedFacets) {
        const refused = facets({ databaseId: source.id, facets: ["targets", facet] });
        await expect(refused, JSON.stringify(facet)).rejects.toBeInstanceOf(ValidationError);
        await expect(refused, JSON.stringify(facet)).rejects.toMatchObject({
          status: 400,
          code: "validation_failed",
          details: { field: "facets" },
        });
      }
      // The relation that every refused call asked for next to the refused facet is itself a facet.
      expect(await facets({ databaseId: source.id, facets: ["targets"] })).toEqual([
        { property: "targets", all: 0, values: [{ value: null, count: 0 }] },
      ]);
    }));

  it("refuses the filters a database query refuses, naming the same field, and a malformed open filter on extra.open", () =>
    runInTenant(tenant, async () => {
      const tasks = await database("tasks");
      const malformed = facets({ databaseId: tasks.id, filter: { type: "unknown" }, facets: ["status"] });
      await expect(malformed).rejects.toBeInstanceOf(ValidationError);
      await expect(malformed).rejects.toMatchObject({ details: { field: "filter" } });
      const unknownProperty = { type: "equals", property: "nope", value: "x" };
      const refused = facets({ databaseId: tasks.id, filter: unknownProperty, facets: ["status"] });
      await expect(refused).rejects.toBeInstanceOf(ValidationError);
      await expect(refused).rejects.toMatchObject({ details: { field: "nope" } });
      await expect(cp.queryDatabaseItems(tasks.id, { filter: unknownProperty })).rejects.toMatchObject({
        details: { field: "nope" },
      });

      const malformedOpen = facets({ databaseId: tasks.id, facets: ["status"], extra: { open: { type: "unknown" } } });
      await expect(malformedOpen).rejects.toBeInstanceOf(ValidationError);
      await expect(malformedOpen).rejects.toMatchObject({ status: 400, details: { field: "extra.open" } });
      // The open filter is compiled as the filter is: an unknown property in it is refused on that property.
      const unknownOpen = facets({ databaseId: tasks.id, facets: ["status"], extra: { open: unknownProperty } });
      await expect(unknownOpen).rejects.toMatchObject({ status: 400, details: { field: "nope" } });
    }));

  it("counts every facet with one statement over the items of the database", async () => {
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
    const observed = await createRuntimeRolePool(admin, "alldots_data");
    try {
      await runInTenant(tenant, async () => {
        const tasks = await database("tasks");
        await make("tasks", { name: "Call", status: "notDone", date: "2026-10-22" });
        observed.on("acquire", record);

        const requested: Array<string | { path: [string, string] }> = [
          "status",
          "project",
          { path: ["project", "company"] },
          "date",
          "flagged",
          "seriesId",
        ];
        const answer = await createChokePoint(observed).getDatabaseFacets({
          databaseId: tasks.id,
          filter: { type: "is_not_empty", property: "name" },
          facets: requested,
          extra: { open: { type: "equals", property: "status", value: "notDone" } },
        });

        expect(answer.map((facet) => [facet.all, facet.open])).toEqual(requested.map(() => [1, 1]));
        // Every counting statement, and no other one, reads the faceted database under this alias.
        expect(statements.filter((sql) => /\bdatabases faceted\b/.test(sql))).toHaveLength(requested.length);
        expect(
          statements.filter((sql) => /\bitems\.database_id = \$1\b/.test(sql) && !/\bdatabases faceted\b/.test(sql)),
        ).toEqual([]);
      });
    } finally {
      observed.off("acquire", record);
      for (const [client, query] of originals) client.query = query;
      await observed.end();
    }
  });
});
