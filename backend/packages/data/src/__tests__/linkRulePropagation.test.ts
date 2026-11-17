import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { ModuleRegistry } from "@semprec/module-registry";
import { CORE_TASK_NAMES, runOnce } from "@semprec/queue";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { assertRelationCreatableWithClient, createRelationWithClient } from "../chokePoint/relationOps.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import { itemDeleteWithClient } from "../chokePoint/itemTrash.js";
import { withTransaction } from "../db/pool.js";
import * as registryLoader from "../manifest/fullModuleRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createActionQueueAffinity, createActionRegistry } from "../scheduler/actions.js";
import { createCoreTaskList } from "../worker.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { enqueueLinkPropagation, handleLinkPropagation } from "../valueLinks/linkPropagation.js";
import { lockItemById } from "../chokePoint/itemsStore.js";
import { lockValueLink } from "../chokePoint/valueLinksStore.js";
import { setInvalidationHook, type InvalidationEvent } from "../realtimeHook.js";

let admin: Pool;
let data: Pool;
let tenant: string;
const ruleKey = "fixtureValid.areaNameToProjectName";

describe("link rule propagation", () => {
  beforeAll(async () => {
    const registry = new ModuleRegistry(() => new Set(["fixtureLinkRuleValid", "systemDatabases"]));
    await registry.loadModule(new URL("../seed/systemDatabasesModuleManifest.js", import.meta.url).href);
    await registry.loadModule(new URL("./fixtures/linkRuleValidModule.js", import.meta.url).href);
    registry.validateLinkRules();
    vi.spyOn(registryLoader, "loadFullModuleRegistry").mockResolvedValue(registry);
    admin = getTestPool();
    data = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("check propagation role", () =>
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
    setInvalidationHook(() => {});
    vi.restoreAllMocks();
    await data?.end();
    await admin?.end();
  });

  it("keeps an existing own value when a via edge is created", async () => {
    await runInTenant(tenant, async () => {
      const cp = createChokePoint(data);
      const databases = await cp.listDatabases();
      const areaDb = databases.find((db) => db.ownerModuleId === "areas");
      const projectDb = databases.find((db) => db.ownerModuleId === "projects");
      if (!areaDb || !projectDb) throw new Error("Fixture databases missing");
      const area = await cp.createItem({ databaseId: areaDb.id, properties: { name: "Source" } });
      const project = await cp.createItem({ databaseId: projectDb.id, properties: { name: "Own" } });
      const via = (await cp.listProperties(projectDb.id)).find((property) => property.key === "area");
      if (!via) throw new Error("Fixture via relation missing");
      await cp.createRelation({ relationPropertyId: via.id, callerItemId: project.id, targetItemId: area.id });
      await cp.updateItem({ databaseId: areaDb.id, itemId: area.id, propertiesPatch: { name: "Changed" } });
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => events.push(event));
      try {
        await handleLinkPropagation(data, { ruleKey, sourceItemId: area.id, hop: 1 });
      } finally {
        setInvalidationHook(() => {});
      }
      expect((await cp.getItem(projectDb.id, project.id))?.properties.name).toBe("Own");
      const links = await withTransaction(data, (client) =>
        client.query("SELECT id FROM value_links WHERE item_id = $1 AND property_key = 'name'", [project.id]),
      );
      expect(links.rowCount).toBe(0);
      expect(events.filter((event) => event.scope === "item" && event.itemId === project.id)).toEqual([]);
    });
  });

  it("copies an empty target, propagates a change, and does not invalidate an unchanged rerun", async () => {
    await runInTenant(tenant, async () => {
      const cp = createChokePoint(data);
      const databases = await cp.listDatabases();
      const areaDb = databases.find((db) => db.ownerModuleId === "areas");
      const projectDb = databases.find((db) => db.ownerModuleId === "projects");
      if (!areaDb || !projectDb) throw new Error("Fixture databases missing");
      const area = await cp.createItem({ databaseId: areaDb.id, properties: { name: "Source" } });
      const project = await cp.createItem({ databaseId: projectDb.id, properties: {} });
      const via = (await cp.listProperties(projectDb.id)).find((property) => property.key === "area");
      if (!via) throw new Error("Fixture via relation missing");
      await cp.createRelation({ relationPropertyId: via.id, callerItemId: project.id, targetItemId: area.id });
      expect((await cp.getItem(projectDb.id, project.id))?.properties.name).toBe("Source");
      const links = await withTransaction(data, (client) =>
        client.query<{ id: string; state: string }>(
          "SELECT id, state FROM value_links WHERE item_id = $1 AND property_key = 'name'",
          [project.id],
        ),
      );
      expect(links.rows).toEqual([{ id: expect.any(String), state: "on" }]);
      await cp.updateItem({ databaseId: areaDb.id, itemId: area.id, propertiesPatch: { name: "Changed" } });
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => events.push(event));
      try {
        await handleLinkPropagation(data, { ruleKey, sourceItemId: area.id, hop: 1 });
        expect((await cp.getItem(projectDb.id, project.id))?.properties.name).toBe("Changed");
        expect(events.filter((event) => event.scope === "item" && event.itemId === project.id)).toHaveLength(1);
        events.length = 0;
        await handleLinkPropagation(data, { ruleKey, sourceItemId: area.id, hop: 1 });
        expect(events.filter((event) => event.scope === "item" && event.itemId === project.id)).toEqual([]);
      } finally {
        setInvalidationHook(() => {});
      }
      const after = await withTransaction(data, (client) =>
        client.query<{ id: string; state: string }>(
          "SELECT id, state FROM value_links WHERE item_id = $1 AND property_key = 'name'",
          [project.id],
        ),
      );
      expect(after.rows).toEqual(links.rows);
      await cp.deleteRelation({ relationPropertyId: via.id, callerItemId: project.id, targetItemId: area.id });
      expect((await cp.getItem(projectDb.id, project.id))?.properties.name).toBe("Changed");
      const remaining = await withTransaction(data, (client) =>
        client.query("SELECT id FROM value_links WHERE item_id = $1 AND property_key = 'name'", [project.id]),
      );
      expect(remaining.rowCount).toBe(0);
    });
  });

  it("rolls back the via edge, inherited value and link without invalidation", async () => {
    await runInTenant(tenant, async () => {
      const cp = createChokePoint(data);
      const databases = await cp.listDatabases();
      const areas = databases.find((db) => db.ownerModuleId === "areas");
      const projects = databases.find((db) => db.ownerModuleId === "projects");
      if (!areas || !projects) throw new Error("Fixture databases missing");
      const area = await cp.createItem({ databaseId: areas.id, properties: { name: "Source" } });
      const target = await cp.createItem({ databaseId: projects.id, properties: {} });
      const via = (await cp.listProperties(projects.id)).find((property) => property.key === "area");
      if (!via) throw new Error("Fixture relation missing");
      const before = await cp.getItem(projects.id, target.id);
      const jobsBefore = await admin.query<{ key: string | null }>(
        "SELECT key FROM graphile_worker.jobs WHERE task_identifier = $1 ORDER BY key",
        ["valueLinksPropagate"],
      );
      const failure = new Error("fixture rollback");
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => events.push(event));
      try {
        await expect(
          withTransaction(data, async (client) => {
            await createRelationWithClient(client, {
              relationPropertyId: via.id,
              callerItemId: target.id,
              targetItemId: area.id,
            });
            expect((await client.query("SELECT id FROM value_links WHERE item_id = $1", [target.id])).rowCount).toBe(1);
            throw failure;
          }),
        ).rejects.toBe(failure);
        expect(await cp.getItem(projects.id, target.id)).toEqual(before);
        expect(await cp.listItemRelations(target.id)).toEqual([]);
        const links = await withTransaction(data, (client) =>
          client.query("SELECT id FROM value_links WHERE item_id = $1", [target.id]),
        );
        expect(links.rowCount).toBe(0);
        expect(
          (
            await admin.query<{ key: string | null }>(
              "SELECT key FROM graphile_worker.jobs WHERE task_identifier = $1 ORDER BY key",
              ["valueLinksPropagate"],
            )
          ).rows,
        ).toEqual(jobsBefore.rows);
        expect(events.filter((event) => event.scope === "item" && event.itemId === target.id)).toEqual([]);
      } finally {
        setInvalidationHook(() => {});
      }
    });
  });

  it("rechecks a user-broken link after waiting for the item reservation", async () => {
    const fixture = await runInTenant(tenant, async () => {
      const cp = createChokePoint(data);
      const databases = await cp.listDatabases();
      const areas = databases.find((db) => db.ownerModuleId === "areas");
      const projects = databases.find((db) => db.ownerModuleId === "projects");
      if (!areas || !projects) throw new Error("Fixture databases missing");
      const source = await cp.createItem({ databaseId: areas.id, properties: { name: "Source" } });
      const target = await cp.createItem({ databaseId: projects.id, properties: {} });
      const via = (await cp.listProperties(projects.id)).find((property) => property.key === "area");
      if (!via) throw new Error("Fixture relation missing");
      await cp.createRelation({ relationPropertyId: via.id, callerItemId: target.id, targetItemId: source.id });
      await cp.updateItem({ databaseId: areas.id, itemId: source.id, propertiesPatch: { name: "New source" } });
      return { cp, areas, projects, source, target };
    });
    let release!: () => void;
    let signal!: (pid: number) => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = new Promise<number>((resolve) => {
      signal = resolve;
    });
    const holder = runInTenant(tenant, () =>
      withTransaction(data, async (client) => {
        const pid = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        if (!pid.rows[0]) throw new Error("Missing holder PID");
        await updateItemWithClient(
          client,
          {
            databaseId: fixture.projects.id,
            itemId: fixture.target.id,
            propertiesPatch: { name: "User choice" },
          },
          { writer: { writerKind: "user" } },
        );
        signal(pid.rows[0].pid);
        await gate;
      }),
    );
    let propagation: Promise<void> | undefined;
    const failures: unknown[] = [];
    try {
      const holderPid = await Promise.race([
        locked,
        holder.then(() => {
          throw new Error("User-break holder exited before the barrier");
        }),
      ]);
      propagation = runInTenant(tenant, () =>
        handleLinkPropagation(data, { ruleKey, sourceItemId: fixture.source.id, hop: 1 }),
      );
      await vi.waitFor(async () => {
        const blocked = await admin.query<{ blocked: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND $1::int = ANY(pg_blocking_pids(pid))) AS blocked",
          [holderPid],
        );
        expect(blocked.rows[0]?.blocked).toBe(true);
      });
    } catch (error) {
      failures.push(error);
    }
    release();
    for (const work of [holder, propagation]) {
      if (!work) continue;
      try {
        await work;
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "User-break race or participant failed");
    await runInTenant(tenant, async () => {
      expect((await fixture.cp.getItem(fixture.projects.id, fixture.target.id))?.properties.name).toBe("User choice");
      const links = await withTransaction(data, (client) =>
        client.query<{ state: string }>("SELECT state FROM value_links WHERE item_id = $1 AND property_key = 'name'", [
          fixture.target.id,
        ]),
      );
      expect(links.rows).toEqual([{ state: "broken" }]);
    });
  });

  it("lets a waiting user break win after an inherited write commits", async () => {
    const fixture = await runInTenant(tenant, async () => {
      const cp = createChokePoint(data);
      const dbs = await cp.listDatabases();
      const areas = dbs.find((db) => db.ownerModuleId === "areas");
      const projects = dbs.find((db) => db.ownerModuleId === "projects");
      if (!areas || !projects) throw new Error("Fixture databases missing");
      const source = await cp.createItem({ databaseId: areas.id, properties: { name: "Source" } });
      const target = await cp.createItem({ databaseId: projects.id, properties: {} });
      const via = (await cp.listProperties(projects.id)).find((property) => property.key === "area");
      if (!via) throw new Error("Fixture relation missing");
      await cp.createRelation({ relationPropertyId: via.id, callerItemId: target.id, targetItemId: source.id });
      await cp.updateItem({ databaseId: areas.id, itemId: source.id, propertiesPatch: { name: "New source" } });
      return { cp, projects, source, target };
    });
    let release!: () => void;
    let signal!: (pid: number) => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = new Promise<number>((resolve) => {
      signal = resolve;
    });
    const holder = runInTenant(tenant, () =>
      withTransaction(data, async (client) => {
        const pid = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        if (!pid.rows[0] || !(await lockValueLink(client, fixture.target.id, "name")))
          throw new Error("Fixture link missing");
        signal(pid.rows[0].pid);
        await gate;
      }),
    );
    let propagation: Promise<void> | undefined;
    let user: Promise<unknown> | undefined;
    const failures: unknown[] = [];
    try {
      const holderPid = await Promise.race([
        locked,
        holder.then(() => {
          throw new Error("Link holder exited before barrier");
        }),
      ]);
      propagation = runInTenant(tenant, () =>
        handleLinkPropagation(data, { ruleKey, sourceItemId: fixture.source.id, hop: 1 }),
      );
      let propagationPid = 0;
      await vi.waitFor(async () => {
        const waiting = await admin.query<{ pid: number }>(
          "SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND $1::int = ANY(pg_blocking_pids(pid))",
          [holderPid],
        );
        expect(waiting.rows).toHaveLength(1);
        propagationPid = waiting.rows[0]!.pid;
      });
      user = runInTenant(tenant, () =>
        fixture.cp.updateItem(
          { databaseId: fixture.projects.id, itemId: fixture.target.id, propertiesPatch: { name: "User choice" } },
          undefined,
          undefined,
          { writerKind: "user" },
        ),
      );
      await vi.waitFor(async () => {
        const waiting = await admin.query<{ blocked: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND $1::int = ANY(pg_blocking_pids(pid))) AS blocked",
          [propagationPid],
        );
        expect(waiting.rows[0]?.blocked).toBe(true);
      });
    } catch (error) {
      failures.push(error);
    }
    release();
    for (const work of [holder, propagation, user]) {
      if (!work) continue;
      try {
        await work;
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Inherited/user race or participant failed");
    await runInTenant(tenant, async () => {
      expect((await fixture.cp.getItem(fixture.projects.id, fixture.target.id))?.properties.name).toBe("User choice");
      const links = await withTransaction(data, (client) =>
        client.query<{ state: string }>("SELECT state FROM value_links WHERE item_id = $1 AND property_key = 'name'", [
          fixture.target.id,
        ]),
      );
      expect(links.rows).toEqual([{ state: "broken" }]);
    });
  });

  it("keeps a same-budget successor when the registered propagation job is running", async () => {
    const fixture = await runInTenant(tenant, async () => {
      const cp = createChokePoint(data);
      const dbs = await cp.listDatabases();
      const areas = dbs.find((db) => db.ownerModuleId === "areas");
      const projects = dbs.find((db) => db.ownerModuleId === "projects");
      if (!areas || !projects) throw new Error("Fixture databases missing");
      const source = await cp.createItem({ databaseId: areas.id, properties: { name: "Source" } });
      const target = await cp.createItem({ databaseId: projects.id, properties: {} });
      const via = (await cp.listProperties(projects.id)).find((property) => property.key === "area");
      if (!via) throw new Error("Fixture relation missing");
      await cp.createRelation({ relationPropertyId: via.id, callerItemId: target.id, targetItemId: source.id });
      await cp.updateItem({ databaseId: areas.id, itemId: source.id, propertiesPatch: { name: "Changed" } });
      return { cp, projects, source, target };
    });
    const key = `valueLinksPropagate:${tenant}:${ruleKey}:${fixture.source.id}:1`;
    const initial = await admin.query<{ id: string }>("SELECT id::text FROM graphile_worker.jobs WHERE key = $1", [
      key,
    ]);
    expect(initial.rows).toHaveLength(1);
    let release!: () => void;
    let signal!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const holder = runInTenant(tenant, () =>
      withTransaction(data, async (client) => {
        if (!(await lockItemById(client, fixture.projects.id, fixture.target.id))) throw new Error("Target missing");
        signal();
        await gate;
      }),
    );
    let worker: Promise<void> | undefined;
    const failures: unknown[] = [];
    try {
      await Promise.race([
        locked,
        holder.then(() => {
          throw new Error("Holder exited before barrier");
        }),
      ]);
      const handler = createCoreTaskList(data, createActionRegistry())[CORE_TASK_NAMES.VALUE_LINKS_PROPAGATE];
      if (!handler) throw new Error("Propagation handler missing");
      worker = runOnce({ pgPool: data, taskList: { [CORE_TASK_NAMES.VALUE_LINKS_PROPAGATE]: handler } });
      await vi.waitFor(async () => {
        const current = await admin.query<{ locked_at: Date | null }>(
          "SELECT locked_at FROM graphile_worker.jobs WHERE id = $1",
          [initial.rows[0]!.id],
        );
        expect(current.rows[0]?.locked_at).not.toBeNull();
      });
      await runInTenant(tenant, () =>
        withTransaction(data, (client) => enqueueLinkPropagation(client, ruleKey, fixture.source.id, 1)),
      );
      const jobs = await admin.query<{ id: string; key: string | null }>(
        "SELECT id::text, key FROM graphile_worker.jobs WHERE id = $1 OR key = $2 ORDER BY id",
        [initial.rows[0]!.id, key],
      );
      expect(jobs.rows).toHaveLength(2);
      expect(jobs.rows.find((row) => row.id === initial.rows[0]!.id)?.key).toBeNull();
      expect(jobs.rows.filter((row) => row.key === key)).toHaveLength(1);
    } catch (error) {
      failures.push(error);
    }
    release();
    for (const work of [holder, worker]) {
      if (!work) continue;
      try {
        await work;
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Successor test or participant failed");
    expect(
      (await runInTenant(tenant, () => fixture.cp.getItem(fixture.projects.id, fixture.target.id)))?.properties.name,
    ).toBe("Changed");
    const successor = await admin.query<{ id: string }>("SELECT id::text FROM graphile_worker.jobs WHERE key = $1", [
      key,
    ]);
    expect(successor.rows).toHaveLength(1);
    const nextHandler = createCoreTaskList(data, createActionRegistry())[CORE_TASK_NAMES.VALUE_LINKS_PROPAGATE];
    if (!nextHandler) throw new Error("Propagation handler missing");
    await runOnce({ pgPool: data, taskList: { [CORE_TASK_NAMES.VALUE_LINKS_PROPAGATE]: nextHandler } });
    const remaining = await admin.query<{ id: string }>(
      "SELECT id::text FROM graphile_worker.jobs WHERE id = $1 OR key = $2",
      [initial.rows[0]!.id, key],
    );
    expect(remaining.rows).toEqual([]);
  });

  it("does not create a link during relation admission or mutate a foreign tenant", async () => {
    const foreign = await createTestTenant(admin);
    await runInTenant(foreign, () => seedSystem(data));
    const make = (tenantId: string) =>
      runInTenant(tenantId, async () => {
        const cp = createChokePoint(data);
        const databases = await cp.listDatabases();
        const areas = databases.find((db) => db.ownerModuleId === "areas");
        const projects = databases.find((db) => db.ownerModuleId === "projects");
        if (!areas || !projects) throw new Error("Fixture databases missing");
        const area = await cp.createItem({ databaseId: areas.id, properties: { name: "Source" } });
        const project = await cp.createItem({ databaseId: projects.id, properties: {} });
        const via = (await cp.listProperties(projects.id)).find((property) => property.key === "area");
        if (!via) throw new Error("Fixture via relation missing");
        return { cp, areas, projects, area, project, via };
      });
    const own = await make(tenant);
    const other = await make(foreign);
    await runInTenant(tenant, async () => {
      await withTransaction(data, (client) =>
        assertRelationCreatableWithClient(client, {
          relationPropertyId: own.via.id,
          callerItemId: own.project.id,
          targetItemId: own.area.id,
        }),
      );
      const links = await withTransaction(data, (client) =>
        client.query("SELECT id FROM value_links WHERE item_id = $1", [own.project.id]),
      );
      expect(links.rowCount).toBe(0);
      await own.cp.createRelation({
        relationPropertyId: own.via.id,
        callerItemId: own.project.id,
        targetItemId: own.area.id,
      });
      await handleLinkPropagation(data, { ruleKey, sourceItemId: other.area.id, hop: 1 });
      await handleLinkPropagation(data, { ruleKey, sourceItemId: randomUUID(), hop: 1 });
      expect((await own.cp.getItem(own.projects.id, own.project.id))?.properties.name).toBe("Source");
      expect(await own.cp.getItem(other.projects.id, other.project.id)).toBeNull();
    });
    await runInTenant(foreign, async () => {
      expect((await other.cp.getItem(other.projects.id, other.project.id))?.properties.name).toBeUndefined();
      const links = await withTransaction(data, (client) =>
        client.query("SELECT id FROM value_links WHERE item_id = $1", [other.project.id]),
      );
      expect(links.rowCount).toBe(0);
    });
  });

  it("updates live linked targets while leaving a user-broken link and value untouched", async () => {
    await runInTenant(tenant, async () => {
      const cp = createChokePoint(data);
      const dbs = await cp.listDatabases();
      const areas = dbs.find((db) => db.ownerModuleId === "areas");
      const projects = dbs.find((db) => db.ownerModuleId === "projects");
      if (!areas || !projects) throw new Error("Fixture databases missing");
      const via = (await cp.listProperties(projects.id)).find((property) => property.key === "area");
      if (!via) throw new Error("Fixture relation missing");
      const area = await cp.createItem({ databaseId: areas.id, properties: { name: "Initial" } });
      const live = await cp.createItem({ databaseId: projects.id, properties: {} });
      const broken = await cp.createItem({ databaseId: projects.id, properties: {} });
      for (const item of [live, broken])
        await cp.createRelation({ relationPropertyId: via.id, callerItemId: item.id, targetItemId: area.id });
      await cp.updateItem(
        { databaseId: projects.id, itemId: broken.id, propertiesPatch: { name: "Own choice" } },
        undefined,
        undefined,
        { writerKind: "user" },
      );
      await cp.updateItem({ databaseId: areas.id, itemId: area.id, propertiesPatch: { name: "New source" } });
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => events.push(event));
      try {
        await handleLinkPropagation(data, { ruleKey, sourceItemId: area.id, hop: 1 });
      } finally {
        setInvalidationHook(() => {});
      }
      expect((await cp.getItem(projects.id, live.id))?.properties.name).toBe("New source");
      expect((await cp.getItem(projects.id, broken.id))?.properties.name).toBe("Own choice");
      expect(events.some((event) => event.scope === "item" && event.itemId === live.id)).toBe(true);
      expect(events.some((event) => event.scope === "item" && event.itemId === broken.id)).toBe(false);
      const rows = await withTransaction(data, (client) =>
        client.query<{ item_id: string; state: string }>(
          "SELECT item_id, state FROM value_links WHERE item_id = ANY($1::uuid[]) ORDER BY item_id",
          [[live.id, broken.id]],
        ),
      );
      expect(rows.rows).toEqual(
        [
          { item_id: live.id, state: "on" },
          { item_id: broken.id, state: "broken" },
        ].sort((a, b) => a.item_id.localeCompare(b.item_id)),
      );
    });
  });

  it("keeps the value as own and propagates nothing when the queued source is trashed (issue #1656)", async () => {
    await runInTenant(tenant, async () => {
      const cp = createChokePoint(data);
      const dbs = await cp.listDatabases();
      const areas = dbs.find((db) => db.ownerModuleId === "areas");
      const projects = dbs.find((db) => db.ownerModuleId === "projects");
      if (!areas || !projects) throw new Error("Fixture databases missing");
      const via = (await cp.listProperties(projects.id)).find((property) => property.key === "area");
      if (!via) throw new Error("Fixture relation missing");
      const area = await cp.createItem({ databaseId: areas.id, properties: { name: "Original" } });
      const target = await cp.createItem({ databaseId: projects.id, properties: {} });
      await cp.createRelation({ relationPropertyId: via.id, callerItemId: target.id, targetItemId: area.id });
      expect((await cp.getItem(projects.id, target.id))?.properties.name).toBe("Original");
      const trashEvents: InvalidationEvent[] = [];
      setInvalidationHook((event) => trashEvents.push(event));
      try {
        await withTransaction(data, (client) =>
          itemDeleteWithClient(client, areas.id, area.id, {
            queueAffinity: createActionQueueAffinity(),
          }),
        );
      } finally {
        setInvalidationHook(() => {});
      }
      // The trash detached the only source: the link is gone and the target was told to refetch it.
      expect(trashEvents.some((event) => event.scope === "item" && event.itemId === target.id)).toBe(true);
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => events.push(event));
      try {
        await handleLinkPropagation(data, { ruleKey, sourceItemId: area.id, hop: 1 });
      } finally {
        setInvalidationHook(() => {});
      }
      expect((await cp.getItem(projects.id, target.id))?.properties.name).toBe("Original");
      expect(events.some((event) => event.scope === "item" && event.itemId === target.id)).toBe(false);
      const links = await withTransaction(data, (client) =>
        client.query<{ state: string }>("SELECT state FROM value_links WHERE item_id = $1 AND property_key = 'name'", [
          target.id,
        ]),
      );
      expect(links.rows).toEqual([]);
    });
  });

  it("commits separate keyset pages for more than one hundred linked targets", async () => {
    await runInTenant(tenant, async () => {
      const cp = createChokePoint(data);
      const dbs = await cp.listDatabases();
      const areas = dbs.find((db) => db.ownerModuleId === "areas");
      const projects = dbs.find((db) => db.ownerModuleId === "projects");
      if (!areas || !projects) throw new Error("Fixture databases missing");
      const via = (await cp.listProperties(projects.id)).find((property) => property.key === "area");
      if (!via) throw new Error("Fixture via relation missing");
      const area = await cp.createItem({ databaseId: areas.id, properties: { name: "Initial" } });
      const targets: string[] = [];
      for (let index = 0; index < 101; index++) {
        const target = await cp.createItem({ databaseId: projects.id, properties: {} });
        await cp.createRelation({ relationPropertyId: via.id, callerItemId: target.id, targetItemId: area.id });
        targets.push(target.id);
      }
      await cp.updateItem({ databaseId: areas.id, itemId: area.id, propertiesPatch: { name: "Changed" } });
      let commits = 0;
      const originals = new Map<PoolClient, PoolClient["query"]>();
      const onAcquire = (client: PoolClient) => {
        if (originals.has(client)) return;
        // eslint-disable-next-line @typescript-eslint/unbound-method
        const original = client.query;
        originals.set(client, original);
        Object.defineProperty(client, "query", {
          configurable: true,
          writable: true,
          value: (...args: unknown[]) => {
            if (args[0] === "COMMIT") commits++;
            return Reflect.apply(original, client, args);
          },
        });
      };
      data.on("acquire", onAcquire);
      try {
        await handleLinkPropagation(data, { ruleKey, sourceItemId: area.id, hop: 1 });
      } finally {
        data.off("acquire", onAcquire);
        for (const [client, original] of originals)
          Object.defineProperty(client, "query", {
            configurable: true,
            writable: true,
            value: original,
          });
      }
      expect(commits).toBe(2);
      const result = await withTransaction(data, (client) =>
        client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM items WHERE database_id = $1 AND id = ANY($2::uuid[]) AND properties->>'name' = 'Changed'",
          [projects.id, targets],
        ),
      );
      expect(result.rows).toEqual([{ count: "101" }]);
    });
  });

  it("keys equal budgets per trusted tenant, keeps distinct hops, and rejects unscoped callers", async () => {
    const foreign = await createTestTenant(admin);
    const source = randomUUID();
    const enqueue = (tenantId: string, hop: number) =>
      runInTenant(tenantId, () =>
        withTransaction(data, (client) => enqueueLinkPropagation(client, ruleKey, source, hop)),
      );
    await enqueue(tenant, 1);
    await enqueue(tenant, 1);
    await enqueue(tenant, 2);
    await enqueue(foreign, 1);
    const client = await data.connect();
    try {
      await expect(enqueueLinkPropagation(client, ruleKey, source, 1)).rejects.toThrow("requires a tenant scope");
      await expect(enqueueLinkPropagation(client, ruleKey, source, 6)).rejects.toThrow("requires a tenant scope");
      await expect(
        runAsSystem("test:reject-system-propagation", () => enqueueLinkPropagation(client, ruleKey, source, 1)),
      ).rejects.toThrow("requires a tenant scope");
      await expect(
        runAsSystem("test:reject-system-propagation", () => enqueueLinkPropagation(client, ruleKey, source, 6)),
      ).rejects.toThrow("requires a tenant scope");
    } finally {
      client.release();
    }
    const result = await admin.query<{ key: string }>(
      "SELECT key FROM graphile_worker.jobs WHERE task_identifier = 'valueLinksPropagate' ORDER BY key",
    );
    expect(result.rows.map((row) => row.key)).toEqual(
      [
        `valueLinksPropagate:${tenant}:${ruleKey}:${source}:1`,
        `valueLinksPropagate:${tenant}:${ruleKey}:${source}:2`,
        `valueLinksPropagate:${foreign}:${ruleKey}:${source}:1`,
      ].sort(),
    );
  });
});
