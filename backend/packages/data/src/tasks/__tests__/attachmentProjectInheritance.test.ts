import "../../domainWriteHooks.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { CORE_TASK_NAMES, runOnce } from "@semprec/queue";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { createRelationWithClient } from "../../chokePoint/relationOps.js";
import type { WriterIdentity } from "../../chokePoint/writerKind.js";
import { withTransaction } from "../../db/pool.js";
import { EMAILS_RELATION_CONTEXT } from "../../mail/emailsRelationContext.js";
import { findInvalidLinkRuleReferences } from "../../manifest/driftCheck.js";
import { loadFullModuleRegistry } from "../../manifest/fullModuleRegistry.js";
import { THREAD_ATTACHMENT_PROJECT_RULE_KEY } from "../../mail/threadAttachmentLinks.js";
import { createActionRegistry } from "../../scheduler/actions.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { startTaskSeries } from "../../testSupport/taskSeriesFixtures.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createCoreTaskList } from "../../worker.js";

const USER: WriterIdentity = { writerKind: "user" };
const SEMP: WriterIdentity = { writerKind: "agent" };
const ACTING_USER_ID = "7c0e2f6a-58a1-4d0e-9d55-2f1c6f7c9b03";
const REFUSED_RELINK = { status: 409, code: "value_link_conflict" };

let admin: Pool;
let pool: Pool;
let cp: ChokePoint;

type DatabaseKey = "companies" | "events" | "files" | "projects" | "tasks" | "threads";

interface Schema {
  db: Record<DatabaseKey, string>;
  taskProject: string;
  taskFiles: string;
  fileProjects: string;
  fileTasks: string;
  fileCompanies: string;
  projectCompany: string;
  eventProject: string;
  eventActionItems: string;
  threadProject: string;
  threadAttachments: string;
}

/** One tenant: its schema ids and the projects Alpha and Beta (Alpha of company Acme, Beta of company Bolt). */
interface World {
  tenant: string;
  schema: Schema;
  alpha: string;
  beta: string;
  acme: string;
  bolt: string;
}

async function seedTenant(): Promise<{ tenant: string; schema: Schema }> {
  const tenant = await createTestTenant(admin);
  return runInTenant(tenant, async () => {
    await seedSystem(pool, createViewTypeRegistry());
    const databases = await cp.listDatabases();
    const db = (moduleId: DatabaseKey): string => {
      const found = databases.find((database) => database.ownerModuleId === moduleId);
      if (!found) throw new Error(`Missing database ${moduleId}`);
      return found.id;
    };
    const ids: Record<DatabaseKey, string> = {
      companies: db("companies"),
      events: db("events"),
      files: db("files"),
      projects: db("projects"),
      tasks: db("tasks"),
      threads: db("threads"),
    };
    const property = async (databaseId: string, key: string): Promise<string> => {
      const found = (await cp.listProperties(databaseId)).find((entry) => entry.key === key);
      if (!found) throw new Error(`Missing property ${key}`);
      return found.id;
    };
    const schema: Schema = {
      db: ids,
      taskProject: await property(ids.tasks, "project"),
      taskFiles: await property(ids.tasks, "files"),
      fileProjects: await property(ids.files, "projects"),
      fileTasks: await property(ids.files, "tasks"),
      fileCompanies: await property(ids.files, "companies"),
      projectCompany: await property(ids.projects, "company"),
      eventProject: await property(ids.events, "project"),
      eventActionItems: await property(ids.events, "actionItems"),
      threadProject: await property(ids.threads, "project"),
      threadAttachments: await property(ids.threads, "attachments"),
    };
    return { tenant, schema };
  });
}

function inTenant<T>(world: Pick<World, "tenant">, fn: () => Promise<T>): Promise<T> {
  return runInTenant(world.tenant, fn);
}

async function item(world: Pick<World, "tenant">, databaseId: string, properties: Record<string, unknown>) {
  return (await inTenant(world, () => cp.createItem({ databaseId, properties }))).id;
}

function link(
  world: Pick<World, "tenant">,
  relationPropertyId: string,
  callerItemId: string,
  targetItemId: string,
  writer: WriterIdentity = USER,
): Promise<unknown> {
  return inTenant(world, () => cp.createRelation({ relationPropertyId, callerItemId, targetItemId }, writer));
}

