import "../domainWriteHooks.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { ModuleRegistry, type ModuleManifest } from "@semprec/module-registry";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { CORE_TASK_NAMES, runOnce } from "@semprec/queue";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import { createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import { itemDeleteWithClient } from "../chokePoint/itemTrash.js";
import { withTransaction } from "../db/pool.js";
import { confirmProposalWithClient, reviseProposalWithClient } from "../inbox/proposalActions.js";
import * as registryLoader from "../manifest/fullModuleRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createActionQueueAffinity, createActionRegistry } from "../scheduler/actions.js";
import { createCoreTaskList } from "../worker.js";
import { matchTranscriptToEvent } from "../transcription/transcriptEventMatch.js";
import { TRANSCRIPTION_OWNER_PROCESS } from "../transcription/transcriptionJob.js";
import { handleLinkPropagation } from "../valueLinks/linkPropagation.js";
import { withPropagationHop } from "../valueLinks/propagationContext.js";
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
      const otherFile = await cp.createItem({ databaseId: files, properties: { name: "Other file" } });
      for (const project of [firstProject, secondProject])
        await cp.createRelation({ relationPropertyId: via, callerItemId: otherFile.id, targetItemId: project.id });
      await withTransaction(data, (client) =>
        itemDeleteWithClient(client, projects, firstProject.id, { queueAffinity: createActionQueueAffinity() }),
      );
      await handleLinkPropagation(data, {
        ruleKey: "fixtureUnion.projectCompanies",
        sourceItemId: firstProject.id,
        hop: 1,
      });
      // Issue #1656: the trash detached the first project only. The link keeps the second project as
      // its source, the inherited companies stay, and the queued propagation reaches no link.
      const remaining = (await cp.listItemRelations(otherFile.id))
        ?.filter((edge) => edge.relationPropertyId === targetProperty)
        .map((edge) => edge.targetItemId)
        .sort();
      expect(remaining).toEqual([firstCompany.id, secondCompany.id].sort());
      const sources = await withTransaction(data, (client) =>
        client.query<{ source_item_id: string | null; state: string }>(
          `SELECT s.source_item_id, l.state FROM value_links l JOIN value_link_sources s ON s.link_id = l.id
           WHERE l.item_id = $1 AND l.property_key = 'companies'`,
          [otherFile.id],
        ),
      );
      expect(sources.rows).toEqual([{ source_item_id: secondProject.id, state: "on" }]);
      // R1 P6: a later propagation from the remaining source recomputes the link from that source alone.
      await handleLinkPropagation(data, {
        ruleKey: "fixtureUnion.projectCompanies",
        sourceItemId: secondProject.id,
        hop: 1,
      });
      const recomputed = (await cp.listItemRelations(otherFile.id))
        ?.filter((edge) => edge.relationPropertyId === targetProperty)
        .map((edge) => edge.targetItemId);
      expect(recomputed).toEqual([secondCompany.id]);
    });
  });

  it("rolls back the inherited write and its transaction-visible downstream job", async () => {
    await runInTenant(tenant, async () => {
      const cp = createChokePoint(data);
      const dbs = await cp.listDatabases();
      const areas = dbs.find((db) => db.ownerModuleId === "areas");
      const projects = dbs.find((db) => db.ownerModuleId === "projects");
      if (!areas || !projects) throw new Error("Fixture databases missing");
      const area = await cp.createItem({ databaseId: areas.id, properties: { name: "Source" } });
      const project = await cp.createItem({ databaseId: projects.id, properties: {} });
      const via = (await cp.listProperties(projects.id)).find((property) => property.key === "area");
      if (!via) throw new Error("Fixture relation missing");
      const before = await cp.getItem(projects.id, project.id);
      const key = `valueLinksPropagate:${tenant}:fixtureChain.hop2:${project.id}:2`;
      const task = CORE_TASK_NAMES.VALUE_LINKS_PROPAGATE;
      const events: InvalidationEvent[] = [];
      const failure = new Error("fixture rollback");
      setInvalidationHook((event) => events.push(event));
      try {
        await expect(
          withTransaction(data, async (client) => {
            const jobs = () =>
              client.query<{ key: string; task_identifier: string }>(
                "SELECT key, task_identifier FROM graphile_worker.jobs WHERE key = $1",
                [key],
              );
            expect((await jobs()).rows).toEqual([]);
            await createRelationWithClient(client, {
              relationPropertyId: via.id,
              callerItemId: project.id,
              targetItemId: area.id,
            });
            expect(
              (
                await client.query<{ name: string }>("SELECT properties->>'name' AS name FROM items WHERE id = $1", [
                  project.id,
                ])
              ).rows,
            ).toEqual([{ name: "Source" }]);
            expect((await client.query("SELECT id FROM value_links WHERE item_id = $1", [project.id])).rowCount).toBe(
              1,
            );
            expect((await jobs()).rows).toEqual([
              {
                key,
                task_identifier: task,
              },
            ]);
            throw failure;
          }),
        ).rejects.toBe(failure);
        expect(await cp.getItem(projects.id, project.id)).toEqual(before);
        expect(await cp.listItemRelations(project.id)).toEqual([]);
        expect(
          (
            await withTransaction(data, (client) =>
              client.query("SELECT id FROM value_links WHERE item_id = $1", [project.id]),
            )
          ).rowCount,
        ).toBe(0);
        expect((await admin.query("SELECT key FROM graphile_worker.jobs WHERE key = $1", [key])).rows).toEqual([]);
        expect(events.filter((event) => event.scope === "item" && event.itemId === project.id)).toEqual([]);
      } finally {
        setInvalidationHook(() => {});
      }
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
      // Index 3 is Events, whose create requires a date (issue #1663).
      for (const [index, databaseId] of ids.entries())
        items.push(
          await cp.createItem({
            databaseId,
            properties: index === 0 ? { name: "Chain source" } : index === 3 ? { date: "2026-10-16" } : {},
          }),
        );
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
    await runInTenant(tenant, () =>
      fixture.cp.updateItem({
        databaseId: fixture.ids[0]!,
        itemId: fixture.items[0]!.id,
        propertiesPatch: { name: "Changed" },
      }),
    );
    const deepEvents: InvalidationEvent[] = [];
    setInvalidationHook((event) => deepEvents.push(event));
    try {
      await runInTenant(tenant, () =>
        handleLinkPropagation(data, { ruleKey: "fixtureChain.hop1", sourceItemId: fixture.items[0]!.id, hop: 3 }),
      );
      expect(
        deepEvents.filter((event) => event.scope === "item" && event.itemId === fixture.items[1]!.id),
      ).toHaveLength(1);
      deepEvents.length = 0;
      await runInTenant(tenant, () =>
        handleLinkPropagation(data, { ruleKey: "fixtureChain.hop1", sourceItemId: fixture.items[0]!.id, hop: 1 }),
      );
      expect(deepEvents.filter((event) => event.scope === "item" && event.itemId === fixture.items[1]!.id)).toEqual([]);
      const queued = await admin.query<{ key: string }>(
        "SELECT key FROM graphile_worker.jobs WHERE task_identifier = $1 AND key = ANY($2::text[]) ORDER BY key",
        [
          taskName,
          [2, 4].map((hop) => `valueLinksPropagate:${tenant}:fixtureChain.hop2:${fixture.items[1]!.id}:${hop}`),
        ],
      );
      expect(queued.rows).toHaveLength(2);
    } finally {
      setInvalidationHook(() => {});
    }
    await drain();
    await runInTenant(tenant, async () => {
      for (let index = 1; index <= 5; index++)
        expect((await fixture.cp.getItem(fixture.ids[index]!, fixture.items[index]!.id))?.properties.name).toBe(
          "Changed",
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

  it("keeps simultaneous tenant/client hop contexts separate from root writes", async () => {
    const foreign = await createTestTenant(admin);
    await runInTenant(foreign, () => seedSystem(data));
    const make = (tenantId: string) =>
      runInTenant(tenantId, async () => {
        const cp = createChokePoint(data);
        const dbs = await cp.listDatabases();
        const areas = dbs.find((db) => db.ownerModuleId === "areas");
        const projects = dbs.find((db) => db.ownerModuleId === "projects");
        if (!areas || !projects) throw new Error("Fixture databases missing");
        const area = await cp.createItem({ databaseId: areas.id, properties: { name: "Source" } });
        const project = await cp.createItem({ databaseId: projects.id, properties: {} });
        const via = (await cp.listProperties(projects.id)).find((entry) => entry.key === "area");
        if (!via) throw new Error("Fixture relation missing");
        await cp.createRelation({ relationPropertyId: via.id, callerItemId: project.id, targetItemId: area.id });
        return { areas, projects, area, project };
      });
    const a = await make(tenant);
    const b = await make(foreign);
    let release!: () => void;
    let bothStarted!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      bothStarted = resolve;
    });
    const pids: number[] = [];
    const run = (tenantId: string, fixture: typeof a, hop: number, root: boolean) =>
      runInTenant(tenantId, () =>
        withTransaction(data, async (client) =>
          withPropagationHop(client, hop, async () => {
            const pid = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
            if (!pid.rows[0]) throw new Error("Missing backend PID");
            pids.push(pid.rows[0].pid);
            if (pids.length === 2) bothStarted();
            await gate;
            await updateItemWithClient(
              client,
              {
                databaseId: fixture.projects.id,
                itemId: fixture.project.id,
                propertiesPatch: { name: `Inherited ${hop}` },
              },
              { systemOwnerProcess: "valueLinks" },
            );
            if (root)
              await updateItemWithClient(
                client,
                { databaseId: fixture.areas.id, itemId: fixture.area.id, propertiesPatch: { name: "Root" } },
                { writer: { writerKind: "user" } },
              );
          }),
        ),
      );
    const work = [run(tenant, a, 3, true), run(foreign, b, 4, false)];
    const failures: unknown[] = [];
    try {
      await Promise.race([
        ready,
        ...work.map((task) =>
          task.then(() => {
            throw new Error("Context participant exited before barrier");
          }),
        ),
      ]);
      expect(new Set(pids).size).toBe(2);
    } catch (error) {
      failures.push(error);
    }
    release();
    for (const result of await Promise.allSettled(work)) if (result.status === "rejected") failures.push(result.reason);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Interleaved propagation contexts failed");
    const expected = [
      `valueLinksPropagate:${tenant}:fixtureChain.hop2:${a.project.id}:4`,
      `valueLinksPropagate:${foreign}:fixtureChain.hop2:${b.project.id}:5`,
      `valueLinksPropagate:${tenant}:fixtureChain.hop1:${a.area.id}:1`,
    ];
    const jobs = await admin.query<{ key: string }>(
      "SELECT key FROM graphile_worker.jobs WHERE key = ANY($1::text[])",
      [expected],
    );
    expect(jobs.rows.map((row) => row.key).sort()).toEqual(expected.sort());
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
      const event = await cp.createItem({ databaseId: events, properties: { name: "Event", date: "2026-10-16" } });
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
      const event = await cp.createItem({
        databaseId: events,
        properties: { name: "Chosen event", date: "2026-10-16" },
      });
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
