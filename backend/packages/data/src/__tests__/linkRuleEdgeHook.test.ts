import "../domainWriteHooks.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { ModuleRegistry, type ModuleManifest } from "@semprec/module-registry";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { CORE_TASK_NAMES, runOnce } from "@semprec/queue";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { withTransaction } from "../db/pool.js";
import { confirmProposalWithClient, reviseProposalWithClient } from "../inbox/proposalActions.js";
import * as registryLoader from "../manifest/fullModuleRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createActionRegistry } from "../scheduler/actions.js";
import { createCoreTaskList } from "../worker.js";
import { matchTranscriptToEvent } from "../transcription/transcriptEventMatch.js";
import { TRANSCRIPTION_OWNER_PROCESS } from "../transcription/transcriptionJob.js";
import { handleLinkPropagation } from "../valueLinks/linkPropagation.js";
import { setInvalidationHook, type InvalidationEvent } from "../realtimeHook.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

export const manifest: ModuleManifest = {
  id: "fixtureValueLinkUnion",
  version: "1.0.0",
  name: "Fixture Value Link Union",
  removable: true,
  systemProject: false,
  databases: [],
  capabilities: [],
  agentTools: [],
  linkRules: [
    {
      key: "fixtureUnion.projectCompanies",
      source: { databaseKey: "projects", propertyKey: "company" },
      target: { databaseKey: "files", propertyKey: "companies" },
      via: { databaseKey: "files", relationKey: "projects" },
    },
    {
      key: "fixtureSingle.taskProject",
      source: { databaseKey: "tasks", propertyKey: "project" },
      target: { databaseKey: "events", propertyKey: "project" },
      via: { databaseKey: "events", relationKey: "actionItems" },
    },
    {
      key: "fixtureProposal.eventName",
      source: { databaseKey: "events", propertyKey: "name" },
      target: { databaseKey: "transcripts", propertyKey: "name" },
      via: { databaseKey: "transcripts", relationKey: "event" },
    },
    {
      key: "fixtureSingle.fileProjects",
      source: { databaseKey: "files", propertyKey: "projects" },
      target: { databaseKey: "tasks", propertyKey: "project" },
      via: { databaseKey: "tasks", relationKey: "files" },
    },
    ...["areas", "projects", "tasks", "events", "people", "companies"].map((source, index) => ({
      key: `fixtureChain.hop${index + 1}`,
      source: { databaseKey: source, propertyKey: "name" },
      target: {
        databaseKey: ["projects", "tasks", "events", "people", "companies", "files"][index]!,
        propertyKey: "name",
      },
      via: {
        databaseKey: ["projects", "tasks", "events", "events", "companies", "files"][index]!,
        relationKey: ["area", "project", "actionItems", "people", "people", "companies"][index]!,
      },
    })),
  ],
};

let admin: Pool;
let data: Pool;
let tenant: string;

