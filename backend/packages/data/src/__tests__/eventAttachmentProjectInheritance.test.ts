import "../domainWriteHooks.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseError, type Pool, type PoolClient } from "pg";
import { CORE_TASK_NAMES, runOnce } from "@semprec/queue";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { lockItemById } from "../chokePoint/itemsStore.js";
import { deleteRelationWithClient, updateRelationWithClient } from "../chokePoint/relationOps.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { deleteValueLinkOfProperty, insertValueLink } from "../chokePoint/valueLinksStore.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { withTransaction } from "../db/pool.js";
import { ValueLinkBusyError } from "../errors.js";
import { findInvalidLinkRuleReferences } from "../manifest/driftCheck.js";
import { loadFullModuleRegistry } from "../manifest/fullModuleRegistry.js";
import { setInvalidationHook, type InvalidationEvent } from "../realtimeHook.js";
import { createActionRegistry } from "../scheduler/actions.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { handleLinkPropagation } from "../valueLinks/linkPropagation.js";
import { createCoreTaskList } from "../worker.js";

// The link rule `fileProjectsFromEvents` (issue #1756) and the release of a file's company link when its attachment
// is removed (`blobs/eventAttachmentLinkRelease.ts`). Every call runs through the choke point on a pool of the
// runtime role `semprec_data`, in a tenant; the administrator pool only reads the job queue and runs the
// fixture SQL that is marked as such.

const RULE = "fileProjectsFromEvents";
const COMPANIES_RULE = "fileCompaniesFromProjects";
const USER: WriterIdentity = { writerKind: "user" };
const SYSTEM: WriterIdentity = { writerKind: "system" };

let admin: Pool;
let pool: Pool;
let holderPool: Pool;
let propagationPool: Pool;
let edgeWriterPool: Pool;
let tenant: string;
let cp: ChokePoint;
let ids: {
  files: string;
  events: string;
  projects: string;
  companies: string;
  eventProject: string;
  projectCompany: string;
  fileProjects: string;
  fileCompanies: string;
  fileEvents: string;
};

/** One tenant: two companies, three projects (Web for client of Novak, Bathroom renovation of Siko, one without a company) and two Events. */
interface World {
  novak: string;
  siko: string;
  web: string;
  bathroom: string;
  bare: string;
  event: string;
  otherEvent: string;
}

let world: World;

function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  return runInTenant(tenant, fn);
}

async function item(databaseId: string, properties: Record<string, unknown>): Promise<string> {
  return (await inTenant(() => cp.createItem({ databaseId, properties }))).id;
}

async function link(
  relationPropertyId: string,
  callerItemId: string,
  targetItemId: string,
  writer: WriterIdentity = USER,
): Promise<void> {
  await inTenant(() => cp.createRelation({ relationPropertyId, callerItemId, targetItemId }, writer));
}

async function unlink(
  relationPropertyId: string,
  callerItemId: string,
  targetItemId: string,
  writer: WriterIdentity = USER,
): Promise<void> {
  await inTenant(() => cp.deleteRelation({ relationPropertyId, callerItemId, targetItemId }, writer));
}

/** The items on an item's own relation property, sorted. */
async function related(itemId: string, relationPropertyId: string): Promise<string[]> {
  const entries = await inTenant(() => cp.listItemRelations(itemId, relationPropertyId));
  return (entries ?? []).map((entry) => entry.targetItemId).sort();
}

const sorted = (values: string[]): string[] => [...values].sort();
const projectsOf = (file: string): Promise<string[]> => related(file, ids.fileProjects);
const companiesOf = (file: string): Promise<string[]> => related(file, ids.fileCompanies);

interface ValueLinkRow {
  property_key: string;
  rule_key: string;
  state: string;
  broken_by: string | null;
}

/** The value link rows of an item, read through the runtime role in the tenant. */
async function linkRows(itemId: string): Promise<ValueLinkRow[]> {
  return inTenant(async () => {
    const { rows } = await pool.query<ValueLinkRow>(
      "SELECT property_key, rule_key, state, broken_by FROM value_links WHERE item_id = $1 ORDER BY property_key",
      [itemId],
    );
    return rows;
  });
}

/** The ids of the items that feed the link of one property of an item, sorted. */
async function sourcesOf(itemId: string, propertyKey: string): Promise<string[]> {
  return inTenant(async () => {
    const { rows } = await pool.query<{ source_item_id: string }>(
      `SELECT s.source_item_id FROM value_link_sources s JOIN value_links l ON l.id = s.link_id
       WHERE l.item_id = $1 AND l.property_key = $2 AND s.source_kind = 'item' ORDER BY s.source_item_id`,
      [itemId, propertyKey],
    );
    return rows.map((row) => row.source_item_id);
  });
}

const ON = { state: "on", broken_by: null };

/** The link rows of a file as `[property, rule, state]` strings, which keeps the expectations readable. */
async function linkSummary(itemId: string): Promise<string[]> {
  return (await linkRows(itemId)).map((row) => `${row.property_key}:${row.rule_key}:${row.state}`);
}