function unlink(
  world: Pick<World, "tenant">,
  relationPropertyId: string,
  callerItemId: string,
  targetItemId: string,
  writer: WriterIdentity = USER,
): Promise<unknown> {
  return inTenant(world, () => cp.deleteRelation({ relationPropertyId, callerItemId, targetItemId }, writer));
}

function setProject(world: World, taskId: string, projectId: string | null): Promise<unknown> {
  return inTenant(world, () =>
    cp.setRelation(
      { relationPropertyId: world.schema.taskProject, callerItemId: taskId, targetItemId: projectId },
      USER,
    ),
  );
}

async function createTask(world: World, name: string, projectId: string | null): Promise<string> {
  const task = await item(world, world.schema.db.tasks, { name });
  if (projectId !== null) await setProject(world, task, projectId);
  return task;
}

/** What the mail ingest does for a file a message brought: the `Threads.attachments` edge, written as the emails process. */
function attachToThread(world: World, threadId: string, fileId: string): Promise<unknown> {
  return inTenant(world, () =>
    withTransaction(pool, (client) =>
      createRelationWithClient(
        client,
        { relationPropertyId: world.schema.threadAttachments, callerItemId: threadId, targetItemId: fileId },
        EMAILS_RELATION_CONTEXT,
      ),
    ),
  );
}

const createFile = (world: World, name: string): Promise<string> => item(world, world.schema.db.files, { name });

/** Attaches a file to a task as the upload attach does: an edge of `Files.tasks`, written from the task's side. */
async function attach(world: World, taskId: string, fileId: string): Promise<void> {
  await link(world, world.schema.taskFiles, taskId, fileId);
}

const sorted = (ids: string[]): string[] => [...ids].sort();

async function related(world: World, relationPropertyId: string, itemId: string): Promise<string[]> {
  const edges = await inTenant(world, () => cp.listItemRelations(itemId, relationPropertyId));
  return sorted((edges ?? []).map((edge) => edge.targetItemId));
}

const projectsOf = (world: World, fileId: string): Promise<string[]> =>
  related(world, world.schema.fileProjects, fileId);

async function linksOf(world: World, itemId: string) {
  return (await inTenant(world, () => cp.getValueLinksForItems([itemId]))).get(itemId) ?? {};
}

async function sourceIds(world: World, fileId: string): Promise<string[]> {
  const sources = (await linksOf(world, fileId)).projects?.sources ?? [];
  return sorted(sources.map((source) => (source.kind === "item" ? source.itemId : "")));
}

interface LinkRow {
  property_key: string;
  rule_key: string;
  state: string;
}

async function linkRows(world: World, itemId: string): Promise<LinkRow[]> {
  return inTenant(
    world,
    async () =>
      (
        await pool.query<LinkRow>(
          "SELECT property_key, rule_key, state FROM value_links WHERE item_id = $1 ORDER BY property_key",
          [itemId],
        )
      ).rows,
  );
}

const PROJECTS_LINK_ON: LinkRow = { property_key: "projects", rule_key: "fileProjectsFromTasks", state: "on" };
const THREAD_PROJECTS_LINK_ON: LinkRow = { ...PROJECTS_LINK_ON, rule_key: THREAD_ATTACHMENT_PROJECT_RULE_KEY };
const COMPANIES_LINK_ON: LinkRow = { property_key: "companies", rule_key: "fileCompaniesFromProjects", state: "on" };

async function queuedPropagationJobs(): Promise<number> {
  const { rows } = await admin.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM graphile_worker.jobs WHERE task_identifier = $1",
    [CORE_TASK_NAMES.VALUE_LINKS_PROPAGATE],
  );
  if (!rows[0]) throw new Error("Missing job count");
  return rows[0].count;
}

/** Drains propagation jobs in passes; a queue that never empties fails instead of letting an unchanged value pass. */
async function runPropagation(): Promise<void> {
  const taskName = CORE_TASK_NAMES.VALUE_LINKS_PROPAGATE;
  const handler = createCoreTaskList(pool, createActionRegistry())[taskName];
  if (!handler) throw new Error("Propagation handler missing");
  for (let pass = 0; pass < 40; pass++) {
    await runOnce({ pgPool: pool, taskList: { [taskName]: handler } });
    if ((await queuedPropagationJobs()) === 0) return;
  }
  throw new Error("Propagation queue did not drain");
}

