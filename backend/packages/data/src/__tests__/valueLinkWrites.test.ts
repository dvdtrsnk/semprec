import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../testSupport/testDb.js";
import { withTransaction } from "../db/pool.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import {
  createRelationWithClient,
  deleteRelationWithClient,
  updateRelationWithClient,
} from "../chokePoint/relationOps.js";
import { VALUE_LINKS_OWNER_PROCESS } from "../chokePoint/valueLinkWrites.js";
import { insertValueLink, listValueLinksByItemIds, type ValueLinkRow } from "../chokePoint/valueLinksStore.js";
import { setInvalidationHook, type InvalidationEvent } from "../realtimeHook.js";
import { SYSTEM_WRITER, type WriterIdentity } from "../chokePoint/writerKind.js";
import { seedSystem } from "../seed/seedSystem.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as valueLinksStore from "../chokePoint/valueLinksStore.js";

/** Issue #1516: user and agent writes end value links; the valueLinks process needs an `on` link. */
const USER: WriterIdentity = { writerKind: "user" };
const AGENT: WriterIdentity = { writerKind: "agent", onBehalfOfUserId: "00000000-0000-4000-8000-000000000003" };
const VALUE_LINKS = { ownerProcess: VALUE_LINKS_OWNER_PROCESS };

let pool: Pool;
let chokePoint: ChokePoint;

async function setup(cp: ChokePoint = chokePoint) {
  const projects = await cp.createDatabase({ name: "Projects" });
  const files = await cp.createDatabase({ name: "Files" });
  await cp.createProperty({ databaseId: files.id, key: "name", name: "Name", type: "text" });
  const { property: projectsProperty, inverseProperty: filesProperty } = await cp.createRelationProperty({
    sourceDatabaseId: files.id,
    key: "projects",
    name: "Projects",
    targetDatabaseId: projects.id,
    cardinality: "many_to_many",
    inverse: { key: "files", name: "Files" },
  });
  const file = await cp.createItem({ databaseId: files.id, properties: { name: "a.pdf" } });
  const alpha = await cp.createItem({ databaseId: projects.id, properties: {} });
  const beta = await cp.createItem({ databaseId: projects.id, properties: {} });
  return { files, file, alpha, beta, projectsProperty, filesProperty: filesProperty! };
}

async function link(itemId: string, propertyKey: string, state?: "broken"): Promise<void> {
  await withTransaction(pool, (client) =>
    insertValueLink(client, {
      itemId,
      propertyKey,
      ruleKey: "test",
      ...(state ? { state, brokenBy: "user" as const, brokenAt: new Date("2026-01-01T00:00:00Z") } : {}),
      sources: [],
    }),
  );
}

async function linkOf(itemId: string, propertyKey: string): Promise<ValueLinkRow | undefined> {
  const rows = await withTransaction(pool, (client) => listValueLinksByItemIds(client, [itemId]));
  return rows.find((row) => row.propertyKey === propertyKey);
}

