import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { AreaFilterTemplate } from "@semprec/module-registry";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { getOrCreateJournalItem } from "../journal/journalStore.js";
import { seedSystem } from "../seed/seedSystem.js";
import { manifest } from "../seed/systemDatabasesModuleManifest.js";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { expandAreaFilter } from "../views/areaFilter.js";
import type { FilterNode } from "../views/filterTree.js";

let pool: Pool;
let chokePoint: ChokePoint;

const USER = { writerKind: "user" } as const;

function template(databaseKey: string): AreaFilterTemplate {
  const areaFilter = manifest.databases.find((db) => db.key === databaseKey)?.areaFilter;
  if (!areaFilter) throw new Error(`No area filter declared for '${databaseKey}'`);
  return areaFilter;
}

describe("declarative area filters (issue #1597)", () => {
  let ids: Record<string, string>;

  async function databaseId(key: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM databases WHERE owner_module_id = $1 AND system",
      [key],
    );
    if (!rows[0]) throw new Error(`Database '${key}' was not seeded`);
    return rows[0].id;
  }

  async function create(databaseKey: string, properties: Record<string, unknown>): Promise<string> {
    const item = await chokePoint.createItem({ databaseId: ids[databaseKey]!, properties }, undefined, undefined, USER);
    return item.id;
  }

  async function link(databaseKey: string, propertyKey: string, callerItemId: string, targetItemId: string) {
    const property = (await chokePoint.listProperties(ids[databaseKey]!)).find((p) => p.key === propertyKey);
    if (!property) throw new Error(`No property '${databaseKey}.${propertyKey}'`);
    await chokePoint.createRelation({ relationPropertyId: property.id, callerItemId, targetItemId });
  }

  async function query(databaseKey: string, filter: FilterNode): Promise<string[]> {
    const page = await chokePoint.queryDatabaseItems(ids[databaseKey]!, { filter, limit: 200 });
    return page.items.map((item) => item.id).sort();
  }

  beforeAll(() => {
    pool = getTestPool();
    chokePoint = createChokePoint(pool);
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    await seedSystem(pool);
    ids = {};
    for (const key of ["areas", "projects", "tasks", "files", "healthRecords", "events", "journal", "companies"]) {
      ids[key] = await databaseId(key);
    }
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function areasAndProjects() {
    const work = await create("areas", { name: "Work" });
    const health = await create("areas", { name: "Health" });
    const family = await create("areas", { name: "Family" });
    const workProject = await create("projects", { name: "Client launch", status: "inProgress" });
    const workArchived = await create("projects", { name: "Old client", status: "archived" });
    const healthProject = await create("projects", { name: "Checkups", status: "longTerm" });
    await link("projects", "area", workProject, work);
    await link("projects", "area", workArchived, work);
    await link("projects", "area", healthProject, health);
    return { work, health, family, workProject, workArchived, healthProject };
  }

  it("Tasks: tasks of Work projects match the Work filter, tasks without a project do not", async () => {
    const { work, workProject, healthProject } = await areasAndProjects();
    const ofWork = await create("tasks", { name: "Send offer" });
    const ofHealth = await create("tasks", { name: "Book dentist" });
    await create("tasks", { name: "No project" });
    await link("tasks", "project", ofWork, workProject);
    await link("tasks", "project", ofHealth, healthProject);
    expect(await query("tasks", expandAreaFilter(template("tasks"), work))).toEqual([ofWork]);
  });

  it("Files: project-in-area and project-less own-area files match; an other-area project with own area Health does not", async () => {
    const { health, workProject, healthProject } = await areasAndProjects();
    const ofHealthProject = await create("files", { name: "Lab results.pdf" });
    const ownHealth = await create("files", { name: "Vaccination.pdf" });
    const otherProjectOwnHealth = await create("files", { name: "Mixed.pdf" });
    await create("files", { name: "Unrelated.pdf" });
    await link("files", "projects", ofHealthProject, healthProject);
    await link("files", "area", ownHealth, health);
    // Own area first: once a file has a live project its own area is derived and refuses a write (#1595).
    await link("files", "area", otherProjectOwnHealth, health);
    await link("files", "projects", otherProjectOwnHealth, workProject);
    expect(await query("files", expandAreaFilter(template("files"), health))).toEqual(
      [ofHealthProject, ownHealth].sort(),
    );
  });

  it("Health records: the same project-or-own-area rule as Files", async () => {
    const { health, work, workProject } = await areasAndProjects();
    const ownHealth = await create("healthRecords", { name: "Allergy" });
    const ofWorkProject = await create("healthRecords", { name: "Ergonomics" });
    await link("healthRecords", "area", ownHealth, health);
    await link("healthRecords", "projects", ofWorkProject, workProject);
    expect(await query("healthRecords", expandAreaFilter(template("healthRecords"), health))).toEqual([ownHealth]);
    expect(await query("healthRecords", expandAreaFilter(template("healthRecords"), work))).toEqual([ofWorkProject]);
  });

  it("Events: a project-less event with own area Family matches Family; one with a Work project does not", async () => {
    const { family, work, workProject } = await areasAndProjects();
    const ownFamily = await create("events", { name: "Birthday dinner", date: "2026-10-16" });
    const workProjectOwnFamily = await create("events", { name: "Kickoff", date: "2026-10-17" });
    await link("events", "area", ownFamily, family);
    await link("events", "area", workProjectOwnFamily, family);
    await link("events", "project", workProjectOwnFamily, workProject);
    expect(await query("events", expandAreaFilter(template("events"), family))).toEqual([ownFamily]);
    expect(await query("events", expandAreaFilter(template("events"), work))).toEqual([workProjectOwnFamily]);
  });

  it("Journal and Companies: items with the matching own area match", async () => {
    const { health, work } = await areasAndProjects();
    const [healthEntry, workEntry] = await withTransaction(pool, async (client) => [
      await getOrCreateJournalItem(client, ids.journal!, "day", new Date("2026-10-16T12:00:00Z"), "UTC"),
      await getOrCreateJournalItem(client, ids.journal!, "day", new Date("2026-10-17T12:00:00Z"), "UTC"),
    ]);
    if (!healthEntry || !workEntry) throw new Error("Journal entries were not created");
    await link("journal", "area", healthEntry.id, health);
    await link("journal", "area", workEntry.id, work);
    expect(await query("journal", expandAreaFilter(template("journal"), health))).toEqual([healthEntry.id]);

    const workCompany = await create("companies", { name: "Acme" });
    const healthCompany = await create("companies", { name: "Clinic" });
    await link("companies", "area", workCompany, work);
    await link("companies", "area", healthCompany, health);
    expect(await query("companies", expandAreaFilter(template("companies"), work))).toEqual([workCompany]);
  });

  it("Projects: the Active chip combined with the area filter hides an archived Work project; the area filter alone keeps it", async () => {
    const { work, workProject, workArchived } = await areasAndProjects();
    const areaOnly = expandAreaFilter(template("projects"), work);
    expect(await query("projects", areaOnly)).toEqual([workProject, workArchived].sort());
    const activeChip: FilterNode = {
      type: "and",
      nodes: [areaOnly, { type: "in", property: "status", value: ["inProgress", "longTerm"] }],
    };
    expect(await query("projects", activeChip)).toEqual([workProject]);
  });

  it("every declaration of the system manifest expands to a tree the compiler accepts for its own database", async () => {
    const declared = manifest.databases.filter((db) => db.areaFilter !== undefined);
    expect(declared.map((db) => db.key).sort()).toEqual([
      "companies",
      "events",
      "files",
      "healthRecords",
      "journal",
      "projects",
      "tasks",
    ]);
    const { work } = await areasAndProjects();
    for (const db of declared) {
      const filter = expandAreaFilter(template(db.key), work);
      await expect(chokePoint.queryDatabaseItems(ids[db.key]!, { filter }), db.key).resolves.toMatchObject({
        items: expect.any(Array),
      });
    }
  });

  it("substitutes the area id into every slot and validates the result as a filter tree", () => {
    const areaId = "11111111-1111-4111-8111-111111111111";
    expect(expandAreaFilter(template("files"), areaId)).toEqual({
      type: "or",
      nodes: [
        { type: "relation_path_contains", path: ["projects", "area"], value: areaId },
        {
          type: "and",
          nodes: [
            { type: "relation_is_empty", property: "projects" },
            { type: "relation_contains", property: "area", value: areaId },
          ],
        },
      ],
    });
    expect(() => expandAreaFilter(template("files"), "not-a-uuid")).toThrow(ValidationError);
    expect(() => expandAreaFilter(template("files"), "not-a-uuid")).toThrow(/areaId/);
  });
});