function taskSource(taskId: string, title: string) {
  return { kind: "item", itemId: taskId, databaseKey: "tasks", propertyKey: "project", title };
}

/** Projects Alpha (company Acme) and Beta (company Bolt) of a seeded tenant. */
async function buildWorld(): Promise<World> {
  const { tenant, schema } = await seedTenant();
  const scope = { tenant };
  const acme = await item(scope, schema.db.companies, { name: "Acme" });
  const bolt = await item(scope, schema.db.companies, { name: "Bolt" });
  const alpha = await item(scope, schema.db.projects, { name: "Alpha" });
  const beta = await item(scope, schema.db.projects, { name: "Beta" });
  await link(scope, schema.projectCompany, alpha, acme);
  await link(scope, schema.projectCompany, beta, bolt);
  return { tenant, schema, alpha, beta, acme, bolt };
}

describe("a file attached to a task takes over the task's project (issue #1702)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("test:role", () =>
      pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    cp = createChokePoint(pool);
  });

  beforeEach(async () => {
    await resetDatabase(admin);
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.end();
  });

  describe("the rule", () => {
    it("is declared from Tasks.project to Files.projects through Files.tasks and validates against the seeded schema", async () => {
      const registry = await loadFullModuleRegistry();
      expect(() => registry.validateLinkRules()).not.toThrow();
      const rules = (await registry.getLinkRules()).filter((rule) => rule.key === "fileProjectsFromTasks");
      expect(rules).toEqual([
        {
          moduleId: "systemDatabases",
          key: "fileProjectsFromTasks",
          source: { databaseKey: "tasks", propertyKey: "project" },
          target: { databaseKey: "files", propertyKey: "projects" },
          via: { databaseKey: "files", relationKey: "tasks" },
        },
      ]);
      const world = await buildWorld();
      const findings = await inTenant(world, () =>
        withTransaction(pool, (client) => findInvalidLinkRuleReferences(client, registry)),
      );
      expect(findings).toEqual([]);
    });

    it("leaves Files.projects owned by the user, the handoff the rule's comment records", async () => {
      const world = await buildWorld();
      const owner = await inTenant(world, () =>
        pool.query<{ owner: string; owner_process: string | null }>(
          "SELECT owner, owner_process FROM properties WHERE id = $1",
          [world.schema.fileProjects],
        ),
      );
      expect(owner.rows).toEqual([{ owner: "user", owner_process: null }]);
    });
  });

  describe("attaching a file to a task", () => {
    it("links a file without a project in the state following and gives it the task's project", async () => {
      const world = await buildWorld();
      const task = await createTask(world, "Prepare the offer", world.alpha);
      const file = await createFile(world, "Offer.pdf");

      await attach(world, task, file);

      expect(await projectsOf(world, file)).toEqual([world.alpha]);
      expect(await linkRows(world, file)).toEqual([COMPANIES_LINK_ON, PROJECTS_LINK_ON]);
      expect((await linksOf(world, file)).projects).toEqual({
        valueKind: "inherited",
        sources: [taskSource(task, "Prepare the offer")],
        brokenBy: null,
        brokenAt: null,
      });
    });

    it("does the same when the edge is written from the file's side, Files.tasks", async () => {
      const world = await buildWorld();
      const task = await createTask(world, "Prepare the offer", world.alpha);
      const file = await createFile(world, "Offer.pdf");

      await link(world, world.schema.fileTasks, file, task);

      expect(await projectsOf(world, file)).toEqual([world.alpha]);
      expect(await sourceIds(world, file)).toEqual([task]);
    });

    it("links a file of a task without a project, which then holds no project, and gives it the project the task gets later", async () => {
      const world = await buildWorld();
      const task = await createTask(world, "Prepare the offer", null);
      const file = await createFile(world, "Offer.pdf");

      await attach(world, task, file);

      expect(await projectsOf(world, file)).toEqual([]);
      expect(await linkRows(world, file)).toEqual([PROJECTS_LINK_ON]);
      expect(await sourceIds(world, file)).toEqual([task]);

      await setProject(world, task, world.alpha);
      await runPropagation();

      expect(await projectsOf(world, file)).toEqual([world.alpha]);
      expect(await linkRows(world, file)).toEqual([COMPANIES_LINK_ON, PROJECTS_LINK_ON]);
    });

    it("keeps the own project of an existing file and creates no link, so no later change of the task's project reaches it and a relink is refused", async () => {
      const world = await buildWorld();
      const task = await createTask(world, "Prepare the offer", world.alpha);
      const file = await createFile(world, "Contract.pdf");
      await link(world, world.schema.fileProjects, file, world.beta);
      const followed = await createFile(world, "Offer.pdf");

      await attach(world, task, file);
      await attach(world, task, followed);

      expect(await projectsOf(world, file)).toEqual([world.beta]);
      expect(await linkRows(world, file)).toEqual([COMPANIES_LINK_ON]);
      expect((await linksOf(world, file)).projects).toBeUndefined();
      expect(await projectsOf(world, followed)).toEqual([world.alpha]);

      const gamma = await item(world, world.schema.db.projects, { name: "Gamma" });
      await setProject(world, task, gamma);
      await runPropagation();

      expect(await projectsOf(world, file)).toEqual([world.beta]);
      expect((await linksOf(world, file)).projects).toBeUndefined();
      expect(await projectsOf(world, followed)).toEqual([gamma]);
      await expect(
        inTenant(world, () => cp.relinkValue({ itemId: file, propertyKey: "projects" }, ACTING_USER_ID)),
      ).rejects.toMatchObject(REFUSED_RELINK);
      // The refused relink wrote nothing.
      expect(await projectsOf(world, file)).toEqual([world.beta]);
      expect(await linkRows(world, file)).toEqual([COMPANIES_LINK_ON]);
    });
  });

  describe("a change of the task's project", () => {
    it("replaces the project of every file that follows it and leaves a file with its own project", async () => {
      const world = await buildWorld();
      const task = await createTask(world, "Prepare the offer", world.alpha);
      const first = await createFile(world, "Offer.pdf");
      const second = await createFile(world, "Plan.pdf");
      const own = await createFile(world, "Contract.pdf");
      const gamma = await item(world, world.schema.db.projects, { name: "Gamma" });
      await link(world, world.schema.fileProjects, own, gamma);
      for (const file of [first, second, own]) await attach(world, task, file);

      await setProject(world, task, world.beta);
      await runPropagation();

      expect(await projectsOf(world, first)).toEqual([world.beta]);
      expect(await projectsOf(world, second)).toEqual([world.beta]);
      expect(await projectsOf(world, own)).toEqual([gamma]);
      expect(await linkRows(world, first)).toEqual([COMPANIES_LINK_ON, PROJECTS_LINK_ON]);
      expect(await linkRows(world, own)).toEqual([COMPANIES_LINK_ON]);
    });

    it("leaves the following attachments without a project when the task's project is set to none, the links still on", async () => {
      const world = await buildWorld();
      const task = await createTask(world, "Prepare the offer", world.alpha);
      const file = await createFile(world, "Offer.pdf");
      await attach(world, task, file);
      expect(await projectsOf(world, file)).toEqual([world.alpha]);

      await setProject(world, task, null);
      await runPropagation();

      expect(await projectsOf(world, file)).toEqual([]);
      expect(await linkRows(world, file)).toEqual([PROJECTS_LINK_ON]);
      expect(await sourceIds(world, file)).toEqual([task]);
    });
  });

  describe("a file attached to two tasks", () => {
    it("holds the projects of both tasks, and a change of one task's project replaces only that task's contribution", async () => {
      const world = await buildWorld();
      const gamma = await item(world, world.schema.db.projects, { name: "Gamma" });
      const first = await createTask(world, "Prepare the offer", world.alpha);
      const second = await createTask(world, "Send the offer", world.beta);
      const file = await createFile(world, "Offer.pdf");

      await attach(world, first, file);
      expect(await projectsOf(world, file)).toEqual([world.alpha]);
      await attach(world, second, file);

      expect(await projectsOf(world, file)).toEqual(sorted([world.alpha, world.beta]));
      expect(await sourceIds(world, file)).toEqual(sorted([first, second]));
      expect(await linkRows(world, file)).toEqual([COMPANIES_LINK_ON, PROJECTS_LINK_ON]);

      await setProject(world, first, gamma);
      await runPropagation();
      expect(await projectsOf(world, file)).toEqual(sorted([gamma, world.beta]));

      await setProject(world, second, null);
      await runPropagation();
      expect(await projectsOf(world, file)).toEqual([gamma]);
      expect(await sourceIds(world, file)).toEqual(sorted([first, second]));
    });

    it("holds a project that both tasks have once", async () => {
      const world = await buildWorld();
      const first = await createTask(world, "Prepare the offer", world.alpha);
      const second = await createTask(world, "Send the offer", world.alpha);
      const file = await createFile(world, "Offer.pdf");

      await attach(world, first, file);
      await attach(world, second, file);
      expect(await projectsOf(world, file)).toEqual([world.alpha]);

      await setProject(world, first, world.beta);
      await runPropagation();
      expect(await projectsOf(world, file)).toEqual(sorted([world.alpha, world.beta]));
    });

    it("keeps following the other task alone when one task is detached, and leaves the value as the file's own when the last one is", async () => {
      const world = await buildWorld();
      const first = await createTask(world, "Prepare the offer", world.alpha);
      const second = await createTask(world, "Send the offer", world.beta);
      const file = await createFile(world, "Offer.pdf");
      await attach(world, first, file);
      await attach(world, second, file);

      await unlink(world, world.schema.taskFiles, first, file);

      expect(await projectsOf(world, file)).toEqual([world.beta]);
      expect(await sourceIds(world, file)).toEqual([second]);
      expect(await linkRows(world, file)).toEqual([COMPANIES_LINK_ON, PROJECTS_LINK_ON]);
      // The detached task no longer reaches the file, the other one still does.
      await setProject(world, first, null);
      await setProject(world, second, world.alpha);
      await runPropagation();
      expect(await projectsOf(world, file)).toEqual([world.alpha]);

      await unlink(world, world.schema.taskFiles, second, file);

      expect(await projectsOf(world, file)).toEqual([world.alpha]);
      expect(await linkRows(world, file)).toEqual([COMPANIES_LINK_ON]);
      expect((await linksOf(world, file)).projects).toBeUndefined();
    });
  });

  describe("ending the following", () => {
    it.each([
      ["a user", USER, "user"],
      ["Semp", SEMP, "agent"],
    ] as const)(
      "reports the link broken by %s that changes the project of a following file, and the task's next change leaves the file alone",
      async (_who, writer, brokenBy) => {
        const world = await buildWorld();
        const task = await createTask(world, "Prepare the offer", world.alpha);
        const file = await createFile(world, "Offer.pdf");
        await attach(world, task, file);

        await link(world, world.schema.fileProjects, file, world.beta, writer);

        expect(await projectsOf(world, file)).toEqual(sorted([world.alpha, world.beta]));
        expect(await linkRows(world, file)).toEqual([COMPANIES_LINK_ON, { ...PROJECTS_LINK_ON, state: "broken" }]);
        expect((await linksOf(world, file)).projects).toMatchObject({
          valueKind: "inheritedBroken",
          sources: [taskSource(task, "Prepare the offer")],
          brokenBy,
        });

        const gamma = await item(world, world.schema.db.projects, { name: "Gamma" });
        await setProject(world, task, gamma);
        await runPropagation();

        expect(await projectsOf(world, file)).toEqual(sorted([world.alpha, world.beta]));
        expect((await linksOf(world, file)).projects).toMatchObject({ valueKind: "inheritedBroken", brokenBy });
      },
    );

    it("ends the link when a user removes the project of a following file", async () => {
      const world = await buildWorld();
      const task = await createTask(world, "Prepare the offer", world.alpha);
      const file = await createFile(world, "Offer.pdf");
      await attach(world, task, file);

      await unlink(world, world.schema.fileProjects, file, world.alpha);

      expect(await projectsOf(world, file)).toEqual([]);
      expect((await linksOf(world, file)).projects).toMatchObject({ valueKind: "inheritedBroken", brokenBy: "user" });
    });

    it("makes the file follow the task's project again on a relink after the user changed it", async () => {
      const world = await buildWorld();
      const task = await createTask(world, "Prepare the offer", world.alpha);
      const file = await createFile(world, "Offer.pdf");
      await attach(world, task, file);
      await link(world, world.schema.fileProjects, file, world.beta);
      await setProject(world, task, null);
      await runPropagation();
      expect(await projectsOf(world, file)).toEqual(sorted([world.alpha, world.beta]));

      await inTenant(world, () => cp.relinkValue({ itemId: file, propertyKey: "projects" }, ACTING_USER_ID));

      expect(await projectsOf(world, file)).toEqual([]);
      expect(await linkRows(world, file)).toEqual([PROJECTS_LINK_ON]);
      await setProject(world, task, world.beta);
      await runPropagation();
      expect(await projectsOf(world, file)).toEqual([world.beta]);
    });

    it("stops following after an unlink without changing the project, and follows the task's project again after a relink", async () => {
      const world = await buildWorld();
      const task = await createTask(world, "Prepare the offer", world.alpha);
      const file = await createFile(world, "Offer.pdf");
      await attach(world, task, file);

      await inTenant(world, () => cp.unlinkValue({ itemId: file, propertyKey: "projects" }, "user", ACTING_USER_ID));
      expect(await linkRows(world, file)).toEqual([COMPANIES_LINK_ON, { ...PROJECTS_LINK_ON, state: "broken" }]);
      await setProject(world, task, world.beta);
      await runPropagation();
      expect(await projectsOf(world, file)).toEqual([world.alpha]);

      await inTenant(world, () => cp.relinkValue({ itemId: file, propertyKey: "projects" }, ACTING_USER_ID));

      expect(await projectsOf(world, file)).toEqual([world.beta]);
      expect(await linkRows(world, file)).toEqual([COMPANIES_LINK_ON, PROJECTS_LINK_ON]);
      expect((await linksOf(world, file)).projects).toMatchObject({ valueKind: "inherited", brokenBy: null });
    });
  });

  describe("the second hop and the recurring task", () => {
    it("carries the project of an Event through its action-item task and the file to the file's company", async () => {
      const world = await buildWorld();
      const event = await item(world, world.schema.db.events, {
        name: "Kick-off",
        type: "meeting",
        date: "2024-03-01T12:00:00.000Z",
      });
      await link(world, world.schema.eventProject, event, world.alpha);
      const task = await createTask(world, "Prepare the offer", null);
      await link(world, world.schema.eventActionItems, event, task);
      expect(await related(world, world.schema.taskProject, task)).toEqual([world.alpha]);
      const file = await createFile(world, "Offer.pdf");

      await attach(world, task, file);

      expect(await projectsOf(world, file)).toEqual([world.alpha]);
      expect(await related(world, world.schema.fileCompanies, file)).toEqual([world.acme]);

      await unlink(world, world.schema.eventProject, event, world.alpha);
      await link(world, world.schema.eventProject, event, world.beta);
      await runPropagation();

      expect(await related(world, world.schema.taskProject, task)).toEqual([world.beta]);
      expect(await projectsOf(world, file)).toEqual([world.beta]);
      expect(await related(world, world.schema.fileCompanies, file)).toEqual([world.bolt]);
    });

    describe("a recurring task", () => {
      beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-10-16T10:00:00Z"));
      });
      afterEach(() => {
        vi.useRealTimers();
      });

      it("makes the file follow the next instance in place of the finished one, whose later project change no longer reaches it", async () => {
        const world = await buildWorld();
        const task = await item(world, world.schema.db.tasks, { name: "Weekly review", date: "2026-10-12" });
        await setProject(world, task, world.alpha);
        const file = await createFile(world, "Checklist.pdf");
        await attach(world, task, file);
        await inTenant(world, () =>
          startTaskSeries(pool, {
            databaseId: world.schema.db.tasks,
            itemId: task,
            mode: "fixed",
            rule: { kind: "weekdays", days: ["mon"] },
          }),
        );

        await inTenant(world, () =>
          cp.updateItem({ databaseId: world.schema.db.tasks, itemId: task, propertiesPatch: { status: "done" } }),
        );
        await runPropagation();

        // The advance carries the file's edge to the next instance and moves the link's source onto it.
        const attached = await related(world, world.schema.fileTasks, file);
        expect(attached).toHaveLength(2);
        const next = attached.find((id) => id !== task);
        if (!next) throw new Error("The next instance does not carry the file");
        expect(await related(world, world.schema.taskProject, next)).toEqual([world.alpha]);
        expect(await sourceIds(world, file)).toEqual([next]);
        expect(await projectsOf(world, file)).toEqual([world.alpha]);

        await setProject(world, task, world.beta);
        await runPropagation();
        expect(await projectsOf(world, file)).toEqual([world.alpha]);

        await setProject(world, next, world.beta);
        await runPropagation();
        expect(await projectsOf(world, file)).toEqual([world.beta]);
        expect(await sourceIds(world, file)).toEqual([next]);
      });
    });
  });

  describe("a file that also has a rule of a mail thread", () => {
    // `Files.projects` is the target of two rules and a file holds one link per property: the rule that linked first
    // keeps it and the other never adds a source (`linkRuleEdgeHook` skips another rule's link).
    it("keeps the link of the thread that brought the file when the file is attached to a task, so the task gives it no project", async () => {
      const world = await buildWorld();
      const thread = await item(world, world.schema.db.threads, {});
      const file = await createFile(world, "Offer.pdf");
      await attachToThread(world, thread, file);
      expect(await linkRows(world, file)).toEqual([THREAD_PROJECTS_LINK_ON]);
      const task = await createTask(world, "Prepare the offer", world.alpha);

      await attach(world, task, file);

      expect(await projectsOf(world, file)).toEqual([]);
      expect(await linkRows(world, file)).toEqual([THREAD_PROJECTS_LINK_ON]);
      expect(await sourceIds(world, file)).toEqual([thread]);
      await setProject(world, task, world.beta);
      await runPropagation();
      expect(await projectsOf(world, file)).toEqual([]);

      await link(world, world.schema.threadProject, thread, world.alpha);
      await runPropagation();
      expect(await projectsOf(world, file)).toEqual([world.alpha]);
      expect(await sourceIds(world, file)).toEqual([thread]);
    });

    it("keeps the link of the task when the thread attaches the file later, so the thread's project does not reach it", async () => {
      const world = await buildWorld();
      const task = await createTask(world, "Prepare the offer", world.alpha);
      const file = await createFile(world, "Offer.pdf");
      await attach(world, task, file);
      const thread = await item(world, world.schema.db.threads, {});
      await link(world, world.schema.threadProject, thread, world.beta);

      await attachToThread(world, thread, file);

      expect(await projectsOf(world, file)).toEqual([world.alpha]);
      expect(await linkRows(world, file)).toEqual([COMPANIES_LINK_ON, PROJECTS_LINK_ON]);
      expect(await sourceIds(world, file)).toEqual([task]);
      await unlink(world, world.schema.threadProject, thread, world.beta);
      await link(world, world.schema.threadProject, thread, world.alpha);
      await runPropagation();
      await setProject(world, task, world.beta);
      await runPropagation();
      expect(await projectsOf(world, file)).toEqual([world.beta]);
    });
  });

  describe("two tenants", () => {
    it("leaves the files and links of another tenant as they are when a task's project changes", async () => {
      const world = await buildWorld();
      const other = await buildWorld();
      const task = await createTask(world, "Prepare the offer", world.alpha);
      const file = await createFile(world, "Offer.pdf");
      await attach(world, task, file);
      const otherTask = await createTask(other, "Prepare the offer", other.alpha);
      const otherFile = await createFile(other, "Offer.pdf");
      await attach(other, otherTask, otherFile);

      await setProject(world, task, world.beta);
      await runPropagation();

      expect(await projectsOf(world, file)).toEqual([world.beta]);
      expect(await projectsOf(other, otherFile)).toEqual([other.alpha]);
      expect(await sourceIds(other, otherFile)).toEqual([otherTask]);
      // The runtime role sees nothing of the other tenant: the file and its link rows are invisible from here.
      expect(await linkRows(world, otherFile)).toEqual([]);
      expect(await projectsOf(world, otherFile)).toEqual([]);
    });
  });
});
