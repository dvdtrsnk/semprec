import "../domainWriteHooks.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { CORE_TASK_NAMES, runOnce } from "@semprec/queue";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../db/pool.js";
import { findInvalidLinkRuleReferences } from "../manifest/driftCheck.js";
import { loadFullModuleRegistry } from "../manifest/fullModuleRegistry.js";
import { createActionRegistry } from "../scheduler/actions.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createCoreTaskList } from "../worker.js";

const RULE = "fileCompaniesFromProjects";
const USER = { writerKind: "user" } as const;

let admin: Pool;
let pool: Pool;
let tenant: string;
let cp: ChokePoint;
let ids: {
  projects: string;
  files: string;
  companies: string;
  projectCompany: string;
  fileProjects: string;
  fileCompanies: string;
};

function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  return runInTenant(tenant, fn);
}

async function item(databaseId: string, name: string): Promise<string> {
  return (await inTenant(() => cp.createItem({ databaseId, properties: { name } }))).id;
}

async function link(relationPropertyId: string, callerItemId: string, targetItemId: string): Promise<void> {
  await inTenant(() => cp.createRelation({ relationPropertyId, callerItemId, targetItemId }, USER));
}

async function unlink(relationPropertyId: string, callerItemId: string, targetItemId: string): Promise<void> {
  await inTenant(() => cp.deleteRelation({ relationPropertyId, callerItemId, targetItemId }, USER));
}

async function fileCompanies(fileId: string): Promise<string[]> {
  const entries = await inTenant(() => cp.listItemRelations(fileId, ids.fileCompanies));
  return (entries ?? []).map((entry) => entry.targetItemId).sort();
}

async function companiesLink(fileId: string) {
  return (await inTenant(() => cp.getValueLinksForItems([fileId]))).get(fileId)?.companies;
}

interface ValueLinkRow {
  property_key: string;
  rule_key: string;
  state: string;
}

async function valueLinkRows(fileId: string): Promise<ValueLinkRow[]> {
  return inTenant(async () => {
    const { rows } = await pool.query<ValueLinkRow>(
      "SELECT property_key, rule_key, state FROM value_links WHERE item_id = $1",
      [fileId],
    );
    return rows;
  });
}

/**
 * Runs every queued value-link propagation job. A tenant's jobs share one lane and one `runOnce` runs one
 * of them, so it repeats until none is left; the Companies.projects edges also queue the Threads project
 * rule's jobs.
 */
