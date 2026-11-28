import "../domainWriteHooks.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@alldots/shared";
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
    data = createPool(process.env.TEST_DATABASE_URL ?? "", { role: "alldots_data" });
    const result = await runAsSystem("verify derived read test role", () =>
      data.query<{ role_name: string; rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT current_user::text AS role_name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(result.rows).toEqual([{ role_name: "alldots_data", rolsuper: false, rolbypassrls: false }]);
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

  it("derives an Event's company through its project, reads changes and excludes a trashed project", async () => {
    await runInTenant(tenant, async () => {
      const cp = createChokePoint(data);
      const companies = await database("companies");
      const projects = await database("projects");
      const events = await database("events");
      const novak = await cp.createItem({ databaseId: companies, properties: { name: "Novak" } });
      const acme = await cp.createItem({ databaseId: companies, properties: { name: "Acme" } });
      const project = await cp.createItem({ databaseId: projects, properties: { name: "Web" } });
      const event = await cp.createItem({ databaseId: events, properties: { name: "Event", date: "2026-10-16" } });
      await link(projects, "company", project.id, novak.id);
      await link(events, "project", event.id, project.id);
      const before = await cp.findItem(event.id);
      const read = async () => (await cp.getDerivedValuesForItems([event.id])).get(event.id);
      expect(await read()).toEqual({
        company: { values: [{ id: novak.id, title: "Novak" }], via: "project", projectIds: [project.id] },
      });
      expect(
        (await cp.listItemRelations(event.id))?.some(
          (entry) => entry.propertyKey === "company" && entry.targetItemId === novak.id,
        ),
      ).toBe(false);
      expect((await cp.getValueLinksForItems([event.id])).get(event.id)?.company).toBeUndefined();
      expect((await cp.getValueLinksForItems([event.id], true)).get(event.id)?.company).toEqual({
        valueKind: "derived",
        brokenBy: null,
        brokenAt: null,
        sources: [{ kind: "item", itemId: project.id, databaseKey: "projects", title: "Web", propertyKey: "company" }],
      });
      const property = (await cp.listProperties(projects)).find((p) => p.key === "company");
      if (!property) throw new Error("Missing company relation");
      await cp.setRelation({ relationPropertyId: property.id, callerItemId: project.id, targetItemId: acme.id });
      expect((await read())?.company?.values).toEqual([{ id: acme.id, title: "Acme" }]);
      expect((await cp.findItem(event.id))?.updatedAt).toBe(before?.updatedAt);
      await cp.softDeleteItem(projects, project.id);
      expect(await read()).toBeUndefined();
    });
  });

  it("derives the company only for Events, and nothing for an Event without a project or a trashed company", async () => {
    await runInTenant(tenant, async () => {
      const cp = createChokePoint(data);
      const projects = await database("projects"),
        companies = await database("companies"),
        tasks = await database("tasks"),
        files = await database("files"),
        journal = await database("journal"),
        events = await database("events");
      const company = await cp.createItem({ databaseId: companies, properties: { name: "Novak" } });
      const project = await cp.createItem({ databaseId: projects, properties: { name: "Web" } });
      await link(projects, "company", project.id, company.id);
      const task = await cp.createItem({ databaseId: tasks, properties: { name: "Task" } });
      const file = await cp.createItem({ databaseId: files, properties: { name: "File" } });
      const day = await withTransaction(data, (client) => ensureJournalPeriodDoc(client, "day", "2026-10-16"));
      const event = await cp.createItem({ databaseId: events, properties: { name: "Event", date: "2026-10-16" } });
      const alone = await cp.createItem({ databaseId: events, properties: { name: "Alone", date: "2026-10-17" } });
      await link(tasks, "project", task.id, project.id);
      await link(files, "projects", file.id, project.id);
      await link(journal, "project", day.itemId, project.id);
      await link(events, "project", event.id, project.id);
      const values = await cp.getDerivedValuesForItems([task.id, file.id, day.itemId, event.id, alone.id]);
      expect([...values.keys()]).toEqual([event.id]);
      expect(values.get(event.id)?.company?.values).toEqual([{ id: company.id, title: "Novak" }]);
      await cp.softDeleteItem(companies, company.id);
      expect((await cp.getDerivedValuesForItems([event.id])).has(event.id)).toBe(false);
    });
  });

  it("omits a project without a company and never resolves another tenant's item", async () => {
    let foreignId = "";
    await runInTenant(foreign, async () => {
      const cp = createChokePoint(data);
      const events = await database("events");
      foreignId = (await cp.createItem({ databaseId: events, properties: { name: "Foreign", date: "2026-10-16" } })).id;
    });
    await runInTenant(tenant, async () => {
      const cp = createChokePoint(data);
      const events = await database("events");
      const projects = await database("projects");
      const project = await cp.createItem({ databaseId: projects, properties: { name: "No company" } });
      const event = await cp.createItem({ databaseId: events, properties: { name: "Event", date: "2026-10-16" } });
      await link(events, "project", event.id, project.id);
      const values = await cp.getDerivedValuesForItems([event.id, foreignId]);
      expect(values.has(event.id)).toBe(false);
      expect(values.has(foreignId)).toBe(false);
    });
  });

  it("uses a constant number of statements for one or fifty items", async () => {
    await runInTenant(tenant, async () => {
      const cp = createChokePoint(data);
      const events = await database("events");
      const projects = await database("projects");
      const companies = await database("companies");
      const project = await cp.createItem({ databaseId: projects, properties: { name: "Project" } });
      const company = await cp.createItem({ databaseId: companies, properties: { name: "Company" } });
      await link(projects, "company", project.id, company.id);
      const items: ItemRow[] = [];
      for (let i = 0; i < 50; i++) {
        const item = await cp.createItem({
          databaseId: events,
          properties: { name: `Event ${i}`, date: "2026-10-16" },
        });
        await link(events, "project", item.id, project.id);
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
});