/**
 * Runs every queued value-link propagation job through the registered worker task. A tenant's jobs share one lane
 * and one `runOnce` runs one of them, so it repeats until none is left.
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

/** Records the invalidations `fn` publishes; the hook is cleared again afterwards. */
async function capturingInvalidations(fn: () => Promise<unknown>): Promise<InvalidationEvent[]> {
  const events: InvalidationEvent[] = [];
  setInvalidationHook((event) => events.push(event));
  try {
    await fn();
  } finally {
    setInvalidationHook(() => {});
  }
  return events;
}

const itemUpdatesOf = (events: InvalidationEvent[], itemId: string): InvalidationEvent[] =>
  events.filter((event) => event.scope === "item" && event.op === "update" && event.itemId === itemId);

/** A user replaces the Event's project and the queued propagation runs. */
async function changeEventProject(event: string, from: string, to: string): Promise<void> {
  await unlink(ids.eventProject, event, from);
  await link(ids.eventProject, event, to);
  await runPropagation();
}

/** A user replaces the company of a project and the queued propagation runs. */
async function changeProjectCompany(project: string, from: string, to: string): Promise<void> {
  await unlink(ids.projectCompany, project, from);
  await link(ids.projectCompany, project, to);
  await runPropagation();
}

async function newFile(name = "Meeting notes"): Promise<string> {
  return item(ids.files, { name });
}

const attach = (file: string, event: string): Promise<void> => link(ids.fileEvents, file, event);
const detach = (file: string, event: string, writer: WriterIdentity = USER): Promise<void> =>
  unlink(ids.fileEvents, file, event, writer);

/**
 * A `Files.events` edge written as the release before this rule stored it, without the hooks, so the file has no value
 * link: the edge API cannot produce that state any more, since the rule reacts to every new edge.
 */
async function insertEdgeWithoutHooks(file: string, event: string): Promise<void> {
  await inTenant(async () => {
    const { rows } = await pool.query<{ id: string; property_id_a: string }>(
      "SELECT id, property_id_a FROM relation_definitions WHERE property_id_a = $1 OR property_id_b = $1",
      [ids.fileEvents],
    );
    const definition = rows[0];
    if (!definition) throw new Error("Files.events definition missing");
    const fileIsA = definition.property_id_a === ids.fileEvents;
    const inserted = await pool.query(
      "INSERT INTO item_relations (relation_definition_id, item_a, item_b) VALUES ($1, $2, $3)",
      [definition.id, fileIsA ? file : event, fileIsA ? event : file],
    );
    expect(inserted.rowCount).toBe(1);
  });
}