describe("value link via-edge union", () => {
  beforeAll(async () => {
    const registry = new ModuleRegistry(() => new Set(["fixtureValueLinkUnion", "systemDatabases"]));
    await registry.loadModule(new URL("../seed/systemDatabasesModuleManifest.js", import.meta.url).href);
    await registry.loadModule(import.meta.url);
    registry.validateLinkRules();
    vi.spyOn(registryLoader, "loadFullModuleRegistry").mockResolvedValue(registry);
    admin = getTestPool();
    data = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("check union role", () =>
      data.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(data));
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await data?.end();
    await admin?.end();
  });

  it("unions two sources, recomputes after unlinking and retains the last value as own", async () => {
    await runInTenant(tenant, async () => {
      const cp = createChokePoint(data);
      const dbs = await cp.listDatabases();
      const id = (module: string) => {
        const row = dbs.find((db) => db.ownerModuleId === module);
        if (!row) throw new Error(`Missing ${module}`);
        return row.id;
      };
      const projects = id("projects"),
        files = id("files"),
        companies = id("companies");
      const prop = async (databaseId: string, key: string) => {
        const property = (await cp.listProperties(databaseId)).find((entry) => entry.key === key);
        if (!property) throw new Error(`Missing ${key}`);
        return property.id;
      };
      const companyProperty = await prop(projects, "company");
      const via = await prop(files, "projects");
      const targetProperty = await prop(files, "companies");
      const firstCompany = await cp.createItem({ databaseId: companies, properties: { name: "One" } });
      const secondCompany = await cp.createItem({ databaseId: companies, properties: { name: "Two" } });
      const firstProject = await cp.createItem({ databaseId: projects, properties: { name: "First" } });
      const secondProject = await cp.createItem({ databaseId: projects, properties: { name: "Second" } });
      const file = await cp.createItem({ databaseId: files, properties: { name: "File" } });
      for (const [project, company] of [
        [firstProject, firstCompany],
        [secondProject, secondCompany],
      ] as const)
        await cp.createRelation({
          relationPropertyId: companyProperty,
          callerItemId: project.id,
          targetItemId: company.id,
        });
      const attach = (projectId: string) =>
        cp.createRelation({ relationPropertyId: via, callerItemId: file.id, targetItemId: projectId });
      const detach = (projectId: string) =>
        cp.deleteRelation({ relationPropertyId: via, callerItemId: file.id, targetItemId: projectId });
      const targets = async () =>
        (await cp.listItemRelations(file.id))
          ?.filter((edge) => edge.relationPropertyId === targetProperty)
          .map((edge) => edge.targetItemId)
          .sort();
      const links = () =>
        withTransaction(data, (client) =>
          client.query<{ state: string }>(
            "SELECT state FROM value_links WHERE item_id = $1 AND property_key = 'companies'",
            [file.id],
          ),
        );
      await attach(firstProject.id);
      expect(await targets()).toEqual([firstCompany.id]);
      expect((await links()).rows).toEqual([{ state: "on" }]);
      await attach(secondProject.id);
      expect(await targets()).toEqual([firstCompany.id, secondCompany.id].sort());
      await detach(firstProject.id);
      expect(await targets()).toEqual([secondCompany.id]);
      await detach(secondProject.id);
      expect(await targets()).toEqual([secondCompany.id]);
      expect((await links()).rowCount).toBe(0);
    });
  });

  it("replays the registered worker through five hops and stops before a sixth", async () => {
    const fixture = await runInTenant(tenant, async () => {
      const cp = createChokePoint(data);
      const dbs = await cp.listDatabases();
      const ids = ["areas", "projects", "tasks", "events", "people", "companies", "files"].map((module) => {
        const db = dbs.find((entry) => entry.ownerModuleId === module);
        if (!db) throw new Error(`Missing ${module}`);
        return db.id;
      });
      const items = [];
      for (const [index, databaseId] of ids.entries())
        items.push(await cp.createItem({ databaseId, properties: index === 0 ? { name: "Chain source" } : {} }));
      const viaKeys = ["area", "project", "actionItems", "people", "people", "companies"];
      const sourceSide = new Set([4]);
      const edges = [];
      for (let index = 1; index < ids.length; index++) {
        const callerIndex = sourceSide.has(index) ? index - 1 : index;
        const targetIndex = sourceSide.has(index) ? index : index - 1;
        const property = (await cp.listProperties(ids[callerIndex]!)).find((entry) => entry.key === viaKeys[index - 1]);
        if (!property) throw new Error("Fixture relation missing");
        edges.push({
          relationPropertyId: property.id,
          callerItemId: items[callerIndex]!.id,
          targetItemId: items[targetIndex]!.id,
        });
      }
      for (let index = 6; index >= 2; index--) await cp.createRelation(edges[index - 1]!);
      return { cp, ids, items, firstEdge: edges[0]! };
    });
    const tasks = createCoreTaskList(data, createActionRegistry());
    const taskName = CORE_TASK_NAMES.VALUE_LINKS_PROPAGATE;
    const handler = tasks[taskName];
    if (!handler) throw new Error("Registered propagation handler missing");
    const drain = async () => {
      for (let pass = 0; pass < 36; pass++) {
        await runOnce({ pgPool: data, taskList: { [taskName]: handler } });
        const remaining = await admin.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM graphile_worker.jobs WHERE task_identifier = $1",
          [taskName],
        );
        if (remaining.rows[0]?.count === "0") return;
      }
      throw new Error("Propagation queue did not drain");
    };
    await drain();
    await runInTenant(tenant, () => fixture.cp.createRelation(fixture.firstEdge));
    await drain();
    await runInTenant(tenant, async () => {
      for (let index = 1; index <= 5; index++)
        expect((await fixture.cp.getItem(fixture.ids[index]!, fixture.items[index]!.id))?.properties.name).toBe(
          "Chain source",
        );
      expect((await fixture.cp.getItem(fixture.ids[6]!, fixture.items[6]!.id))?.properties.name).toBeUndefined();
    });
    const invalidations: InvalidationEvent[] = [];
    setInvalidationHook((event) => invalidations.push(event));
    try {
      await runInTenant(tenant, () =>
        handleLinkPropagation(data, {
          ruleKey: "fixtureChain.hop1",
          sourceItemId: fixture.items[0]!.id,
          hop: 1,
        }),
      );
      expect(invalidations.filter((event) => event.scope === "item" && event.itemId === fixture.items[1]!.id)).toEqual(
        [],
      );
      const key = `valueLinksPropagate:${tenant}:fixtureChain.hop2:${fixture.items[1]!.id}:2`;
      const scheduled = await admin.query<{ key: string }>("SELECT key FROM graphile_worker.jobs WHERE key = $1", [
        key,
      ]);
      expect(scheduled.rows).toEqual([{ key }]);
      await drain();
    } finally {
      setInvalidationHook(() => {});
    }
  });

  it("keeps the last single value when two source values conflict", async () => {
    await runInTenant(tenant, async () => {
      const cp = createChokePoint(data);
      const databases = await cp.listDatabases();
      const id = (module: string) => {
        const db = databases.find((entry) => entry.ownerModuleId === module);
        if (!db) throw new Error(`Missing ${module}`);
        return db.id;
      };
      const projects = id("projects"),
        tasks = id("tasks"),
        events = id("events");
      const property = async (db: string, key: string) => {
        const found = (await cp.listProperties(db)).find((entry) => entry.key === key);
        if (!found) throw new Error(`Missing ${key}`);
        return found.id;
      };
      const taskProject = await property(tasks, "project");
      const eventProject = await property(events, "project");
      const via = await property(events, "actionItems");
      const firstProject = await cp.createItem({ databaseId: projects, properties: { name: "First" } });
      const secondProject = await cp.createItem({ databaseId: projects, properties: { name: "Second" } });
      const firstTask = await cp.createItem({ databaseId: tasks, properties: { name: "One" } });
      const secondTask = await cp.createItem({ databaseId: tasks, properties: { name: "Two" } });
      const event = await cp.createItem({ databaseId: events, properties: { name: "Event" } });
      for (const [task, project] of [
        [firstTask, firstProject],
        [secondTask, secondProject],
      ] as const)
        await cp.createRelation({ relationPropertyId: taskProject, callerItemId: task.id, targetItemId: project.id });
      const edge = (taskId: string) => ({ relationPropertyId: via, callerItemId: event.id, targetItemId: taskId });
      const target = async () =>
        (await cp.listItemRelations(event.id))
          ?.filter((entry) => entry.relationPropertyId === eventProject)
          .map((entry) => entry.targetItemId);
      await cp.createRelation(edge(firstTask.id));
      expect(await target()).toEqual([firstProject.id]);
      await cp.createRelation(edge(secondTask.id));
      expect(await target()).toEqual([firstProject.id]);
      const row = await withTransaction(data, (client) =>
        client.query<{ state: string }>(
          "SELECT state FROM value_links WHERE item_id = $1 AND property_key = 'project'",
          [event.id],
        ),
      );
      expect(row.rows).toEqual([{ state: "on" }]);
      await cp.deleteRelation(edge(firstTask.id));
      expect(await target()).toEqual([secondProject.id]);
    });
  });

  it("does not create a link during real Inbox proposal revision but does on confirmation", async () => {
    await runInTenant(tenant, async () => {
      const cp = createChokePoint(data);
      const dbs = await cp.listDatabases();
      const id = (module: string) => {
        const db = dbs.find((entry) => entry.ownerModuleId === module);
        if (!db) throw new Error(`Missing ${module}`);
        return db.id;
      };
      const transcripts = id("transcripts"),
        events = id("events"),
        proposals = id("processingProposals");
      const transcript = await withTransaction(data, (client) =>
        createItemWithClient(
          client,
          { databaseId: transcripts, properties: { date: "2024-03-01T12:00:00.000Z" } },
          { allowedSystemKeys: ["date"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
        ),
      );
      await withTransaction(data, (client) =>
        matchTranscriptToEvent(client, { transcriptId: transcript.id, durationSeconds: 3600 }),
      );
      const cards = await withTransaction(data, (client) =>
        client.query<{ id: string }>(
          "SELECT id FROM items WHERE database_id = $1 AND properties->>'kind' = 'transcript'",
          [proposals],
        ),
      );
      expect(cards.rows).toHaveLength(1);
      const event = await cp.createItem({ databaseId: events, properties: { name: "Chosen event" } });
      const config = { processingProposalsDatabaseId: proposals };
      const cardId = cards.rows[0]!.id;
      await withTransaction(data, (client) =>
        reviseProposalWithClient(client, config, cardId, {
          message: "Choose event",
          entityKind: "relation",
          target: event.id,
          properties: { propertyKey: "event" },
        }),
      );
      const links = () =>
        withTransaction(data, (client) =>
          client.query<{ state: string }>(
            "SELECT state FROM value_links WHERE item_id = $1 AND property_key = 'name'",
            [transcript.id],
          ),
        );
      expect((await links()).rowCount).toBe(0);
      expect((await cp.listItemRelations(transcript.id))?.some((edge) => edge.targetItemId === event.id)).toBe(false);
      await withTransaction(data, (client) => confirmProposalWithClient(client, config, cardId));
      expect((await links()).rows).toEqual([{ state: "on" }]);
      expect((await cp.getItem(transcripts, transcript.id))?.properties.name).toBe("Chosen event");
    });
  });

  it("creates no single-value link when one source already supplies multiple values", async () => {
    await runInTenant(tenant, async () => {
      const cp = createChokePoint(data);
      const dbs = await cp.listDatabases();
      const id = (module: string) => {
        const db = dbs.find((entry) => entry.ownerModuleId === module);
        if (!db) throw new Error(`Missing ${module}`);
        return db.id;
      };
      const projects = id("projects"),
        files = id("files"),
        tasks = id("tasks");
      const fileProjects = (await cp.listProperties(files)).find((entry) => entry.key === "projects");
      const attachments = (await cp.listProperties(tasks)).find((entry) => entry.key === "files");
      const taskProject = (await cp.listProperties(tasks)).find((entry) => entry.key === "project");
      if (!fileProjects || !attachments || !taskProject) throw new Error("Missing fixture relations");
      const first = await cp.createItem({ databaseId: projects, properties: { name: "First" } });
      const second = await cp.createItem({ databaseId: projects, properties: { name: "Second" } });
      const file = await cp.createItem({ databaseId: files, properties: { name: "File" } });
      const task = await cp.createItem({ databaseId: tasks, properties: { name: "Task" } });
      for (const project of [first, second])
        await cp.createRelation({
          relationPropertyId: fileProjects.id,
          callerItemId: file.id,
          targetItemId: project.id,
        });
      await cp.createRelation({ relationPropertyId: attachments.id, callerItemId: task.id, targetItemId: file.id });
      expect(
        (await cp.listItemRelations(task.id))?.filter((edge) => edge.relationPropertyId === taskProject.id),
      ).toEqual([]);
      const rows = await withTransaction(data, (client) =>
        client.query("SELECT id FROM value_links WHERE item_id = $1 AND property_key = 'project'", [task.id]),
      );
      expect(rows.rowCount).toBe(0);
    });
  });
});