async function runPropagation(): Promise<void> {
  const handler = createCoreTaskList(pool, createActionRegistry())[CORE_TASK_NAMES.VALUE_LINKS_PROPAGATE];
  if (!handler) throw new Error("Propagation handler missing");
  for (let round = 0; round < 20; round++) {
    const pending = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM graphile_worker._private_jobs j
       JOIN graphile_worker._private_tasks t ON t.id = j.task_id WHERE t.identifier = $1`,
      [CORE_TASK_NAMES.VALUE_LINKS_PROPAGATE],
    );
    if (pending.rows[0]?.n === 0) return;
    await runOnce({ pgPool: pool, taskList: { [CORE_TASK_NAMES.VALUE_LINKS_PROPAGATE]: handler } });
  }
  throw new Error("Propagation jobs are still queued");
}

const sorted = (values: string[]): string[] => [...values].sort();

async function twoProjects() {
  const novak = await item(ids.companies, "Novak Web s.r.o.");
  const siko = await item(ids.companies, "Siko Koupelny a.s.");
  const web = await item(ids.projects, "Web for client");
  const bathroom = await item(ids.projects, "Bathroom renovation");
  await link(ids.projectCompany, web, novak);
  await link(ids.projectCompany, bathroom, siko);
  return { novak, siko, web, bathroom };
}

describe("the fileCompaniesFromProjects link rule (issue #1653)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("test:role", () =>
      pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await inTenant(() => seedSystem(pool, createViewTypeRegistry()));
    cp = createChokePoint(pool);
    const databases = await inTenant(() => cp.listDatabases());
    const db = (moduleId: string): string => {
      const found = databases.find((database) => database.ownerModuleId === moduleId);
      if (!found) throw new Error(`Missing ${moduleId}`);
      return found.id;
    };
    const property = async (databaseId: string, key: string): Promise<string> => {
      const found = (await inTenant(() => cp.listProperties(databaseId))).find((entry) => entry.key === key);
      if (!found) throw new Error(`Missing property ${key}`);
      return found.id;
    };
    const projects = db("projects");
    const files = db("files");
    ids = {
      projects,
      files,
      companies: db("companies"),
      projectCompany: await property(projects, "company"),
      fileProjects: await property(files, "projects"),
      fileCompanies: await property(files, "companies"),
    };
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.end();
  });

  it("is declared once, passes validateLinkRules and has no drift against the seeded schema", async () => {
    const registry = await loadFullModuleRegistry();
    expect(() => registry.validateLinkRules()).not.toThrow();
    const rules = (await registry.getLinkRules()).filter((rule) => rule.key === RULE);
    expect(rules).toEqual([
      {
        moduleId: "systemDatabases",
        key: RULE,
        source: { databaseKey: "projects", propertyKey: "company" },
        target: { databaseKey: "files", propertyKey: "companies" },
        via: { databaseKey: "files", relationKey: "projects" },
      },
    ]);
    const findings = await inTenant(() =>
      withTransaction(pool, (client) => findInvalidLinkRuleReferences(client, registry)),
    );
    expect(findings).toEqual([]);
  });

  it("gives a file of Web for client and Bathroom renovation both companies as inherited with two sources", async () => {
    const { novak, siko, web, bathroom } = await twoProjects();
    const file = await item(ids.files, "Contract");
    await link(ids.fileProjects, file, web);
    await link(ids.fileProjects, file, bathroom);

    expect(await fileCompanies(file)).toEqual(sorted([novak, siko]));
    const entry = await companiesLink(file);
    expect(entry?.valueKind).toBe("inherited");
    expect(entry?.brokenBy).toBeNull();
    expect(
      (entry?.sources ?? [])
        .map((source) => (source.kind === "item" ? `${source.itemId}:${source.propertyKey}` : source.kind))
        .sort(),
    ).toEqual(sorted([`${web}:company`, `${bathroom}:company`]));
  });

  it("updates the file through the propagation job when a project's company changes", async () => {
    const { novak, siko, web, bathroom } = await twoProjects();
    const file = await item(ids.files, "Contract");
    await link(ids.fileProjects, file, web);
    await link(ids.fileProjects, file, bathroom);
    const agency = await item(ids.companies, "Nova Agency");

    await unlink(ids.projectCompany, web, novak);
    await link(ids.projectCompany, web, agency);
    // The source edge change only queues the propagation; the file is unchanged until the job runs.
    expect(await fileCompanies(file)).toEqual(sorted([novak, siko]));
    await runPropagation();
    expect(await fileCompanies(file)).toEqual(sorted([agency, siko]));
    expect((await companiesLink(file))?.valueKind).toBe("inherited");
  });

  it("removes a project's company when the project is removed from the file, and keeps the rest as own without a link when the last one goes", async () => {
    const { novak, web, bathroom } = await twoProjects();
    const file = await item(ids.files, "Contract");
    await link(ids.fileProjects, file, web);
    await link(ids.fileProjects, file, bathroom);

    await unlink(ids.fileProjects, file, bathroom);
    expect(await fileCompanies(file)).toEqual([novak]);
    expect((await companiesLink(file))?.sources.map((source) => (source.kind === "item" ? source.itemId : ""))).toEqual(
      [web],
    );

    await unlink(ids.fileProjects, file, web);
    expect(await fileCompanies(file)).toEqual([novak]);
    expect(await companiesLink(file)).toBeUndefined();
    expect(await valueLinkRows(file)).toEqual([]);
  });

  it("ends the link for the whole property when a user adds a company by hand, and later changes no longer reach the file", async () => {
    const { novak, siko, web, bathroom } = await twoProjects();
    const file = await item(ids.files, "Contract");
    await link(ids.fileProjects, file, web);
    await link(ids.fileProjects, file, bathroom);
    const own = await item(ids.companies, "Own Choice s.r.o.");

    await link(ids.fileCompanies, file, own);
    const entry = await companiesLink(file);
    expect(entry?.valueKind).toBe("inheritedBroken");
    expect(entry?.brokenBy).toBe("user");
    expect(await fileCompanies(file)).toEqual(sorted([novak, siko, own]));

    const agency = await item(ids.companies, "Nova Agency");
    await unlink(ids.projectCompany, web, novak);
    await link(ids.projectCompany, web, agency);
    await runPropagation();
    expect(await fileCompanies(file)).toEqual(sorted([novak, siko, own]));
    expect((await companiesLink(file))?.valueKind).toBe("inheritedBroken");
  });

  it("keeps a company set by hand before the first project as own and creates no link", async () => {
    const { web } = await twoProjects();
    const file = await item(ids.files, "Offer");
    const own = await item(ids.companies, "Own Choice s.r.o.");
    await link(ids.fileCompanies, file, own);

    await link(ids.fileProjects, file, web);
    expect(await fileCompanies(file)).toEqual([own]);
    expect(await companiesLink(file)).toBeUndefined();
    expect(await valueLinkRows(file)).toEqual([]);
  });

  it("keeps a file whose projects have no company empty but linked, and a later company reaches it through the job", async () => {
    const lone = await item(ids.projects, "Garden");
    const file = await item(ids.files, "Sketch");
    await link(ids.fileProjects, file, lone);
    expect(await fileCompanies(file)).toEqual([]);
    expect(await valueLinkRows(file)).toEqual([{ property_key: "companies", rule_key: RULE, state: "on" }]);
    const entry = await companiesLink(file);
    expect(entry?.valueKind).toBe("inherited");
    expect(
      entry?.sources.map((source) => (source.kind === "item" ? `${source.itemId}:${source.propertyKey}` : "")),
    ).toEqual([`${lone}:company`]);

    const company = await item(ids.companies, "Later s.r.o.");
    await link(ids.projectCompany, lone, company);
    // The company edge only queues the propagation; the registered job then writes it to the file.
    expect(await fileCompanies(file)).toEqual([]);
    await runPropagation();
    expect(await fileCompanies(file)).toEqual([company]);
  });
});