describe("the fileProjectsFromEvents link rule and the release of a removed attachment (issue #1756)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
    holderPool = await createRuntimeRolePool(admin, "semprec_data");
    propagationPool = await createRuntimeRolePool(admin, "semprec_data");
    edgeWriterPool = await createRuntimeRolePool(admin, "semprec_data");
    // The backends of the concurrent parties are told apart by their `application_name`.
    holderPool.options.application_name = "attachment:holder";
    propagationPool.options.application_name = "attachment:propagation";
    edgeWriterPool.options.application_name = "attachment:edgeWrite";
    for (const runtime of [pool, holderPool, propagationPool, edgeWriterPool]) {
      const role = await runAsSystem("test:role", () =>
        runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
          "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
        ),
      );
      expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    }
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
    const files = db("files");
    const events = db("events");
    const projects = db("projects");
    ids = {
      files,
      events,
      projects,
      companies: db("companies"),
      eventProject: await property(events, "project"),
      projectCompany: await property(projects, "company"),
      fileProjects: await property(files, "projects"),
      fileCompanies: await property(files, "companies"),
      fileEvents: await property(files, "events"),
    };
    const novak = await item(ids.companies, { name: "Novak Web s.r.o." });
    const siko = await item(ids.companies, { name: "Siko Koupelny a.s." });
    const web = await item(projects, { name: "Web for client" });
    const bathroom = await item(projects, { name: "Bathroom renovation" });
    const bare = await item(projects, { name: "Internal notes" });
    await link(ids.projectCompany, web, novak);
    await link(ids.projectCompany, bathroom, siko);
    const event = await item(events, { name: "client meeting", type: "meeting", date: "2024-03-01T12:00:00.000Z" });
    const otherEvent = await item(events, { name: "site visit", type: "meeting", date: "2024-03-02T12:00:00.000Z" });
    await link(ids.eventProject, event, web);
    await link(ids.eventProject, otherEvent, bathroom);
    world = { novak, siko, web, bathroom, bare, event, otherEvent };
  });

  afterAll(async () => {
    setInvalidationHook(() => {});
    for (const runtime of [pool, holderPool, propagationPool, edgeWriterPool]) await runtime?.end();
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
        source: { databaseKey: "events", propertyKey: "project" },
        target: { databaseKey: "files", propertyKey: "projects" },
        via: { databaseKey: "files", relationKey: "events" },
      },
    ]);
    const findings = await inTenant(() =>
      withTransaction(pool, (client) => findInvalidLinkRuleReferences(client, registry)),
    );
    expect(findings).toEqual([]);
  });

  describe("attaching a file", () => {
    it("gives the file the Event's project as an inherited value, and the project's company as an inherited company", async () => {
      const file = await newFile();
      await attach(file, world.event);

      expect(await related(file, ids.fileEvents)).toEqual([world.event]);
      expect(await projectsOf(file)).toEqual([world.web]);
      expect(await companiesOf(file)).toEqual([world.novak]);
      expect(await linkRows(file)).toEqual([
        { property_key: "companies", rule_key: COMPANIES_RULE, ...ON },
        { property_key: "projects", rule_key: RULE, ...ON },
      ]);
      expect(await sourcesOf(file, "projects")).toEqual([world.event]);
      expect(await sourcesOf(file, "companies")).toEqual([world.web]);

      const links = (await inTenant(() => cp.getValueLinksForItems([file]))).get(file);
      expect(links?.projects?.valueKind).toBe("inherited");
      expect(links?.projects?.brokenBy).toBeNull();
      expect(links?.projects?.sources.map((source) => (source.kind === "item" ? source.itemId : ""))).toEqual([
        world.event,
      ]);
      expect(links?.companies?.valueKind).toBe("inherited");
    });

    it("writes the attachment and gives the file no project when the Event's project is in the Trash", async () => {
      await inTenant(() => cp.softDeleteItem(ids.projects, world.web, undefined, USER));
      const file = await newFile();

      await attach(file, world.event);

      expect(await related(file, ids.fileEvents)).toEqual([world.event]);
      expect(await projectsOf(file)).toEqual([]);
      expect(await companiesOf(file)).toEqual([]);
    });

    it("keeps a project the file had of its own and gives it no link", async () => {
      const file = await newFile();
      await link(ids.fileProjects, file, world.bathroom);

      await attach(file, world.event);

      expect(await projectsOf(file)).toEqual([world.bathroom]);
      expect(await companiesOf(file)).toEqual([world.siko]);
      // The company link of #1653 follows the own project; no `projects` link exists.
      expect(await linkSummary(file)).toEqual([`companies:${COMPANIES_RULE}:on`]);
    });
  });

  describe("changing the Event's project", () => {
    it("moves the inherited project and the inherited company of an attached file to the new project and its company", async () => {
      const file = await newFile();
      await attach(file, world.event);

      await changeEventProject(world.event, world.web, world.bathroom);

      expect(await projectsOf(file)).toEqual([world.bathroom]);
      expect(await companiesOf(file)).toEqual([world.siko]);
      expect(await linkRows(file)).toEqual([
        { property_key: "companies", rule_key: COMPANIES_RULE, ...ON },
        { property_key: "projects", rule_key: RULE, ...ON },
      ]);
      expect(await sourcesOf(file, "companies")).toEqual([world.bathroom]);
    });
  });

  describe("removing the attachment", () => {
    it("leaves the file in Files with its project and company as its own values and no link, and later changes do not reach it", async () => {
      const file = await newFile();
      await attach(file, world.event);

      await detach(file, world.event);

      const stored = await inTenant(() =>
        pool.query<{ deleted_at: Date | null }>("SELECT deleted_at FROM items WHERE id = $1", [file]),
      );
      expect(stored.rows).toEqual([{ deleted_at: null }]);
      expect(await related(file, ids.fileEvents)).toEqual([]);
      expect(await projectsOf(file)).toEqual([world.web]);
      expect(await companiesOf(file)).toEqual([world.novak]);
      expect(await linkRows(file)).toEqual([]);
      expect((await inTenant(() => cp.getValueLinksForItems([file]))).get(file)).toBeUndefined();

      const agency = await item(ids.companies, { name: "Nova Agency" });
      await changeProjectCompany(world.web, world.novak, agency);
      await changeEventProject(world.event, world.web, world.bathroom);
      expect(await projectsOf(file)).toEqual([world.web]);
      expect(await companiesOf(file)).toEqual([world.novak]);
      expect(await linkRows(file)).toEqual([]);
    });

    it("announces the file once after the commit, and not at all when the removal rolls back", async () => {
      const file = await newFile();
      await attach(file, world.event);
      const edge = { relationPropertyId: ids.fileEvents, callerItemId: file, targetItemId: world.event };
      const failure = new Error("fixture rollback");

      const rolledBack = await capturingInvalidations(() =>
        expect(
          inTenant(() =>
            withTransaction(pool, async (client) => {
              await deleteRelationWithClient(client, edge, undefined, USER);
              throw failure;
            }),
          ),
        ).rejects.toBe(failure),
      );
      expect(rolledBack).toEqual([]);
      expect(await linkSummary(file)).toEqual([`companies:${COMPANIES_RULE}:on`, `projects:${RULE}:on`]);

      const committed = await capturingInvalidations(() => detach(file, world.event));
      expect(itemUpdatesOf(committed, file)).toHaveLength(1);
    });

    it("leaves the file's own values, and no link, when the user had broken the project link before the removal", async () => {
      const file = await newFile();
      await attach(file, world.event);
      await link(ids.fileProjects, file, world.bare);
      expect(await linkSummary(file)).toEqual([`companies:${COMPANIES_RULE}:on`, `projects:${RULE}:broken`]);
      expect(await sourcesOf(file, "projects")).toEqual([world.event]);

      const events = await capturingInvalidations(() => detach(file, world.event));

      expect(await linkRows(file)).toEqual([]);
      expect(await projectsOf(file)).toEqual(sorted([world.web, world.bare]));
      expect(await companiesOf(file)).toEqual([world.novak]);
      expect(itemUpdatesOf(events, file)).toHaveLength(1);

      const agency = await item(ids.companies, { name: "Nova Agency" });
      await changeProjectCompany(world.web, world.novak, agency);
      await changeEventProject(world.event, world.web, world.bathroom);
      expect(await companiesOf(file)).toEqual([world.novak]);
      expect(await projectsOf(file)).toEqual(sorted([world.web, world.bare]));
    });

    it("leaves the company inherited from a project the file had before it was attached", async () => {
      const file = await newFile();
      await link(ids.fileProjects, file, world.bathroom);
      await attach(file, world.event);

      const events = await capturingInvalidations(() => detach(file, world.event));

      expect(await linkSummary(file)).toEqual([`companies:${COMPANIES_RULE}:on`]);
      expect(await sourcesOf(file, "companies")).toEqual([world.bathroom]);
      expect(itemUpdatesOf(events, file)).toEqual([]);
      const agency = await item(ids.companies, { name: "Nova Agency" });
      await changeProjectCompany(world.bathroom, world.siko, agency);
      expect(await companiesOf(file)).toEqual([agency]);
    });

    it("leaves the file following the other Event when it is attached to two", async () => {
      const file = await newFile();
      await attach(file, world.event);
      await attach(file, world.otherEvent);
      expect(await projectsOf(file)).toEqual(sorted([world.web, world.bathroom]));
      expect(await companiesOf(file)).toEqual(sorted([world.novak, world.siko]));

      await detach(file, world.event);

      expect(await linkRows(file)).toEqual([
        { property_key: "companies", rule_key: COMPANIES_RULE, ...ON },
        { property_key: "projects", rule_key: RULE, ...ON },
      ]);
      expect(await sourcesOf(file, "projects")).toEqual([world.otherEvent]);
      expect(await projectsOf(file)).toEqual([world.bathroom]);
      expect(await sourcesOf(file, "companies")).toEqual([world.bathroom]);
      expect(await companiesOf(file)).toEqual([world.siko]);
    });

    it("removes the Event from a project link the user broke and leaves the company link alone when another Event still feeds it", async () => {
      const file = await newFile();
      await attach(file, world.event);
      await attach(file, world.otherEvent);
      await link(ids.fileProjects, file, world.bare);
      expect(await linkSummary(file)).toEqual([`companies:${COMPANIES_RULE}:on`, `projects:${RULE}:broken`]);
      const companySources = await sourcesOf(file, "companies");

      const events = await capturingInvalidations(() => detach(file, world.event));

      expect(await linkSummary(file)).toEqual([`companies:${COMPANIES_RULE}:on`, `projects:${RULE}:broken`]);
      expect(await sourcesOf(file, "projects")).toEqual([world.otherEvent]);
      expect(await sourcesOf(file, "companies")).toEqual(companySources);
      expect(await projectsOf(file)).toEqual(sorted([world.web, world.bathroom, world.bare]));
      expect(itemUpdatesOf(events, file)).toHaveLength(1);
    });

    it("deletes the project link and leaves the own company alone when the file has no company link", async () => {
      const file = await newFile();
      // A company of its own before the attachment: the engine creates no company link for a file that holds one.
      await link(ids.fileCompanies, file, world.siko);
      await attach(file, world.event);
      expect(await linkSummary(file)).toEqual([`projects:${RULE}:on`]);
      expect(await companiesOf(file)).toEqual([world.siko]);

      const events = await capturingInvalidations(() => detach(file, world.event));

      expect(await related(file, ids.fileEvents)).toEqual([]);
      expect(await linkRows(file)).toEqual([]);
      expect(await projectsOf(file)).toEqual([world.web]);
      expect(await companiesOf(file)).toEqual([world.siko]);
      expect(itemUpdatesOf(events, file)).toHaveLength(1);
      await changeEventProject(world.event, world.web, world.bathroom);
      expect(await projectsOf(file)).toEqual([world.web]);
    });

    it("deletes both links and keeps both companies as the file's own when the user had broken the company link", async () => {
      const file = await newFile();
      await attach(file, world.event);
      const own = await item(ids.companies, { name: "Own Choice s.r.o." });
      await link(ids.fileCompanies, file, own);
      expect(await linkSummary(file)).toEqual([`companies:${COMPANIES_RULE}:broken`, `projects:${RULE}:on`]);

      const events = await capturingInvalidations(() => detach(file, world.event));

      expect(await related(file, ids.fileEvents)).toEqual([]);
      expect(await linkRows(file)).toEqual([]);
      expect(await sourcesOf(file, "companies")).toEqual([]);
      expect(await projectsOf(file)).toEqual([world.web]);
      expect(await companiesOf(file)).toEqual(sorted([world.novak, own]));
      expect(itemUpdatesOf(events, file)).toHaveLength(1);
      const agency = await item(ids.companies, { name: "Nova Agency" });
      await changeProjectCompany(world.web, world.novak, agency);
      expect(await companiesOf(file)).toEqual(sorted([world.novak, own]));
    });

    it("takes the removed Event out of an on project link of a file in the Trash that another Event still feeds", async () => {
      const file = await newFile();
      await attach(file, world.event);
      await attach(file, world.otherEvent);
      await inTenant(() => cp.softDeleteItem(ids.files, file, undefined, USER));
      expect(await sourcesOf(file, "projects")).toEqual(sorted([world.event, world.otherEvent]));
      const companySources = await sourcesOf(file, "companies");

      const events = await capturingInvalidations(() => detach(file, world.event));

      expect(await linkSummary(file)).toEqual([`companies:${COMPANIES_RULE}:on`, `projects:${RULE}:on`]);
      expect(await sourcesOf(file, "projects")).toEqual([world.otherEvent]);
      expect(await sourcesOf(file, "companies")).toEqual(companySources);
      expect(itemUpdatesOf(events, file)).toHaveLength(1);

      // The restored file is recomputed from the Event it is still attached to, and the Event it left does not feed it.
      await inTenant(() => cp.restoreItem(ids.files, file));
      await changeEventProject(world.event, world.web, world.bare);
      expect(await projectsOf(file)).toEqual([world.bathroom]);
      expect(await sourcesOf(file, "projects")).toEqual([world.otherEvent]);
    });

    it("changes nothing for a file that has no value link, and announces nothing", async () => {
      const file = await newFile();
      await link(ids.fileProjects, file, world.web);
      await insertEdgeWithoutHooks(file, world.event);
      const before = await linkSummary(file);

      const events = await capturingInvalidations(() => detach(file, world.event));

      expect(await related(file, ids.fileEvents)).toEqual([]);
      expect(await linkSummary(file)).toEqual(before);
      expect(await companiesOf(file)).toEqual([world.novak]);
      expect(itemUpdatesOf(events, file)).toEqual([]);
    });

    it("changes nothing when the file's project link does not name the removed Event, whatever its state", async () => {
      const onFile = await newFile("Fed by the other Event");
      await attach(onFile, world.otherEvent);
      await insertEdgeWithoutHooks(onFile, world.event);
      const brokenFile = await newFile("Broken by the user");
      await attach(brokenFile, world.otherEvent);
      await link(ids.fileProjects, brokenFile, world.bare);
      await insertEdgeWithoutHooks(brokenFile, world.event);

      const events = await capturingInvalidations(async () => {
        await detach(onFile, world.event);
        await detach(brokenFile, world.event);
      });

      expect(await linkSummary(onFile)).toEqual([`companies:${COMPANIES_RULE}:on`, `projects:${RULE}:on`]);
      expect(await sourcesOf(onFile, "projects")).toEqual([world.otherEvent]);
      expect(await linkSummary(brokenFile)).toEqual([`companies:${COMPANIES_RULE}:on`, `projects:${RULE}:broken`]);
      expect(await sourcesOf(brokenFile, "projects")).toEqual([world.otherEvent]);
      expect(itemUpdatesOf(events, onFile)).toEqual([]);
      expect(itemUpdatesOf(events, brokenFile)).toEqual([]);
    });

    it("leaves a company link of another rule alone when the attachment is removed", async () => {
      const file = await newFile();
      await attach(file, world.event);
      // A state the API cannot produce (no other rule targets `Files.companies`): the file's company link is of another rule.
      await inTenant(() =>
        withTransaction(pool, async (client) => {
          expect(await deleteValueLinkOfProperty(client, file, "companies")).toBe(true);
          await insertValueLink(client, {
            itemId: file,
            propertyKey: "companies",
            ruleKey: "fixtureCompaniesRule",
            sources: [{ kind: "item", sourceItemId: world.web, sourcePropertyKey: "company" }],
          });
        }),
      );

      await detach(file, world.event);

      expect(await linkSummary(file)).toEqual(["companies:fixtureCompaniesRule:on"]);
      expect(await sourcesOf(file, "companies")).toEqual([world.web]);
    });

    it("acts only on the Files.events relation: removing a project edge of the file releases nothing", async () => {
      const file = await newFile();
      await link(ids.fileProjects, file, world.web);
      // A state the API cannot produce: a link of the rule that names a project, not an Event, as its only source.
      await inTenant(() =>
        withTransaction(pool, async (client) => {
          await insertValueLink(client, {
            itemId: file,
            propertyKey: "projects",
            ruleKey: RULE,
            sources: [{ kind: "item", sourceItemId: world.web, sourcePropertyKey: "project" }],
          });
        }),
      );

      await unlink(ids.fileProjects, file, world.web);

      // The user's write broke the link as for any removal of a project, and the engine ended the company link that
      // lost its last source; the release did not delete the project link.
      expect(await linkSummary(file)).toEqual([`projects:${RULE}:broken`]);
      expect(await sourcesOf(file, "projects")).toEqual([world.web]);
    });

    it("keeps the links when the metadata of the attachment is updated", async () => {
      const file = await newFile();
      await attach(file, world.event);

      await inTenant(() =>
        withTransaction(pool, (client) =>
          updateRelationWithClient(
            client,
            { relationPropertyId: ids.fileEvents, callerItemId: file, targetItemId: world.event, metadata: {} },
            undefined,
            USER,
          ),
        ),
      );

      expect(await linkSummary(file)).toEqual([`companies:${COMPANIES_RULE}:on`, `projects:${RULE}:on`]);
      expect(await related(file, ids.fileEvents)).toEqual([world.event]);
    });

    it("changes nothing when the file's project link belongs to another rule, even if it names the removed Event", async () => {
      const file = await newFile();
      await link(ids.fileProjects, file, world.web);
      await insertEdgeWithoutHooks(file, world.event);
      // A state the API cannot produce (no other rule has an Event as its source): a link of another rule that names the Event.
      await inTenant(() =>
        withTransaction(pool, async (client) => {
          await insertValueLink(client, {
            itemId: file,
            propertyKey: "projects",
            ruleKey: "fileProjectFromThread",
            sources: [{ kind: "item", sourceItemId: world.event, sourcePropertyKey: "project" }],
          });
        }),
      );
      const before = await linkRows(file);
      expect(before.map((row) => `${row.property_key}:${row.rule_key}`)).toEqual([
        `companies:${COMPANIES_RULE}`,
        "projects:fileProjectFromThread",
      ]);

      await detach(file, world.event);

      expect(await linkRows(file)).toEqual(before);
      expect(await sourcesOf(file, "projects")).toEqual([world.event]);
    });

    it("releases a file in the Trash like any other, and the file is not restored", async () => {
      const file = await newFile();
      await attach(file, world.event);
      await inTenant(() => cp.softDeleteItem(ids.files, file, undefined, USER));

      await detach(file, world.event);

      expect(await linkRows(file)).toEqual([]);
      // The edges stay: the project and company are the file's own values. A trashed item's relations are not listed,
      // so they are counted in the table.
      const edges = await inTenant(() =>
        pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM item_relations r JOIN relation_definitions d ON d.id = r.relation_definition_id
           WHERE (r.item_a = $1 OR r.item_b = $1)
             AND (d.property_id_a = ANY($2::uuid[]) OR d.property_id_b = ANY($2::uuid[]))`,
          [file, [ids.fileProjects, ids.fileCompanies]],
        ),
      );
      expect(edges.rows[0]?.n).toBe(2);
      const stored = await inTenant(() =>
        pool.query<{ deleted_at: Date | null }>("SELECT deleted_at FROM items WHERE id = $1", [file]),
      );
      expect(stored.rows[0]?.deleted_at).toBeInstanceOf(Date);
    });

    it("keeps the company following the project when the attachment is removed after its Event was in the Trash", async () => {
      const file = await newFile();
      await attach(file, world.event);
      await inTenant(() => cp.softDeleteItem(ids.events, world.event, undefined, USER));
      // The source detach of #1656 has already deleted the file's `projects` link.
      expect(await linkSummary(file)).toEqual([`companies:${COMPANIES_RULE}:on`]);

      await detach(file, world.event);

      expect(await linkSummary(file)).toEqual([`companies:${COMPANIES_RULE}:on`]);
      expect(await sourcesOf(file, "companies")).toEqual([world.web]);
      const agency = await item(ids.companies, { name: "Nova Agency" });
      await changeProjectCompany(world.web, world.novak, agency);
      expect(await companiesOf(file)).toEqual([agency]);
    });

    it("leaves a tenant without a Files.events relation alone when another edge of a file is removed", async () => {
      const file = await newFile();
      await link(ids.fileProjects, file, world.web);
      const definition = await admin.query<{ other: string }>(
        "DELETE FROM relation_definitions WHERE property_id_b = $1 RETURNING property_id_a AS other",
        [ids.fileEvents],
      );
      expect(definition.rowCount).toBe(1);
      // Fixture SQL: no API removes a property of a system database. This is the schema before the cutover of #1588.
      const removed = await admin.query("DELETE FROM properties WHERE id = ANY($1::uuid[])", [
        [ids.fileEvents, definition.rows[0]?.other],
      ]);
      expect(removed.rowCount).toBe(2);

      await unlink(ids.fileProjects, file, world.web);

      expect(await projectsOf(file)).toEqual([]);
    });
  });

  describe("a user write on the file", () => {
    it("breaks the inherited project link and keeps the user's project when the user adds one", async () => {
      const file = await newFile();
      await attach(file, world.event);

      await link(ids.fileProjects, file, world.bathroom);

      const links = (await inTenant(() => cp.getValueLinksForItems([file]))).get(file);
      expect(links?.projects?.valueKind).toBe("inheritedBroken");
      expect(links?.projects?.brokenBy).toBe("user");
      expect(await projectsOf(file)).toEqual(sorted([world.web, world.bathroom]));

      await changeEventProject(world.event, world.web, world.bare);
      expect(await projectsOf(file)).toEqual(sorted([world.web, world.bathroom]));
    });

    it("breaks the inherited project link and keeps the project the user set instead", async () => {
      const file = await newFile();
      await attach(file, world.event);

      await unlink(ids.fileProjects, file, world.web);
      await link(ids.fileProjects, file, world.bathroom);

      expect((await linkRows(file)).find((row) => row.property_key === "projects")).toEqual({
        property_key: "projects",
        rule_key: RULE,
        state: "broken",
        broken_by: "user",
      });
      expect(await projectsOf(file)).toEqual([world.bathroom]);
      await changeEventProject(world.event, world.web, world.bare);
      expect(await projectsOf(file)).toEqual([world.bathroom]);
    });

    it("breaks the inherited company link and keeps the user's company", async () => {
      const file = await newFile();
      await attach(file, world.event);
      const own = await item(ids.companies, { name: "Own Choice s.r.o." });

      await link(ids.fileCompanies, file, own);

      const links = (await inTenant(() => cp.getValueLinksForItems([file]))).get(file);
      expect(links?.companies?.valueKind).toBe("inheritedBroken");
      expect(links?.companies?.brokenBy).toBe("user");
      expect(links?.projects?.valueKind).toBe("inherited");
      expect(await companiesOf(file)).toEqual(sorted([world.novak, own]));

      await changeEventProject(world.event, world.web, world.bathroom);
      expect(await companiesOf(file)).toEqual(sorted([world.novak, own]));
      expect(await projectsOf(file)).toEqual([world.bathroom]);
    });
  });

  describe("an attachment written before the rule existed", () => {
    it("gives the file no project and no link, and a later change of the Event's project does not reach it", async () => {
      const file = await newFile();
      await insertEdgeWithoutHooks(file, world.event);
      expect(await related(file, ids.fileEvents)).toEqual([world.event]);
      expect(await projectsOf(file)).toEqual([]);
      expect(await linkRows(file)).toEqual([]);

      await changeEventProject(world.event, world.web, world.bathroom);

      expect(await projectsOf(file)).toEqual([]);
      expect(await companiesOf(file)).toEqual([]);
      expect(await linkRows(file)).toEqual([]);
    });
  });

  describe("concurrency", () => {
    interface Held {
      ready: Promise<void>;
      release: () => void;
      done: Promise<void>;
    }

    /** Locks the file row in a transaction of the holder pool that stays open until `release` is called. */
    function holdFileRow(file: string): Held {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let signal!: () => void;
      const locked = new Promise<void>((resolve) => {
        signal = resolve;
      });
      const done = inTenant(() =>
        withTransaction(holderPool, async (client: PoolClient) => {
          if (!(await lockItemById(client, ids.files, file))) throw new Error("The file row does not exist");
          signal();
          await gate;
        }),
      );
      const ready = Promise.race([
        locked,
        done.then(() => {
          throw new Error("The holding transaction ended before it locked the row");
        }),
      ]);
      return { ready, release, done };
    }

    /** Waits until the backends of `applicationName` wait for locks held by the backends of `blocker`, and only by them. */
    async function waitsFor(applicationName: string, blocker: string): Promise<void> {
      await vi.waitFor(
        async () => {
          const { rows } = await admin.query<{ blocker: string }>(
            `SELECT DISTINCT blocker.application_name AS blocker
             FROM pg_stat_activity waiter
             JOIN pg_stat_activity blocker ON blocker.pid = ANY(pg_blocking_pids(waiter.pid))
             WHERE waiter.datname = current_database() AND waiter.application_name = $1`,
            [applicationName],
          );
          expect(rows.map((row) => row.blocker)).toEqual([blocker]);
        },
        { timeout: 10_000, interval: 25 },
      );
    }

    /** The value link rows of an item, locked on a connection of their own: it fails while a transaction holds one. */
    async function lockLinksNowait(itemId: string): Promise<string[]> {
      const client = await admin.connect();
      let failed = true;
      try {
        await client.query("BEGIN");
        const { rows } = await client.query<{ property_key: string }>(
          "SELECT property_key FROM value_links WHERE item_id = $1 ORDER BY property_key FOR UPDATE NOWAIT",
          [itemId],
        );
        await client.query("ROLLBACK");
        failed = false;
        return rows.map((row) => row.property_key);
      } finally {
        // A connection that failed inside its transaction is not returned to the pool.
        client.release(failed);
      }
    }

    it("makes a user's removal of the attachment wait for the held file row while it holds no value link row, and complete after the release", async () => {
      const file = await newFile();
      await attach(file, world.event);
      const hold = holdFileRow(file);
      await hold.ready;

      const removal = inTenant(() =>
        createChokePoint(edgeWriterPool).deleteRelation(
          { relationPropertyId: ids.fileEvents, callerItemId: file, targetItemId: world.event },
          USER,
        ),
      );
      let linksFreeWhileWaiting: string[];
      try {
        await waitsFor("attachment:edgeWrite", "attachment:holder");
        linksFreeWhileWaiting = await lockLinksNowait(file);
      } finally {
        hold.release();
        await Promise.allSettled([hold.done, removal]);
      }
      await removal;

      expect(linksFreeWhileWaiting).toEqual(["companies", "projects"]);
      expect(await related(file, ids.fileEvents)).toEqual([]);
      expect(await linkRows(file)).toEqual([]);
    });

    it("locks the file row before any value link row when a writer without the before-link-break lock removes the attachment", async () => {
      const file = await newFile();
      await attach(file, world.event);
      const hold = holdFileRow(file);
      await hold.ready;

      // A system writer runs no before-link-break hook, so only the release hook and the engine's hook take the row.
      const removal = inTenant(() =>
        createChokePoint(edgeWriterPool).deleteRelation(
          { relationPropertyId: ids.fileEvents, callerItemId: file, targetItemId: world.event },
          SYSTEM,
        ),
      );
      let linksFreeWhileWaiting: string[];
      try {
        await waitsFor("attachment:edgeWrite", "attachment:holder");
        linksFreeWhileWaiting = await lockLinksNowait(file);
      } finally {
        hold.release();
        await Promise.allSettled([hold.done, removal]);
      }
      await removal;

      expect(linksFreeWhileWaiting).toEqual(["companies", "projects"]);
      expect(await linkRows(file)).toEqual([]);
    });

    type Outcome = "committed" | "deadlock" | "busy";

    async function outcomeOf(operation: Promise<unknown>): Promise<Outcome> {
      try {
        await operation;
        return "committed";
      } catch (error) {
        if (error instanceof DatabaseError && error.code === "40P01") return "deadlock";
        if (error instanceof ValueLinkBusyError) return "busy";
        throw error;
      }
    }

    /** The propagation of the Event's project that a change of that project queued, run as its handler runs it. */
    const propagate = (): Promise<unknown> =>
      handleLinkPropagation(propagationPool, { ruleKey: RULE, sourceItemId: world.event, hop: 1 });

    /** A user removes the file's project, the edge of `Files.projects`. */
    const userRemovesProject = (file: string, project: string): Promise<unknown> =>
      createChokePoint(edgeWriterPool).deleteRelation(
        { relationPropertyId: ids.fileProjects, callerItemId: file, targetItemId: project },
        USER,
      );

    async function queueProjectChange(file: string): Promise<void> {
      await unlink(ids.eventProject, world.event, world.web);
      await link(ids.eventProject, world.event, world.bathroom);
      const { rows } = await admin.query<{ key: string | null }>(
        "SELECT key FROM graphile_worker.jobs WHERE task_identifier = $1",
        [CORE_TASK_NAMES.VALUE_LINKS_PROPAGATE],
      );
      expect(rows.map((row) => row.key)).toContain(`valueLinksPropagate:${tenant}:${RULE}:${world.event}:1`);
      expect(await projectsOf(file)).toEqual([world.web]);
    }

    /** The file as the user's removal leaves it, whichever of the two reached the file row first. */
    async function expectUserRemovalSettled(file: string): Promise<void> {
      expect(await projectsOf(file)).toEqual([]);
      expect(await companiesOf(file)).toEqual([world.novak]);
      expect(await linkRows(file)).toEqual([
        { property_key: "projects", rule_key: RULE, state: "broken", broken_by: "user" },
      ]);
    }

    it("ends neither call with a deadlock when the propagation reaches the file row first, and commits the user's removal", async () => {
      const file = await newFile();
      await attach(file, world.event);
      await queueProjectChange(file);
      const hold = holdFileRow(file);
      await hold.ready;

      const propagation = outcomeOf(inTenant(propagate));
      await waitsFor("attachment:propagation", "attachment:holder");
      const removal = outcomeOf(inTenant(() => userRemovesProject(file, world.web)));
      let outcomes: Outcome[];
      try {
        await waitsFor("attachment:edgeWrite", "attachment:propagation");
      } finally {
        hold.release();
        outcomes = await Promise.all([propagation, removal]);
        await hold.done;
      }

      // The user's removal waits for the file row before it holds a link row, so the propagation that got the row
      // first meets no link row of the user: it commits having written nothing or is refused as busy.
      expect(outcomes[1]).toBe("committed");
      expect(["committed", "busy"]).toContain(outcomes[0]);
      await expectUserRemovalSettled(file);

      // Run again, the propagation commits and writes nothing.
      expect(await outcomeOf(inTenant(propagate))).toBe("committed");
      await expectUserRemovalSettled(file);
    });

    it("ends neither call with a deadlock when the user's removal reaches the file row first, and the propagation writes nothing", async () => {
      const file = await newFile();
      await attach(file, world.event);
      await queueProjectChange(file);
      const hold = holdFileRow(file);
      await hold.ready;

      const removal = outcomeOf(inTenant(() => userRemovesProject(file, world.web)));
      await waitsFor("attachment:edgeWrite", "attachment:holder");
      const propagation = outcomeOf(inTenant(propagate));
      let outcomes: Outcome[];
      try {
        await waitsFor("attachment:propagation", "attachment:edgeWrite");
      } finally {
        hold.release();
        outcomes = await Promise.all([removal, propagation]);
        await hold.done;
      }

      expect(outcomes).toEqual(["committed", "committed"]);
      await expectUserRemovalSettled(file);
    });
  });
});