async function withRuntimePool<T>(body: (runtime: Pool) => Promise<T>): Promise<T> {
  const runtime = await createRuntimeRolePool(pool, "semprec_data");
  let outcome: { value: T } | { error: unknown };
  try {
    outcome = { value: await body(runtime) };
  } catch (error) {
    outcome = { error };
  }
  try {
    await runtime.end();
  } catch (error) {
    if ("error" in outcome) throw new AggregateError([outcome.error, error], "Test and runtime cleanup failed");
    throw error;
  }
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>, milliseconds = 8000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Barrier timed out")), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitBlocked(holderPid: number, competitorPid: number): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const { rows } = await pool.query<{ blocked: boolean }>(
      "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
      [holderPid, competitorPid],
    );
    if (rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Expected ${competitorPid} to wait for ${holderPid}`);
}

describe("value link state on writes (issue #1516)", () => {
  beforeAll(() => {
    pool = getTestPool();
    chokePoint = createChokePoint(pool);
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  describe("plain properties", () => {
    it("a user write that changes a linked value breaks the link with brokenBy user", async () => {
      const { files, file } = await setup();
      await link(file.id, "name");

      await chokePoint.updateItem(
        { databaseId: files.id, itemId: file.id, propertiesPatch: { name: "b.pdf" } },
        undefined,
        undefined,
        USER,
      );

      const row = await linkOf(file.id, "name");
      expect(row).toMatchObject({ state: "broken", brokenBy: "user" });
      expect(row?.brokenAt).not.toBeNull();
    });

    it("an agent write breaks the link with brokenBy agent", async () => {
      const { files, file } = await setup();
      await link(file.id, "name");

      await chokePoint.updateItem(
        { databaseId: files.id, itemId: file.id, propertiesPatch: { name: "b.pdf" } },
        undefined,
        undefined,
        AGENT,
      );

      expect(await linkOf(file.id, "name")).toMatchObject({ state: "broken", brokenBy: "agent" });
    });

    it("a system write leaves the link on", async () => {
      const { files, file } = await setup();
      await link(file.id, "name");

      await chokePoint.updateItem(
        { databaseId: files.id, itemId: file.id, propertiesPatch: { name: "b.pdf" } },
        undefined,
        undefined,
        SYSTEM_WRITER,
      );
      await chokePoint.updateItem({ databaseId: files.id, itemId: file.id, propertiesPatch: { name: "c.pdf" } });

      expect(await linkOf(file.id, "name")).toMatchObject({ state: "on", brokenBy: null, brokenAt: null });
    });

    it("a patch that sets the value it already holds leaves the link on", async () => {
      const { files, file } = await setup();
      await link(file.id, "name");

      await chokePoint.updateItem(
        { databaseId: files.id, itemId: file.id, propertiesPatch: { name: "a.pdf" } },
        undefined,
        undefined,
        USER,
      );

      expect(await linkOf(file.id, "name")).toMatchObject({ state: "on" });
    });

    it("only the keys whose value changed are broken", async () => {
      const { files, file } = await setup();
      await chokePoint.createProperty({ databaseId: files.id, key: "note", name: "Note", type: "text" });
      await chokePoint.updateItem({ databaseId: files.id, itemId: file.id, propertiesPatch: { note: "n" } });
      await link(file.id, "name");
      await link(file.id, "note");

      await chokePoint.updateItem(
        { databaseId: files.id, itemId: file.id, propertiesPatch: { name: "b.pdf", note: "n" } },
        undefined,
        undefined,
        USER,
      );

      expect(await linkOf(file.id, "name")).toMatchObject({ state: "broken" });
      expect(await linkOf(file.id, "note")).toMatchObject({ state: "on" });
    });

    it("two writes keep the first brokenBy and brokenAt", async () => {
      const { files, file } = await setup();
      await link(file.id, "name");
      await chokePoint.updateItem(
        { databaseId: files.id, itemId: file.id, propertiesPatch: { name: "b.pdf" } },
        undefined,
        undefined,
        USER,
      );
      const first = await linkOf(file.id, "name");

      await chokePoint.updateItem(
        { databaseId: files.id, itemId: file.id, propertiesPatch: { name: "c.pdf" } },
        undefined,
        undefined,
        AGENT,
      );

      const second = await linkOf(file.id, "name");
      expect(second).toMatchObject({ state: "broken", brokenBy: "user" });
      expect(second?.brokenAt).toBe(first?.brokenAt);
    });

    it("a write to an unlinked property changes no link", async () => {
      const { files, file } = await setup();

      await chokePoint.updateItem(
        { databaseId: files.id, itemId: file.id, propertiesPatch: { name: "b.pdf" } },
        undefined,
        undefined,
        USER,
      );

      expect(await linkOf(file.id, "name")).toBeUndefined();
    });

    it("rolls the link state back together with a failed write", async () => {
      const { files, file } = await setup();
      await link(file.id, "name");
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => events.push(event));
      try {
        await expect(
          withTransaction(pool, async (client) => {
            await updateItemWithClient(
              client,
              { databaseId: files.id, itemId: file.id, propertiesPatch: { name: "b.pdf" } },
              { writer: USER },
            );
            expect(events).toEqual([]);
            throw new Error("abort");
          }),
        ).rejects.toThrow("abort");
        expect(events).toEqual([]);
      } finally {
        setInvalidationHook(() => {});
      }
      expect(await linkOf(file.id, "name")).toMatchObject({ state: "on" });
      expect((await chokePoint.getItem(files.id, file.id))?.properties.name).toBe("a.pdf");
    });
  });

  describe("relation edges", () => {
    it("breaks and announces linked values on both definition sides", async () => {
      const { file, alpha, projectsProperty } = await setup();
      await link(file.id, "projects");
      await link(alpha.id, "files");
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => events.push(event));
      try {
        await chokePoint.createRelation(
          { relationPropertyId: projectsProperty.id, callerItemId: file.id, targetItemId: alpha.id },
          USER,
        );
      } finally {
        setInvalidationHook(() => {});
      }
      expect(await linkOf(file.id, "projects")).toMatchObject({ state: "broken", brokenBy: "user" });
      expect(await linkOf(alpha.id, "files")).toMatchObject({ state: "broken", brokenBy: "user" });
      for (const itemId of [file.id, alpha.id]) {
        expect(
          events.filter((event) => event.scope === "item" && event.itemId === itemId && event.op === "update"),
        ).toHaveLength(1);
      }
    });

    it("putting a second project edge breaks the file's projects link", async () => {
      const { file, alpha, beta, projectsProperty } = await setup();
      await link(file.id, "projects");
      await chokePoint.createRelation(
        { relationPropertyId: projectsProperty.id, callerItemId: file.id, targetItemId: alpha.id },
        SYSTEM_WRITER,
      );
      expect(await linkOf(file.id, "projects")).toMatchObject({ state: "on" });

      await chokePoint.createRelation(
        { relationPropertyId: projectsProperty.id, callerItemId: file.id, targetItemId: beta.id },
        USER,
      );

      expect(await linkOf(file.id, "projects")).toMatchObject({ state: "broken", brokenBy: "user" });
    });

    it("putting the edge through the project's files property breaks the file's link", async () => {
      const { file, alpha, filesProperty } = await setup();
      await link(file.id, "projects");

      await chokePoint.createRelation(
        { relationPropertyId: filesProperty.id, callerItemId: alpha.id, targetItemId: file.id },
        AGENT,
      );

      expect(await linkOf(file.id, "projects")).toMatchObject({ state: "broken", brokenBy: "agent" });
    });

    it("deleting an edge breaks the link, deleting an absent edge does not", async () => {
      const { file, alpha, beta, projectsProperty } = await setup();
      await chokePoint.createRelation({
        relationPropertyId: projectsProperty.id,
        callerItemId: file.id,
        targetItemId: alpha.id,
      });
      await link(file.id, "projects");

      await chokePoint.deleteRelation(
        { relationPropertyId: projectsProperty.id, callerItemId: file.id, targetItemId: beta.id },
        USER,
      );
      expect(await linkOf(file.id, "projects")).toMatchObject({ state: "on" });

      await chokePoint.deleteRelation(
        { relationPropertyId: projectsProperty.id, callerItemId: file.id, targetItemId: alpha.id },
        USER,
      );
      expect(await linkOf(file.id, "projects")).toMatchObject({ state: "broken", brokenBy: "user" });
    });

    it("putting an existing edge and replacing metadata leave the link on", async () => {
      const { file, alpha, projectsProperty } = await setup();
      const edge = { relationPropertyId: projectsProperty.id, callerItemId: file.id, targetItemId: alpha.id };
      await chokePoint.createRelation(edge);
      await link(file.id, "projects");

      await chokePoint.createRelation({ ...edge, metadata: { note: "x" } }, USER);
      await chokePoint.updateRelation({ ...edge, metadata: { note: "y" } }, USER);

      expect(await linkOf(file.id, "projects")).toMatchObject({ state: "on" });
    });

    it("a system edge write leaves the link on", async () => {
      const { file, alpha, projectsProperty } = await setup();
      await link(file.id, "projects");

      await chokePoint.createRelation({
        relationPropertyId: projectsProperty.id,
        callerItemId: file.id,
        targetItemId: alpha.id,
      });

      expect(await linkOf(file.id, "projects")).toMatchObject({ state: "on" });
    });

    it("announces the item whose link state changed after the commit", async () => {
      const { files, file, alpha, projectsProperty } = await setup();
      await link(file.id, "projects");
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => events.push(event));
      try {
        await withTransaction(pool, async (client) => {
          await createRelationWithClient(
            client,
            { relationPropertyId: projectsProperty.id, callerItemId: file.id, targetItemId: alpha.id },
            undefined,
            USER,
          );
          expect(events).toEqual([]);
        });
      } finally {
        setInvalidationHook(() => {});
      }

      expect(events).toContainEqual(
        expect.objectContaining({ scope: "item", databaseId: files.id, itemId: file.id, op: "update" }),
      );
    });

    it("rolls back the edge and link without publishing an item invalidation", async () => {
      const { file, alpha, projectsProperty } = await setup();
      await link(file.id, "projects");
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => events.push(event));
      try {
        await expect(
          withTransaction(pool, async (client) => {
            await createRelationWithClient(
              client,
              { relationPropertyId: projectsProperty.id, callerItemId: file.id, targetItemId: alpha.id },
              undefined,
              USER,
            );
            expect(events).toEqual([]);
            throw new Error("abort relation");
          }),
        ).rejects.toThrow("abort relation");
        expect(events).toEqual([]);
      } finally {
        setInvalidationHook(() => {});
      }
      expect(await linkOf(file.id, "projects")).toMatchObject({ state: "on" });
      expect(await chokePoint.listItemRelations(file.id, projectsProperty.id)).toEqual([]);
    });
  });

  describe("valueLinks handoff", () => {
    it.each(["missing", "broken"] as const)(
      "rejects a date-off Tasks transform when an added user-key link is %s",
      async (state) => {
        await seedSystem(pool);
        const tenant = getTenantZeroId();
        await withRuntimePool(async (runtime) => {
          const cp = createChokePoint(runtime);
          const task = await runInTenant(tenant, async () => {
            const db = (await cp.listDatabases()).find((entry) => entry.key === "tasks");
            if (!db) throw new Error("Missing Tasks database");
            return cp.createItem({
              databaseId: db.id,
              properties: { name: "Timed", date: "2026-10-13", timeFrom: "10:00", timeTo: "11:00" },
            });
          });
          await withTenantTransaction(runtime, tenant, async (client) => {
            for (const propertyKey of ["date", "timeFrom"]) {
              await insertValueLink(client, { itemId: task.id, propertyKey, ruleKey: "test", sources: [] });
            }
            if (state === "broken") {
              await insertValueLink(client, {
                itemId: task.id,
                propertyKey: "timeTo",
                ruleKey: "test",
                state: "broken",
                brokenBy: "user",
                brokenAt: new Date("2026-01-01T00:00:00Z"),
                sources: [],
              });
            }
          });
          const events: InvalidationEvent[] = [];
          setInvalidationHook((event) => events.push(event));
          try {
            await expect(
              runInTenant(tenant, () =>
                withTransaction(runtime, (client) =>
                  updateItemWithClient(
                    client,
                    { databaseId: task.databaseId, itemId: task.id, propertiesPatch: { date: null } },
                    { systemOwnerProcess: VALUE_LINKS_OWNER_PROCESS, writer: SYSTEM_WRITER },
                  ),
                ),
              ),
            ).rejects.toMatchObject({ status: 403, code: "owner_violation" });
            expect(events).toEqual([]);
          } finally {
            setInvalidationHook(() => {});
          }
          expect((await runInTenant(tenant, () => cp.getItem(task.databaseId, task.id)))?.properties).toEqual(
            task.properties,
          );
          const links = await withTenantTransaction(runtime, tenant, (client) =>
            listValueLinksByItemIds(client, [task.id]),
          );
          expect(links.map((entry) => [entry.propertyKey, entry.state])).toEqual(
            state === "missing"
              ? [
                  ["date", "on"],
                  ["timeFrom", "on"],
                ]
              : [
                  ["date", "on"],
                  ["timeFrom", "on"],
                  ["timeTo", "broken"],
                ],
          );
        });
      },
    );

    it("allows a date-off Tasks transform when every added user key has an on link", async () => {
      await seedSystem(pool);
      const tenant = getTenantZeroId();
      await withRuntimePool(async (runtime) => {
        const cp = createChokePoint(runtime);
        const task = await runInTenant(tenant, async () => {
          const db = (await cp.listDatabases()).find((entry) => entry.key === "tasks");
          if (!db) throw new Error("Missing Tasks database");
          return cp.createItem({
            databaseId: db.id,
            properties: { name: "Timed", date: "2026-10-13", timeFrom: "10:00", timeTo: "11:00" },
          });
        });
        await withTenantTransaction(runtime, tenant, async (client) => {
          for (const propertyKey of ["date", "timeFrom", "timeTo"]) {
            await insertValueLink(client, { itemId: task.id, propertyKey, ruleKey: "test", sources: [] });
          }
        });
        const result = await runInTenant(tenant, () =>
          withTransaction(runtime, (client) =>
            updateItemWithClient(
              client,
              { databaseId: task.databaseId, itemId: task.id, propertiesPatch: { date: null } },
              { systemOwnerProcess: VALUE_LINKS_OWNER_PROCESS, writer: SYSTEM_WRITER },
            ),
          ),
        );
        expect(result.properties).toMatchObject({ date: null, timeFrom: null, timeTo: null, time: null });
        const links = await withTenantTransaction(runtime, tenant, (client) =>
          listValueLinksByItemIds(client, [task.id]),
        );
        expect(links.map((entry) => entry.state)).toEqual(["on", "on", "on"]);
      });
    });

    it("requires handoff even when a transform-added null equals the stored value", async () => {
      await seedSystem(pool);
      const tenant = getTenantZeroId();
      await withRuntimePool(async (runtime) => {
        const cp = createChokePoint(runtime);
        const task = await runInTenant(tenant, async () => {
          const db = (await cp.listDatabases()).find((entry) => entry.key === "tasks");
          if (!db) throw new Error("Missing Tasks database");
          return cp.createItem({ databaseId: db.id, properties: { name: "Undated" } });
        });
        await withTenantTransaction(runtime, tenant, (client) =>
          insertValueLink(client, {
            itemId: task.id,
            propertyKey: "date",
            ruleKey: "test",
            sources: [],
          }),
        );
        await expect(
          runInTenant(tenant, () =>
            withTransaction(runtime, (client) =>
              updateItemWithClient(
                client,
                { databaseId: task.databaseId, itemId: task.id, propertiesPatch: { date: null } },
                { systemOwnerProcess: VALUE_LINKS_OWNER_PROCESS, writer: SYSTEM_WRITER },
              ),
            ),
          ),
        ).rejects.toMatchObject({ status: 403, code: "owner_violation" });
        expect((await runInTenant(tenant, () => cp.getItem(task.databaseId, task.id)))?.properties).toEqual(
          task.properties,
        );
      });
    });

    async function relationWrites(client: PoolClient, fx: Awaited<ReturnType<typeof setup>>) {
      const edge = { relationPropertyId: fx.projectsProperty.id, callerItemId: fx.file.id, targetItemId: fx.alpha.id };
      return {
        create: () => createRelationWithClient(client, edge, VALUE_LINKS),
        update: () => updateRelationWithClient(client, { ...edge, metadata: {} }, VALUE_LINKS),
        remove: () => deleteRelationWithClient(client, edge, VALUE_LINKS),
      };
    }

    it("rejects a user-owned relation write without a link row", async () => {
      const fx = await setup();
      await withTransaction(pool, async (client) => {
        const writes = await relationWrites(client, fx);
        await expect(writes.create()).rejects.toMatchObject({ code: "owner_violation" });
      });
      const { rows } = await pool.query("SELECT 1 FROM item_relations");
      expect(rows).toHaveLength(0);
    });

    it("rejects every relation write with a broken row", async () => {
      const fx = await setup();
      await link(fx.file.id, "projects", "broken");
      for (const name of ["create", "update", "remove"] as const) {
        await withTransaction(pool, async (client) => {
          const writes = await relationWrites(client, fx);
          await expect(writes[name]()).rejects.toMatchObject({ code: "owner_violation" });
        });
      }
    });

    it("writes with an on row and leaves the state on", async () => {
      const fx = await setup();
      await link(fx.file.id, "projects");

      await withTransaction(pool, async (client) => {
        const writes = await relationWrites(client, fx);
        await writes.create();
        await writes.remove();
      });

      expect(await linkOf(fx.file.id, "projects")).toMatchObject({ state: "on", brokenBy: null });
    });

    it("rejects a plain property write without an on row and writes nothing", async () => {
      const { files, file } = await setup();
      await expect(
        withTransaction(pool, (client) =>
          updateItemWithClient(
            client,
            { databaseId: files.id, itemId: file.id, propertiesPatch: { name: "z.pdf" } },
            { systemOwnerProcess: VALUE_LINKS_OWNER_PROCESS },
          ),
        ),
      ).rejects.toMatchObject({ code: "owner_violation" });

      const { rows } = await pool.query("SELECT properties->>'name' AS name FROM items WHERE id = $1", [file.id]);
      expect(rows[0].name).toBe("a.pdf");
    });

    it("writes a plain property with an on row and leaves the state on", async () => {
      const { files, file } = await setup();
      await link(file.id, "name");

      await withTransaction(pool, (client) =>
        updateItemWithClient(
          client,
          { databaseId: files.id, itemId: file.id, propertiesPatch: { name: "z.pdf" } },
          { systemOwnerProcess: VALUE_LINKS_OWNER_PROCESS },
        ),
      );

      expect(await linkOf(file.id, "name")).toMatchObject({ state: "on" });
      const { rows } = await pool.query("SELECT properties->>'name' AS name FROM items WHERE id = $1", [file.id]);
      expect(rows[0].name).toBe("z.pdf");
    });
  });

  describe("tenants", () => {
    it.each(["user-first", "system-first"] as const)(
      "diagnoses the existing item/link lock inversion with %s",
      async (order) => {
        const tenant = await createTestTenant(pool);
        await withRuntimePool(async (userPool) =>
          withRuntimePool(async (systemPool) => {
            const cp = createChokePoint(userPool);
            const fx = await runInTenant(tenant, () => setup(cp));
            await withTenantTransaction(userPool, tenant, (client) =>
              insertValueLink(client, {
                itemId: fx.file.id,
                propertyKey: "name",
                ruleKey: "test",
                sources: [],
              }),
            );
            const userHeld = barrier();
            const systemHeld = barrier();
            const releaseUser = barrier();
            const releaseSystem = barrier();
            let userClient: PoolClient | undefined;
            let systemClient: PoolClient | undefined;
            let userPid: number | undefined;
            let systemPid: number | undefined;
            const realUpdate = itemsStore.updateItemProperties;
            const realHandoff = valueLinksStore.lockOnValueLink;
            const updateSpy = vi.spyOn(itemsStore, "updateItemProperties").mockImplementation(async (client, input) => {
              const result = await realUpdate(client, input);
              if (client === userClient) {
                userHeld.resolve();
                await bounded(releaseUser.promise);
              }
              return result;
            });
            const handoffSpy = vi
              .spyOn(valueLinksStore, "lockOnValueLink")
              .mockImplementation(async (client, id, key) => {
                const found = await realHandoff(client, id, key);
                if (client === systemClient && found) {
                  systemHeld.resolve();
                  await bounded(releaseSystem.promise);
                }
                return found;
              });
            type Outcome = { ok: true } | { ok: false; error: unknown };
            const settled = (promise: Promise<unknown>): Promise<Outcome> =>
              promise.then(
                () => ({ ok: true }),
                (error: unknown) => ({ ok: false, error }),
              );
            const run = (kind: "user" | "system") =>
              settled(
                runInTenant(tenant, () =>
                  withTransaction(kind === "user" ? userPool : systemPool, async (client) => {
                    await client.query("SET LOCAL statement_timeout = '7s'");
                    const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
                    if (!pid) throw new Error("Missing operation PID");
                    if (kind === "user") {
                      userClient = client;
                      userPid = pid;
                    } else {
                      systemClient = client;
                      systemPid = pid;
                    }
                    return updateItemWithClient(
                      client,
                      { databaseId: fx.files.id, itemId: fx.file.id, propertiesPatch: { name: kind } },
                      kind === "user"
                        ? { writer: USER }
                        : { systemOwnerProcess: VALUE_LINKS_OWNER_PROCESS, writer: SYSTEM_WRITER },
                    );
                  }),
                ),
              );
            let user: Promise<Outcome> | undefined;
            let system: Promise<Outcome> | undefined;
            let failure: unknown;
            const events: InvalidationEvent[] = [];
            setInvalidationHook((event) => events.push(event));
            try {
              if (order === "user-first") {
                user = run("user");
                await bounded(userHeld.promise);
                system = run("system");
                await bounded(systemHeld.promise);
                if (!userPid || !systemPid) throw new Error("Missing participant PID");
                releaseSystem.resolve();
                await waitBlocked(userPid, systemPid);
                releaseUser.resolve();
              } else {
                system = run("system");
                await bounded(systemHeld.promise);
                user = run("user");
                await bounded(userHeld.promise);
                if (!userPid || !systemPid) throw new Error("Missing participant PID");
                releaseUser.resolve();
                await waitBlocked(systemPid, userPid);
                releaseSystem.resolve();
              }
              const results = await bounded(Promise.all([user, system]));
              const failed = results.filter((result) => !result.ok);
              const codes = failed.map((result) => {
                if (result.ok || typeof result.error !== "object" || result.error === null || !("code" in result.error))
                  return null;
                return result.error.code;
              });
              console.info("value-link diagnostic", { order, userPid, systemPid, codes });
              expect(codes).toEqual(["40P01"]);
              expect(results.filter((result) => result.ok)).toHaveLength(1);
              expect(events.filter((event) => event.scope === "item" && event.itemId === fx.file.id)).toHaveLength(1);
              const current = await runInTenant(tenant, () => cp.getItem(fx.files.id, fx.file.id));
              const links = await withTenantTransaction(userPool, tenant, (client) =>
                listValueLinksByItemIds(client, [fx.file.id]),
              );
              if (results[0]?.ok) {
                expect(current?.properties.name).toBe("user");
                expect(links[0]).toMatchObject({ state: "broken", brokenBy: "user" });
              } else {
                expect(current?.properties.name).toBe("system");
                expect(links[0]).toMatchObject({ state: "on" });
              }
            } catch (error) {
              failure = error;
            } finally {
              releaseUser.resolve();
              releaseSystem.resolve();
              const participants = [user, system].filter((value): value is Promise<Outcome> => value !== undefined);
              const cleanupErrors: unknown[] = [];
              try {
                await bounded(Promise.all(participants), 9000);
              } catch (cleanupError) {
                cleanupErrors.push(cleanupError);
                for (const pid of [userPid, systemPid]) {
                  if (pid) {
                    try {
                      await bounded(
                        pool.query<{ terminated: boolean }>("SELECT pg_terminate_backend($1::int) AS terminated", [
                          pid,
                        ]),
                      );
                    } catch (error) {
                      cleanupErrors.push(error);
                    }
                  }
                }
                try {
                  await bounded(Promise.all(participants));
                } catch (error) {
                  cleanupErrors.push(error);
                }
              }
              updateSpy.mockRestore();
              handoffSpy.mockRestore();
              setInvalidationHook(() => {});
              if (cleanupErrors.length) {
                failure = new AggregateError(
                  failure === undefined ? cleanupErrors : [failure, ...cleanupErrors],
                  "Diagnostic and cleanup failed",
                );
              }
            }
            if (failure !== undefined) throw failure;
          }),
        );
      },
      30000,
    );

    it("enforces handoff and preserves unchanged links on scoped runtime connections without overlap", async () => {
      const tenant = await createTestTenant(pool);
      await withRuntimePool(async (runtime) => {
        const cp = createChokePoint(runtime);
        const fx = await runInTenant(tenant, () => setup(cp));
        const write = (value: string) =>
          runInTenant(tenant, () =>
            withTransaction(runtime, (client) =>
              updateItemWithClient(
                client,
                { databaseId: fx.files.id, itemId: fx.file.id, propertiesPatch: { name: value } },
                { systemOwnerProcess: VALUE_LINKS_OWNER_PROCESS, writer: SYSTEM_WRITER },
              ),
            ),
          );
        await expect(write("blocked")).rejects.toMatchObject({ status: 403, code: "owner_violation" });
        await withTenantTransaction(runtime, tenant, (client) =>
          insertValueLink(client, {
            itemId: fx.file.id,
            propertyKey: "name",
            ruleKey: "test",
            sources: [],
          }),
        );
        await expect(write("system")).resolves.toMatchObject({ properties: { name: "system" } });
        await runInTenant(tenant, () =>
          cp.updateItem(
            { databaseId: fx.files.id, itemId: fx.file.id, propertiesPatch: { name: "system" } },
            undefined,
            undefined,
            USER,
          ),
        );
        const read = () =>
          withTenantTransaction(runtime, tenant, (client) => listValueLinksByItemIds(client, [fx.file.id]));
        expect((await read())[0]).toMatchObject({ state: "on" });
        await runInTenant(tenant, () =>
          cp.updateItem(
            { databaseId: fx.files.id, itemId: fx.file.id, propertiesPatch: { name: "user" } },
            undefined,
            undefined,
            USER,
          ),
        );
        expect((await read())[0]).toMatchObject({ state: "broken", brokenBy: "user" });
        await expect(write("blocked again")).rejects.toMatchObject({ status: 403, code: "owner_violation" });
        expect((await runInTenant(tenant, () => cp.getItem(fx.files.id, fx.file.id)))?.properties.name).toBe("user");
      });
    });

    it("never touches the links of another tenant", async () => {
      await resetDatabase(pool);
      const tenantA = await createTestTenant(pool);
      const tenantB = await createTestTenant(pool);
      const runtimePool = await createRuntimeRolePool(pool, "semprec_data");
      try {
        const cp = createChokePoint(runtimePool);
        const a = await runInTenant(tenantA, () => setup(cp));
        const b = await runInTenant(tenantB, () => setup(cp));
        await withTenantTransaction(runtimePool, tenantA, (client) =>
          insertValueLink(client, { itemId: a.file.id, propertyKey: "name", ruleKey: "test", sources: [] }),
        );
        await withTenantTransaction(runtimePool, tenantB, (client) =>
          insertValueLink(client, { itemId: b.file.id, propertyKey: "name", ruleKey: "test", sources: [] }),
        );

        await runInTenant(tenantB, () =>
          cp.updateItem(
            { databaseId: b.files.id, itemId: b.file.id, propertiesPatch: { name: "changed" } },
            undefined,
            undefined,
            USER,
          ),
        );

        const states = async (tenantId: string, itemId: string) =>
          withTenantTransaction(runtimePool, tenantId, (client) => listValueLinksByItemIds(client, [itemId]));
        expect((await states(tenantA, a.file.id))[0]).toMatchObject({ state: "on" });
        expect((await states(tenantB, b.file.id))[0]).toMatchObject({ state: "broken", brokenBy: "user" });
      } finally {
        await runtimePool.end();
      }
    });
  });
});
