import "../domainWriteHooks.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { createPool, withTransaction } from "../db/pool.js";
import { getDerivedValuesForItems } from "../derived/derivedValueReads.js";
import { ensureJournalPeriodDoc } from "../journal/journalStore.js";
import type { ItemRow } from "../types.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createTestTenant, getTenantZeroId, getTestPool, resetDatabase } from "../testSupport/testDb.js";

let admin: Pool;
let data: Pool;
let tenant: string;
let foreign: string;

async function database(moduleId: string): Promise<string> {
  const { rows } = await data.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Missing ${moduleId} database`);
  return rows[0].id;
}

async function link(databaseId: string, key: string, from: string, to: string): Promise<void> {
  const cp = createChokePoint(data);
  const property = (await cp.listProperties(databaseId)).find((entry) => entry.key === key);
  if (!property) throw new Error(`Missing relation ${key}`);
  await cp.createRelation({ relationPropertyId: property.id, callerItemId: from, targetItemId: to });
}

describe("derived values through project relations", () => {
  beforeAll(async () => {
    admin = getTestPool();
    data = createPool(process.env.TEST_DATABASE_URL ?? "", { role: "semprec_data" });
    const result = await runAsSystem("verify derived read test role", () =>
      data.query<{ role_name: string; rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT current_user::text AS role_name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(result.rows).toEqual([{ role_name: "semprec_data", rolsuper: false, rolbypassrls: false }]);
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = getTenantZeroId();
    foreign = await createTestTenant(admin);
    for (const id of [tenant, foreign]) await runInTenant(id, () => seedSystem(data, createViewTypeRegistry()));
  });
  afterAll(async () => {
    await data.end();
    await admin.end();
  });

  it("deduplicates project areas, reads changes and excludes trashed projects", async () => {
    await runInTenant(tenant, async () => {
      const cp = createChokePoint(data);
      const areas = await database("areas");
      const projects = await database("projects");
      const files = await database("files");
      const tasks = await database("tasks");
      const events = await database("events");
      const work = await cp.createItem({
        databaseId: areas,
        properties: { name: "Work", color: "#5856D6", icon: "briefcase" },
      });
      const home = await cp.createItem({ databaseId: areas, properties: { name: "Home" } });
      const first = await cp.createItem({ databaseId: projects, properties: { name: "Web" } });
      const second = await cp.createItem({ databaseId: projects, properties: { name: "iOS" } });
      const file = await cp.createItem({ databaseId: files, properties: { name: "Brief" } });
      const task = await cp.createItem({ databaseId: tasks, properties: { name: "Task" } });
      const event = await cp.createItem({ databaseId: events, properties: { name: "Event", date: "2026-10-16" } });
      await link(files, "area", file.id, home.id);
      await link(projects, "area", first.id, work.id);
      await link(projects, "area", second.id, work.id);
      await link(files, "projects", file.id, first.id);
      await link(files, "projects", file.id, second.id);
      await link(tasks, "project", task.id, second.id);
      await link(events, "project", event.id, second.id);
      const beforeVersions = [file.updatedAt, task.updatedAt, event.updatedAt];
      const read = async () => (await cp.getDerivedValuesForItems([file.id])).get(file.id);
      expect((await read())?.area).toEqual({
        values: [{ id: work.id, title: "Work", color: "#5856D6", icon: "briefcase" }],
        via: "project",
        projectIds: [first.id, second.id].sort(),
      });
      expect(
        (await cp.listItemRelations(file.id))?.some(
          (entry) => entry.propertyKey === "area" && entry.targetItemId === home.id,
        ),
      ).toBe(true);
      expect((await cp.getValueLinksForItems([file.id])).get(file.id)?.area).toBeUndefined();
      expect((await cp.getValueLinksForItems([file.id], true)).get(file.id)?.area).toMatchObject({
        valueKind: "derived",
        brokenBy: null,
        brokenAt: null,
        sources: expect.arrayContaining([
          { kind: "item", itemId: first.id, databaseKey: "projects", title: "Web", propertyKey: "area" },
          { kind: "item", itemId: second.id, databaseKey: "projects", title: "iOS", propertyKey: "area" },
        ]),
      });
      const property = (await cp.listProperties(projects)).find((p) => p.key === "area");
      if (!property) throw new Error("Missing area relation");
      await cp.setRelation({ relationPropertyId: property.id, callerItemId: second.id, targetItemId: home.id });
      expect((await read())?.area?.values.map((value) => value.id)).toEqual([home.id, work.id]);
      const changed = await cp.getDerivedValuesForItems([task.id, event.id, file.id]);
      expect(changed.get(task.id)?.area?.values.map((value) => value.id)).toEqual([home.id]);
      expect(changed.get(event.id)?.area?.values.map((value) => value.id)).toEqual([home.id]);
      expect(changed.get(file.id)?.area?.values.map((value) => value.id)).toEqual([home.id, work.id]);
      expect(
        (await Promise.all([file.id, task.id, event.id].map((id) => cp.findItem(id)))).map((item) => item?.updatedAt),
      ).toEqual(beforeVersions);
      await cp.softDeleteItem(projects, first.id);
      expect((await read())?.area?.values.map((value) => value.id)).toEqual([home.id]);
    });
  });

  it("derives Journal and task areas and event company, with no entry without a project", async () => {
    await runInTenant(tenant, async () => {
      const cp = createChokePoint(data);
      const areas = await database("areas"),
        projects = await database("projects"),
        companies = await database("companies"),
        tasks = await database("tasks"),
        journal = await database("journal"),
        events = await database("events");
      const area = await cp.createItem({ databaseId: areas, properties: { name: "Work" } });
      const company = await cp.createItem({ databaseId: companies, properties: { name: "Novak" } });
      const project = await cp.createItem({ databaseId: projects, properties: { name: "Web" } });
      await link(projects, "area", project.id, area.id);
      await link(projects, "company", project.id, company.id);
      const task = await cp.createItem({ databaseId: tasks, properties: { name: "Task" } });
      const day = await withTransaction(data, (client) => ensureJournalPeriodDoc(client, "day", "2026-10-16"));
      const event = await cp.createItem({ databaseId: events, properties: { name: "Event", date: "2026-10-16" } });
      const empty = await withTransaction(data, (client) => ensureJournalPeriodDoc(client, "day", "2026-10-17"));
      await link(tasks, "project", task.id, project.id);
      await link(journal, "project", day.itemId, project.id);
      await link(events, "project", event.id, project.id);
      const values = await cp.getDerivedValuesForItems([task.id, day.itemId, event.id, empty.itemId]);
      expect(values.get(task.id)?.area?.values[0]?.id).toBe(area.id);
      expect(values.get(day.itemId)?.area?.values[0]?.id).toBe(area.id);
      expect(values.get(event.id)?.company?.values).toEqual([{ id: company.id, title: "Novak" }]);
      expect(values.has(empty.itemId)).toBe(false);
      await cp.softDeleteItem(areas, area.id);
      await cp.softDeleteItem(companies, company.id);
      const afterTrash = await cp.getDerivedValuesForItems([task.id, day.itemId, event.id]);
      expect(afterTrash.has(task.id)).toBe(false);
      expect(afterTrash.has(day.itemId)).toBe(false);
      expect(afterTrash.has(event.id)).toBe(false);
    });
  });

  it("omits a project without an area and never resolves another tenant's item", async () => {
    let foreignId = "";
    await runInTenant(foreign, async () => {
      const cp = createChokePoint(data);
      const tasks = await database("tasks");
      foreignId = (await cp.createItem({ databaseId: tasks, properties: { name: "Foreign" } })).id;
    });
    await runInTenant(tenant, async () => {
      const cp = createChokePoint(data);
      const tasks = await database("tasks");
      const projects = await database("projects");
      const project = await cp.createItem({ databaseId: projects, properties: { name: "No area" } });
      const task = await cp.createItem({ databaseId: tasks, properties: { name: "Task" } });
      await link(tasks, "project", task.id, project.id);
      const values = await cp.getDerivedValuesForItems([task.id, foreignId]);
      expect(values.has(task.id)).toBe(false);
      expect(values.has(foreignId)).toBe(false);
    });
  });

  it("uses a constant number of statements for one or fifty items", async () => {
    await runInTenant(tenant, async () => {
      const cp = createChokePoint(data);
      const tasks = await database("tasks");
      const projects = await database("projects");
      const areas = await database("areas");
      const project = await cp.createItem({ databaseId: projects, properties: { name: "Project" } });
      const area = await cp.createItem({ databaseId: areas, properties: { name: "Area" } });
      await link(projects, "area", project.id, area.id);
      const items: ItemRow[] = [];
      for (let i = 0; i < 50; i++) {
        const item = await cp.createItem({ databaseId: tasks, properties: { name: `Task ${i}` } });
        await link(tasks, "project", item.id, project.id);
        items.push(item);
      }
      const count = (input: ItemRow[]) =>
        withTransaction(data, async (client) => {
          const spy = vi.spyOn(client, "query");
          try {
            const values = await getDerivedValuesForItems(client, input);
            expect(values.size).toBe(input.length);
            expect(
              spy.mock.calls.every(
                ([sql]) => typeof sql === "string" && !/^\s*(INSERT|UPDATE|DELETE|ALTER)\b/i.test(sql),
              ),
            ).toBe(true);
            return spy.mock.calls.length;
          } finally {
            spy.mockRestore();
          }
        });
      expect(await count(items)).toBe(await count(items.slice(0, 1)));
    });
  });

  it("keeps every contributor when one item has more than fifty projects", async () => {
    await runInTenant(tenant, async () => {
      const cp = createChokePoint(data);
      const files = await database("files");
      const projects = await database("projects");
      const areas = await database("areas");
      const area = await cp.createItem({ databaseId: areas, properties: { name: "Shared" } });
      const file = await cp.createItem({ databaseId: files, properties: { name: "File" } });
      const ids: string[] = [];
      for (let i = 0; i < 51; i++) {
        const project = await cp.createItem({ databaseId: projects, properties: { name: `Project ${i}` } });
        ids.push(project.id);
        await link(projects, "area", project.id, area.id);
        await link(files, "projects", file.id, project.id);
      }
      const derived = (await cp.getDerivedValuesForItems([file.id])).get(file.id);
      expect(derived?.area?.values).toEqual([{ id: area.id, title: "Shared", color: null, icon: null }]);
      expect(derived?.area?.projectIds).toEqual(ids.sort());
      const links = (await cp.getValueLinksForItems([file.id], true)).get(file.id);
      expect(links?.area?.sources).toHaveLength(51);
    });
  });
});
