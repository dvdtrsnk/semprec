import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { AreaFilterTemplate } from "@semprec/module-registry";
import { runInTenant } from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { getOrCreateJournalItem } from "../journal/journalStore.js";
import { seedSystem } from "../seed/seedSystem.js";
import { manifest } from "../seed/systemDatabasesModuleManifest.js";
import { createRuntimeRolePool, createTestTenant, inTenantZero } from "../testSupport/tenantFixtures.js";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { expandAreaFilter, resolveDatabaseAreaFilters } from "../views/areaFilter.js";
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
    // An Events `project` edge is a link-rule source (issue #1697): its write queues a propagation job, which
    // needs a tenant scope.
    await inTenantZero(() =>
      chokePoint.createRelation({ relationPropertyId: property.id, callerItemId, targetItemId }),
    );
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

  it("refuses at query use an expanded template with an invalid relation hop, with a 400 on filter and no write", async () => {
    const { work } = await areasAndProjects();
    await create("tasks", { name: "Send offer" });
    const tasksState = async () =>
      (
        await pool.query<{ rows: number; latest: string | null }>(
          "SELECT count(*)::int AS rows, max(updated_at)::text AS latest FROM items WHERE database_id = $1",
          [ids.tasks],
        )
      ).rows[0];
    const before = await tasksState();
    const paths: Array<[string, string]> = [
      ["name", "area"],
      ["project", "notAProperty"],
    ];
    for (const path of paths) {
      const filter = expandAreaFilter({ type: "relation_path_contains", path, value: { areaValue: true } }, work);
      await expect(chokePoint.queryDatabaseItems(ids.tasks!, { filter }), path.join(".")).rejects.toMatchObject({
        status: 400,
        code: "validation_failed",
        details: { field: "filter" },
      });
    }
    expect(await tasksState()).toEqual(before);
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

describe("resolving the declared area filters against a tenant's schema (issue #1597)", () => {
  let adminPool: Pool;
  let dataPool: Pool;
  const AREA = { areaValue: true } as const;

  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
  });

  afterAll(async () => {
    await dataPool?.end();
    await adminPool?.end();
  });

  async function seededTenant(): Promise<string> {
    const tenantId = await createTestTenant(adminPool);
    await runInTenant(tenantId, () => seedSystem(dataPool));
    return tenantId;
  }

  function resolve(tenantId: string, declarations: Parameters<typeof resolveDatabaseAreaFilters>[1]) {
    return runInTenant(tenantId, () =>
      withTransaction(dataPool, (client) => resolveDatabaseAreaFilters(client, declarations)),
    );
  }

  /** Row counts of the tables a resolution reads, in the tenant's own scope. */
  async function schemaCounts(tenantId: string) {
    return runInTenant(tenantId, async () => {
      const { rows } = await dataPool.query<{ databases: number; properties: number; items: number }>(
        `SELECT (SELECT count(*)::int FROM databases) AS databases,
                (SELECT count(*)::int FROM properties) AS properties,
                (SELECT count(*)::int FROM items) AS items`,
      );
      return rows[0];
    });
  }

  it("returns exactly the seven declared templates for a seeded tenant, unchanged, through the runtime role", async () => {
    const tenantId = await seededTenant();
    const resolved = await resolve(tenantId, manifest.databases);
    expect([...resolved.keys()].sort()).toEqual([
      "companies",
      "events",
      "files",
      "healthRecords",
      "journal",
      "projects",
      "tasks",
    ]);
    for (const [key, areaFilter] of resolved) expect(areaFilter, key).toEqual(template(key));
    // The manifest declares databases without a template too; none of them is returned.
    expect(manifest.databases.length).toBeGreaterThan(resolved.size);
  });

  it("leaves out a declaration for a database the tenant does not have, per tenant", async () => {
    const seeded = await seededTenant();
    const bare = await createTestTenant(adminPool);
    expect((await resolve(bare, manifest.databases)).size).toBe(0);
    const absent = [{ key: "notASystemDatabase", areaFilter: template("companies") }];
    expect((await resolve(seeded, absent)).size).toBe(0);
    // The bare tenant sees none of the seeded tenant's databases, so the seeded one still resolves all seven.
    expect((await resolve(seeded, manifest.databases)).size).toBe(7);
  });

  it.each([
    [
      "an unknown property",
      { type: "relation_contains", property: "formerArea", value: AREA } satisfies AreaFilterTemplate,
      "formerArea",
    ],
    [
      "a relation condition on a non-relation property",
      { type: "relation_contains", property: "name", value: AREA } satisfies AreaFilterTemplate,
      "name",
    ],
    [
      "a path whose first hop is not a relation",
      { type: "relation_path_contains", path: ["name", "area"], value: AREA } satisfies AreaFilterTemplate,
      "filter",
    ],
  ])(
    "refuses %s with the database key, the compiler's field and its error as cause, returning nothing",
    async (_, areaFilter, field) => {
      const tenantId = await seededTenant();
      const before = await schemaCounts(tenantId);
      // A valid declaration ahead of the refused one is not returned either: the whole resolution fails.
      const declarations = [
        { key: "projects", areaFilter: template("projects") },
        { key: "companies", areaFilter },
      ];
      const failure = await resolve(tenantId, declarations).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      if (!(failure instanceof Error)) return;
      expect(failure).not.toBeInstanceOf(ValidationError);
      expect(failure.message).toBe(
        `The declared area filter of database 'companies' does not compile (field '${field}')`,
      );
      expect(failure.cause).toBeInstanceOf(ValidationError);
      expect(failure.cause).toMatchObject({ details: { field } });
      expect(await schemaCounts(tenantId)).toEqual(before);
    },
  );
});
