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
import { runAfterCommit, withTransaction } from "../db/pool.js";
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
import { clearHooksForTests, registerItemPreWriteTransform } from "../chokePoint/hooks.js";
import * as valueLinksStore from "../chokePoint/valueLinksStore.js";
import * as inboxSourceGuard from "../inbox/inboxSourceGuard.js";
import { createInboxItemWithClient } from "../inbox/inboxStore.js";
import { createInboxTypeWithClient } from "../inbox/inboxTypesStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { enqueueRollupRecompute, rollupRecomputeJobKey } from "../rollup/recompute.js";
import { executeProposalSteps } from "../inbox/proposalSteps.js";

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

function throwFailure(error: unknown): never {
  if (error instanceof Error) throw error;
  throw new Error("Non-error test failure", { cause: error });
}

function requireSuccessful(outcome: { ok: true } | { ok: false; error: unknown }): void {
  if (!outcome.ok) throwFailure(outcome.error);
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
    await bounded(runtime.end(), 10000);
  } catch (error) {
    if ("error" in outcome)
      throw new AggregateError([outcome.error, error], "Test and runtime cleanup failed", { cause: error });
    throw error;
  }
  if ("error" in outcome) throwFailure(outcome.error);
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

async function settleOwned<T>(promise: Promise<T>, getPid: () => number | undefined): Promise<T> {
  let settled = false;
  const tracked = promise.finally(() => {
    settled = true;
  });
  try {
    return await bounded(tracked);
  } catch (initial) {
    if (settled) throw initial;
    let pid = getPid();
    if (!pid) {
      try {
        await bounded(tracked);
      } catch {
        pid = getPid();
      }
    }
    if (settled) throw initial;
    const errors: unknown[] = [initial];
    if (pid) {
      try {
        await bounded(pool.query("SELECT pg_terminate_backend($1::int)", [pid]));
      } catch (error) {
        errors.push(error);
      }
      try {
        await bounded(tracked);
      } catch (error) {
        errors.push(error);
      }
    }
    throw new AggregateError(errors, "Owned participant did not settle", { cause: initial });
  }
}

async function settleParticipants<T>(
  user: Promise<T> | undefined,
  system: Promise<T> | undefined,
  userPid: () => number | undefined,
  systemPid: () => number | undefined,
): Promise<unknown[]> {
  const owned: Promise<T>[] = [];
  if (user) owned.push(settleOwned(user, userPid));
  if (system) owned.push(settleOwned(system, systemPid));
  const results = await Promise.allSettled(owned);
  return results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
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
    it.each([
      ["timeFrom", "missing"],
      ["timeFrom", "broken"],
      ["timeTo", "missing"],
      ["timeTo", "broken"],
    ] as const)("rejects a date-off Tasks transform when the %s link is %s", async (missingKey, state) => {
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
          for (const propertyKey of ["date", "timeFrom", "timeTo"].filter((key) => key !== missingKey)) {
            await insertValueLink(client, { itemId: task.id, propertyKey, ruleKey: "test", sources: [] });
          }
          if (state === "broken") {
            await insertValueLink(client, {
              itemId: task.id,
              propertyKey: missingKey,
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
          ["date", "timeFrom", "timeTo"]
            .filter((key) => state !== "missing" || key !== missingKey)
            .map((key) => [key, key === missingKey ? "broken" : "on"]),
        );
      });
    });

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

    it.each(["timeFrom", "timeTo"] as const)(
      "requires handoff for unchanged transform-added null %s",
      async (missingKey) => {
        await seedSystem(pool);
        const tenant = getTenantZeroId();
        await withRuntimePool(async (runtime) => {
          const cp = createChokePoint(runtime);
          const task = await runInTenant(tenant, async () => {
            const db = (await cp.listDatabases()).find((entry) => entry.key === "tasks");
            if (!db) throw new Error("Missing Tasks database");
            return cp.createItem({ databaseId: db.id, properties: { name: "Undated" } });
          });
          await withTenantTransaction(runtime, tenant, async (client) => {
            for (const propertyKey of ["date", "timeFrom", "timeTo"].filter((key) => key !== missingKey)) {
              await insertValueLink(client, { itemId: task.id, propertyKey, ruleKey: "test", sources: [] });
            }
          });
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
      },
    );

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
    it("preserves Library rating validation on protected relation writes", async () => {
      await seedSystem(pool);
      const tenant = getTenantZeroId();
      await withRuntimePool(async (runtime) => {
        const cp = createChokePoint(runtime);
        const databases = await runInTenant(tenant, () => cp.listDatabases());
        const movies = databases.find((db) => db.ownerModuleId === "movies");
        const people = databases.find((db) => db.ownerModuleId === "people");
        if (!movies || !people) throw new Error("Missing seeded Library databases");
        const property = await runInTenant(tenant, () => cp.getPropertyByKey(movies.id, "watchedWith"));
        if (!property) throw new Error("Missing watchedWith relation");
        const [movie, person] = await runInTenant(tenant, async () => [
          await cp.createItem({ databaseId: movies.id, properties: { name: "Film" } }),
          await cp.createItem({ databaseId: people.id, properties: { name: "Person" } }),
        ]);
        await withTenantTransaction(runtime, tenant, (client) =>
          insertValueLink(client, { itemId: movie.id, propertyKey: "watchedWith", ruleKey: "test", sources: [] }),
        );
        const write = (rating: number) =>
          runInTenant(tenant, () =>
            withTransaction(runtime, (client) =>
              createRelationWithClient(
                client,
                {
                  relationPropertyId: property.id,
                  callerItemId: movie.id,
                  targetItemId: person.id,
                  metadata: { rating },
                },
                VALUE_LINKS,
                SYSTEM_WRITER,
              ),
            ),
          );
        const events: InvalidationEvent[] = [];
        setInvalidationHook((event) => events.push(event));
        try {
          await expect(write(6)).rejects.toMatchObject({ status: 400, code: "validation_failed" });
          expect(events).toEqual([]);
          expect(await runInTenant(tenant, () => cp.listItemRelations(movie.id, property.id))).toEqual([]);
          await expect(write(5)).resolves.toMatchObject({ metadata: { rating: 5 } });
          const links = await withTenantTransaction(runtime, tenant, (client) =>
            listValueLinksByItemIds(client, [movie.id]),
          );
          expect(links[0]).toMatchObject({ state: "on" });
        } finally {
          setInvalidationHook(() => {});
        }
      });
    });

    it("refuses a protected relation when a real proposal holds its definition and edge", async () => {
      const tenant = await createTestTenant(pool);
      await withRuntimePool(async (holderPool) =>
        withRuntimePool(async (contenderPool) => {
          const cp = createChokePoint(holderPool);
          const fx = await runInTenant(tenant, () => setup(cp));
          await runInTenant(tenant, () =>
            cp.createRelation({
              relationPropertyId: fx.projectsProperty.id,
              callerItemId: fx.file.id,
              targetItemId: fx.alpha.id,
            }),
          );
          await withTenantTransaction(holderPool, tenant, (client) =>
            insertValueLink(client, { itemId: fx.file.id, propertyKey: "projects", ruleKey: "test", sources: [] }),
          );
          const held = barrier();
          const release = barrier();
          let holderPid: number | undefined;
          let contenderPid: number | undefined;
          const holder = runInTenant(tenant, () =>
            withTransaction(holderPool, async (client) => {
              holderPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
              await executeProposalSteps(
                client,
                [
                  {
                    ref: "same",
                    op: "update",
                    role: "primary",
                    itemId: fx.file.id,
                    before: { relations: { projects: [fx.alpha.id] } },
                    after: { relations: { projects: [fx.alpha.id] } },
                  },
                ],
                { writer: USER, sourceInboxItemId: null },
              );
              held.resolve();
              await bounded(release.promise);
            }),
          ).then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
          );
          let failure: unknown;
          try {
            await bounded(held.promise);
            const definition = await withTenantTransaction(contenderPool, tenant, (client) =>
              relationsStore.getRelationDefinitionByPropertyId(client, fx.projectsProperty.id),
            );
            if (!definition) throw new Error("Missing relation definition");
            const lock = await pool.query<{ held: boolean }>(
              `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND granted
                 AND classid::bigint = ((hashtextextended($2::text, 0) >> 32) & 4294967295::bigint)
                 AND objid::bigint = (hashtextextended($2::text, 0) & 4294967295::bigint) AND objsubid = 1) AS held`,
              [holderPid, definition.id],
            );
            expect(lock.rows[0]?.held).toBe(true);
            await expect(
              runInTenant(tenant, () =>
                withTransaction(contenderPool, async (client) => {
                  contenderPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
                  return createRelationWithClient(
                    client,
                    { relationPropertyId: fx.projectsProperty.id, callerItemId: fx.file.id, targetItemId: fx.beta.id },
                    VALUE_LINKS,
                    SYSTEM_WRITER,
                  );
                }),
              ),
            ).rejects.toMatchObject({ status: 409, code: "value_link_busy" });
            expect(holderPid).toBeTypeOf("number");
            expect(contenderPid).toBeTypeOf("number");
          } catch (error) {
            failure = error;
          } finally {
            release.resolve();
            try {
              const result = await settleOwned(holder, () => holderPid);
              requireSuccessful(result);
            } catch (error) {
              failure =
                failure === undefined
                  ? error
                  : new AggregateError([failure, error], "Test and proposal cleanup failed");
            }
          }
          if (failure !== undefined) throwFailure(failure);
          const links = await withTenantTransaction(holderPool, tenant, (client) =>
            listValueLinksByItemIds(client, [fx.file.id]),
          );
          expect(links[0]).toMatchObject({ state: "on" });
        }),
      );
    }, 30000);

    it("rechecks an active prediction after a concurrent user breaks the link", async () => {
      const tenant = await createTestTenant(pool);
      await withRuntimePool(async (userPool) =>
        withRuntimePool(async (systemPool) => {
          const cp = createChokePoint(userPool);
          const fx = await runInTenant(tenant, () => setup(cp));
          const edge = {
            relationPropertyId: fx.projectsProperty.id,
            callerItemId: fx.file.id,
            targetItemId: fx.beta.id,
          };
          await runInTenant(tenant, () => cp.createRelation(edge));
          await withTenantTransaction(userPool, tenant, (client) =>
            insertValueLink(client, { itemId: fx.file.id, propertyKey: "projects", ruleKey: "test", sources: [] }),
          );
          const admitted = barrier();
          const release = barrier();
          let systemClient: PoolClient | undefined;
          let systemPid: number | undefined;
          let userPid: number | undefined;
          const original = relationsStore.lockExistingRelationNowait;
          const spy = vi
            .spyOn(relationsStore, "lockExistingRelationNowait")
            .mockImplementation(async (client, definitionId, itemA, itemB) => {
              await original(client, definitionId, itemA, itemB);
              if (client === systemClient) {
                admitted.resolve();
                await bounded(release.promise);
              }
            });
          const events: InvalidationEvent[] = [];
          setInvalidationHook((event) => events.push(event));
          const system = runInTenant(tenant, () =>
            withTransaction(systemPool, async (client) => {
              systemClient = client;
              systemPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
              return createRelationWithClient(
                client,
                { ...edge, targetItemId: fx.alpha.id },
                VALUE_LINKS,
                SYSTEM_WRITER,
              );
            }),
          ).then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
          );
          let failure: unknown;
          try {
            await bounded(admitted.promise);
            await runInTenant(tenant, () =>
              withTransaction(userPool, async (client) => {
                userPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
                await deleteRelationWithClient(client, edge, undefined, USER);
              }),
            );
            release.resolve();
            expect(await bounded(system)).toMatchObject({ ok: false, error: { status: 403, code: "owner_violation" } });
            expect(systemPid).toBeTypeOf("number");
            expect(userPid).toBeTypeOf("number");
            const links = await withTenantTransaction(userPool, tenant, (client) =>
              listValueLinksByItemIds(client, [fx.file.id]),
            );
            expect(links[0]).toMatchObject({ state: "broken", brokenBy: "user" });
            expect(await runInTenant(tenant, () => cp.listItemRelations(fx.file.id, fx.projectsProperty.id))).toEqual(
              [],
            );
            expect(events.filter((event) => event.scope === "item" && event.itemId === fx.file.id)).toHaveLength(1);
          } catch (error) {
            failure = error;
          } finally {
            release.resolve();
            try {
              await settleOwned(system, () => systemPid);
            } catch (error) {
              failure =
                failure === undefined ? error : new AggregateError([failure, error], "Test and system cleanup failed");
            }
            spy.mockRestore();
            setInvalidationHook(() => {});
          }
          if (failure !== undefined) throwFailure(failure);
        }),
      );
    }, 30000);

    it("refuses a protected update while the exact existing edge is held", async () => {
      const tenant = await createTestTenant(pool);
      await withRuntimePool(async (holderPool) =>
        withRuntimePool(async (contenderPool) => {
          const cp = createChokePoint(holderPool);
          const fx = await runInTenant(tenant, () => setup(cp));
          const edge = {
            relationPropertyId: fx.projectsProperty.id,
            callerItemId: fx.file.id,
            targetItemId: fx.alpha.id,
          };
          await runInTenant(tenant, () => cp.createRelation(edge));
          await withTenantTransaction(holderPool, tenant, (client) =>
            insertValueLink(client, { itemId: fx.file.id, propertyKey: "projects", ruleKey: "test", sources: [] }),
          );
          const held = barrier();
          const release = barrier();
          let holderPid: number | undefined;
          let contenderPid: number | undefined;
          const holder = runInTenant(tenant, () =>
            withTransaction(holderPool, async (client) => {
              holderPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
              await updateRelationWithClient(client, { ...edge, metadata: { holder: true } });
              held.resolve();
              await bounded(release.promise);
            }),
          ).then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
          );
          let failure: unknown;
          try {
            await bounded(held.promise);
            await expect(
              runInTenant(tenant, () =>
                withTransaction(contenderPool, async (client) => {
                  contenderPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
                  return updateRelationWithClient(
                    client,
                    { ...edge, metadata: { contender: true } },
                    VALUE_LINKS,
                    SYSTEM_WRITER,
                  );
                }),
              ),
            ).rejects.toMatchObject({ status: 409, code: "value_link_busy" });
            expect(holderPid).toBeTypeOf("number");
            expect(contenderPid).toBeTypeOf("number");
          } catch (error) {
            failure = error;
          } finally {
            release.resolve();
            try {
              const outcome = await settleOwned(holder, () => holderPid);
              requireSuccessful(outcome);
            } catch (error) {
              failure =
                failure === undefined ? error : new AggregateError([failure, error], "Test and holder cleanup failed");
            }
          }
          if (failure !== undefined) throwFailure(failure);
          const edges = await runInTenant(tenant, () => cp.listItemRelations(fx.file.id, fx.projectsProperty.id));
          expect(edges?.[0]?.metadata).toEqual({ holder: true });
        }),
      );
    }, 30000);

    it.each(["A", "B"] as const)(
      "admits protected create, replay, update and delete from definition side %s",
      async (side) => {
        const tenant = await createTestTenant(pool);
        await withRuntimePool(async (runtime) => {
          const cp = createChokePoint(runtime);
          const fx = await runInTenant(tenant, () => setup(cp));
          const edge =
            side === "A"
              ? { relationPropertyId: fx.projectsProperty.id, callerItemId: fx.file.id, targetItemId: fx.alpha.id }
              : { relationPropertyId: fx.filesProperty.id, callerItemId: fx.alpha.id, targetItemId: fx.file.id };
          const propertyKey = side === "A" ? "projects" : "files";
          await withTenantTransaction(runtime, tenant, (client) =>
            insertValueLink(client, { itemId: edge.callerItemId, propertyKey, ruleKey: "test", sources: [] }),
          );
          await runInTenant(tenant, () =>
            withTransaction(runtime, async (client) => {
              await createRelationWithClient(client, edge, VALUE_LINKS, SYSTEM_WRITER);
              await createRelationWithClient(
                client,
                { ...edge, metadata: { replay: true } },
                VALUE_LINKS,
                SYSTEM_WRITER,
              );
              await updateRelationWithClient(
                client,
                { ...edge, metadata: { update: true } },
                VALUE_LINKS,
                SYSTEM_WRITER,
              );
              expect(await deleteRelationWithClient(client, edge, VALUE_LINKS, SYSTEM_WRITER)).not.toBeNull();
              expect(await deleteRelationWithClient(client, edge, VALUE_LINKS, SYSTEM_WRITER)).toBeNull();
            }),
          );
          const links = await withTenantTransaction(runtime, tenant, (client) =>
            listValueLinksByItemIds(client, [edge.callerItemId]),
          );
          expect(links[0]).toMatchObject({ state: "on" });
        });
      },
    );

    it.each(["0", "5s"])(
      "restores the effective lock timeout %s after protected success and no-op",
      async (setting) => {
        const tenant = await createTestTenant(pool);
        await withRuntimePool(async (runtime) => {
          const cp = createChokePoint(runtime);
          const fx = await runInTenant(tenant, () => setup(cp));
          await withTenantTransaction(runtime, tenant, (client) =>
            insertValueLink(client, { itemId: fx.file.id, propertyKey: "projects", ruleKey: "test", sources: [] }),
          );
          await runInTenant(tenant, () =>
            withTransaction(runtime, async (client) => {
              await client.query("SELECT set_config('lock_timeout', $1, true)", [setting]);
              const read = async () =>
                (await client.query<{ setting: string }>("SELECT current_setting('lock_timeout') AS setting")).rows[0]
                  ?.setting;
              const before = await read();
              const edge = {
                relationPropertyId: fx.projectsProperty.id,
                callerItemId: fx.file.id,
                targetItemId: fx.alpha.id,
              };
              await createRelationWithClient(client, edge, VALUE_LINKS, SYSTEM_WRITER);
              expect(await read()).toBe(before);
              await createRelationWithClient(client, edge, VALUE_LINKS, SYSTEM_WRITER);
              expect(await read()).toBe(before);
              await deleteRelationWithClient(client, { ...edge, targetItemId: fx.beta.id }, VALUE_LINKS, SYSTEM_WRITER);
              expect(await read()).toBe(before);
            }),
          );
        });
      },
    );

    it("rejects an unmanaged client before prediction and protected hooks", async () => {
      const tenant = await createTestTenant(pool);
      await withRuntimePool(async (runtime) => {
        const cp = createChokePoint(runtime);
        const fx = await runInTenant(tenant, () => setup(cp));
        const client = await runtime.connect();
        const prediction = vi.spyOn(valueLinksStore, "lockOnValueLink");
        try {
          await client.query("SELECT set_config('app.tenant_id', $1, false)", [tenant]);
          await expect(
            runInTenant(tenant, () =>
              createRelationWithClient(
                client,
                { relationPropertyId: fx.projectsProperty.id, callerItemId: fx.file.id, targetItemId: fx.alpha.id },
                VALUE_LINKS,
                SYSTEM_WRITER,
              ),
            ),
          ).rejects.toThrow("active managed transaction");
          expect(prediction).not.toHaveBeenCalled();
        } finally {
          prediction.mockRestore();
          try {
            await client.query("SELECT set_config('app.tenant_id', '', false)");
          } finally {
            client.release();
          }
        }
      });
    });

    it("keeps a caught NOWAIT failure rollback-only after savepoint recovery", async () => {
      const tenant = await createTestTenant(pool);
      await withRuntimePool(async (holderPool) =>
        withRuntimePool(async (contenderPool) => {
          const cp = createChokePoint(holderPool);
          const fx = await runInTenant(tenant, () => setup(cp));
          const unrelated = await runInTenant(tenant, () =>
            cp.createItem({ databaseId: fx.files.id, properties: { name: "original" } }),
          );
          await withTenantTransaction(holderPool, tenant, (client) =>
            insertValueLink(client, { itemId: fx.file.id, propertyKey: "projects", ruleKey: "test", sources: [] }),
          );
          const held = barrier();
          const release = barrier();
          const callback = vi.fn();
          let holderPid: number | undefined;
          let competitorPid: number | undefined;
          const holder = runInTenant(tenant, () =>
            withTransaction(holderPool, async (client) => {
              holderPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
              await createRelationWithClient(
                client,
                { relationPropertyId: fx.projectsProperty.id, callerItemId: fx.file.id, targetItemId: fx.alpha.id },
                undefined,
                USER,
              );
              held.resolve();
              await bounded(release.promise);
            }),
          ).then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
          );
          let failure: unknown;
          try {
            await bounded(held.promise);
            await expect(
              runInTenant(tenant, () =>
                withTransaction(contenderPool, async (client) => {
                  competitorPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
                  await updateItemWithClient(
                    client,
                    { databaseId: fx.files.id, itemId: unrelated.id, propertiesPatch: { name: "before" } },
                    { writer: USER },
                  );
                  runAfterCommit(client, callback);
                  await client.query("SAVEPOINT relation_busy");
                  await expect(
                    updateRelationWithClient(
                      client,
                      {
                        relationPropertyId: fx.projectsProperty.id,
                        callerItemId: fx.file.id,
                        targetItemId: fx.beta.id,
                        metadata: {},
                      },
                      VALUE_LINKS,
                      SYSTEM_WRITER,
                    ),
                  ).rejects.toMatchObject({ status: 409, code: "value_link_busy" });
                  await client.query("ROLLBACK TO SAVEPOINT relation_busy");
                  await updateItemWithClient(
                    client,
                    { databaseId: fx.files.id, itemId: unrelated.id, propertiesPatch: { name: "after" } },
                    { writer: USER },
                  );
                }),
              ),
            ).rejects.toMatchObject({ status: 409, code: "value_link_busy" });
            expect(holderPid).toBeTypeOf("number");
            expect(competitorPid).toBeTypeOf("number");
            expect((await runInTenant(tenant, () => cp.getItem(fx.files.id, unrelated.id)))?.properties.name).toBe(
              "original",
            );
            expect(callback).not.toHaveBeenCalled();
          } catch (error) {
            failure = error;
          } finally {
            release.resolve();
            try {
              const result = await settleOwned(holder, () => holderPid);
              requireSuccessful(result);
            } catch (error) {
              failure =
                failure === undefined ? error : new AggregateError([failure, error], "Test and holder cleanup failed");
            }
          }
          if (failure !== undefined) throwFailure(failure);
        }),
      );
    }, 30000);

    it("rolls back all earlier and later writes when caught advisory busy reaches the transaction owner", async () => {
      const tenant = await createTestTenant(pool);
      await withRuntimePool(async (holderPool) =>
        withRuntimePool(async (contenderPool) => {
          const cp = createChokePoint(holderPool);
          const fx = await runInTenant(tenant, () => setup(cp));
          const unrelated = await runInTenant(tenant, () =>
            cp.createItem({ databaseId: fx.files.id, properties: { name: "original" } }),
          );
          const rollup = await runInTenant(tenant, () =>
            cp.createProperty({
              databaseId: fx.files.id,
              key: "projectCount",
              name: "Project count",
              type: "rollup",
              config: { relationPropertyKey: "projects", aggregation: "count" },
            }),
          );
          const jobKey = rollupRecomputeJobKey(rollup.id, unrelated.id);
          const jobCount = async () =>
            (
              await pool.query<{ count: string }>(
                "SELECT count(*)::text AS count FROM graphile_worker._private_jobs WHERE key = $1",
                [jobKey],
              )
            ).rows[0]?.count;
          expect(await jobCount()).toBe("0");
          await runInTenant(tenant, () =>
            cp.createRelation({
              relationPropertyId: fx.projectsProperty.id,
              callerItemId: fx.file.id,
              targetItemId: fx.alpha.id,
            }),
          );
          await withTenantTransaction(holderPool, tenant, (client) =>
            insertValueLink(client, { itemId: fx.file.id, propertyKey: "projects", ruleKey: "test", sources: [] }),
          );
          const held = barrier();
          const release = barrier();
          let holderPid: number | undefined;
          let competitorPid: number | undefined;
          const events: InvalidationEvent[] = [];
          const callback = vi.fn();
          setInvalidationHook((event) => events.push(event));
          const holder = runInTenant(tenant, () =>
            withTransaction(holderPool, async (client) => {
              holderPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
              await executeProposalSteps(
                client,
                [
                  {
                    ref: "same",
                    op: "update",
                    role: "primary",
                    itemId: fx.file.id,
                    before: { relations: { projects: [fx.alpha.id] } },
                    after: { relations: { projects: [fx.alpha.id] } },
                  },
                ],
                { writer: USER, sourceInboxItemId: null },
              );
              held.resolve();
              await bounded(release.promise);
            }),
          );
          const settledHolder = holder.then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
          );
          let failure: unknown;
          try {
            await bounded(held.promise);
            await expect(
              runInTenant(tenant, () =>
                withTransaction(contenderPool, async (client) => {
                  competitorPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
                  await updateItemWithClient(
                    client,
                    { databaseId: fx.files.id, itemId: unrelated.id, propertiesPatch: { name: "before" } },
                    { writer: USER },
                  );
                  await enqueueRollupRecompute(client, rollup.id, unrelated.id);
                  runAfterCommit(client, callback);
                  await expect(
                    createRelationWithClient(
                      client,
                      {
                        relationPropertyId: fx.projectsProperty.id,
                        callerItemId: fx.file.id,
                        targetItemId: fx.beta.id,
                      },
                      VALUE_LINKS,
                      SYSTEM_WRITER,
                    ),
                  ).rejects.toMatchObject({ status: 409, code: "value_link_busy" });
                  await updateItemWithClient(
                    client,
                    { databaseId: fx.files.id, itemId: unrelated.id, propertiesPatch: { name: "after" } },
                    { writer: USER },
                  );
                }),
              ),
            ).rejects.toMatchObject({ status: 409, code: "value_link_busy" });
            expect(holderPid).toBeTypeOf("number");
            expect(competitorPid).toBeTypeOf("number");
            expect((await runInTenant(tenant, () => cp.getItem(fx.files.id, unrelated.id)))?.properties.name).toBe(
              "original",
            );
            expect(events.filter((event) => event.scope === "item" && event.itemId === unrelated.id)).toEqual([]);
            expect(callback).not.toHaveBeenCalled();
            expect(await jobCount()).toBe("0");
          } catch (error) {
            failure = error;
          } finally {
            release.resolve();
            try {
              const result = await settleOwned(settledHolder, () => holderPid);
              requireSuccessful(result);
            } catch (error) {
              failure =
                failure === undefined ? error : new AggregateError([failure, error], "Test and holder cleanup failed");
            } finally {
              setInvalidationHook(() => {});
            }
          }
          if (failure !== undefined) throwFailure(failure);
        }),
      );
    }, 30000);

    it("diagnoses a populated rollup job and relation handoff cycle", async () => {
      const tenant = await createTestTenant(pool);
      await withRuntimePool(async (userPool) =>
        withRuntimePool(async (systemPool) => {
          const cp = createChokePoint(userPool);
          const fx = await runInTenant(tenant, () => setup(cp));
          const gamma = await runInTenant(tenant, async () => {
            await cp.createProperty({ databaseId: fx.alpha.databaseId, key: "hours", name: "Hours", type: "number" });
            await cp.updateItem({
              databaseId: fx.alpha.databaseId,
              itemId: fx.alpha.id,
              propertiesPatch: { hours: 1 },
            });
            const third = await cp.createItem({ databaseId: fx.alpha.databaseId, properties: { hours: 3 } });
            await cp.createProperty({
              databaseId: fx.files.id,
              key: "totalHours",
              name: "Total hours",
              type: "rollup",
              config: { relationPropertyKey: "projects", aggregation: "sum", targetPropertyKey: "hours" },
            });
            await cp.createRelation({
              relationPropertyId: fx.projectsProperty.id,
              callerItemId: fx.file.id,
              targetItemId: fx.alpha.id,
            });
            await cp.createRelation({
              relationPropertyId: fx.projectsProperty.id,
              callerItemId: fx.file.id,
              targetItemId: fx.beta.id,
            });
            return third;
          });
          const rollup = await runInTenant(tenant, () => cp.getPropertyByKey(fx.files.id, "totalHours"));
          if (!rollup) throw new Error("Missing rollup property");
          const jobKey = rollupRecomputeJobKey(rollup.id, fx.file.id);
          const beforeJob = await pool.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM graphile_worker._private_jobs WHERE key = $1",
            [jobKey],
          );
          expect(beforeJob.rows[0]?.count).toBe("1");
          await withTenantTransaction(userPool, tenant, (client) =>
            insertValueLink(client, { itemId: fx.file.id, propertyKey: "projects", ruleKey: "test", sources: [] }),
          );
          const jobHeld = barrier();
          const linkHeld = barrier();
          const releaseJob = barrier();
          const releaseLink = barrier();
          let userClient: PoolClient | undefined;
          let systemClient: PoolClient | undefined;
          let userPid: number | undefined;
          let systemPid: number | undefined;
          const originalLink = valueLinksStore.lockOnValueLink;
          const linkSpy = vi
            .spyOn(valueLinksStore, "lockOnValueLink")
            .mockImplementation(async (client, id, key, mode) => {
              const result = await originalLink(client, id, key, mode);
              if (client === systemClient && result && mode === "nowait") {
                linkHeld.resolve();
                await bounded(releaseLink.promise);
              }
              return result;
            });
          type Outcome = { ok: true } | { ok: false; error: unknown };
          const run = (kind: "user" | "system"): Promise<Outcome> =>
            runInTenant(tenant, () =>
              withTransaction(kind === "user" ? userPool : systemPool, async (client) => {
                await client.query("SET LOCAL statement_timeout = '7s'");
                const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
                if (!pid) throw new Error("Missing queue participant PID");
                if (kind === "user") {
                  userClient = client;
                  userPid = pid;
                  await updateItemWithClient(
                    client,
                    { databaseId: fx.alpha.databaseId, itemId: fx.alpha.id, propertiesPatch: { hours: 2 } },
                    { writer: USER },
                  );
                  jobHeld.resolve();
                  await bounded(releaseJob.promise);
                  return deleteRelationWithClient(
                    client,
                    { relationPropertyId: fx.projectsProperty.id, callerItemId: fx.file.id, targetItemId: fx.beta.id },
                    undefined,
                    USER,
                  );
                }
                systemClient = client;
                systemPid = pid;
                return createRelationWithClient(
                  client,
                  { relationPropertyId: fx.projectsProperty.id, callerItemId: fx.file.id, targetItemId: gamma.id },
                  VALUE_LINKS,
                  SYSTEM_WRITER,
                );
              }),
            ).then(
              () => ({ ok: true }),
              (error: unknown) => ({ ok: false, error }),
            );
          let user: Promise<Outcome> | undefined;
          let system: Promise<Outcome> | undefined;
          let failure: unknown;
          const events: InvalidationEvent[] = [];
          setInvalidationHook((event) => events.push(event));
          try {
            user = run("user");
            await bounded(jobHeld.promise);
            system = run("system");
            await bounded(linkHeld.promise);
            if (!userPid || !systemPid || !userClient) throw new Error("Missing queue participant PID");
            releaseLink.resolve();
            const systemOutcome = await bounded(system);
            expect(systemOutcome).toMatchObject({ ok: false, error: { status: 409, code: "value_link_busy" } });
            releaseJob.resolve();
            const outcomes = await bounded(Promise.all([user, system]));
            console.info("Observed populated rollup cycle", { userPid, systemPid, jobKey, outcomes });
            expect(outcomes.filter((result) => result.ok)).toHaveLength(1);
            expect(outcomes.filter((result) => !result.ok)).toMatchObject([{ error: { code: "value_link_busy" } }]);
            const links = await withTenantTransaction(userPool, tenant, (client) =>
              listValueLinksByItemIds(client, [fx.file.id]),
            );
            const edges = await runInTenant(tenant, () => cp.listItemRelations(fx.file.id, fx.projectsProperty.id));
            const targetIds = edges?.map((edge) => edge.targetItemId) ?? [];
            const alpha = await runInTenant(tenant, () => cp.getItem(fx.alpha.databaseId, fx.alpha.id));
            expect(links[0]).toMatchObject(outcomes[0]?.ok ? { state: "broken", brokenBy: "user" } : { state: "on" });
            expect(alpha?.properties.hours).toBe(outcomes[0]?.ok ? 2 : 1);
            expect(targetIds.includes(fx.beta.id)).toBe(!outcomes[0]?.ok);
            expect(targetIds.includes(gamma.id)).toBe(Boolean(outcomes[1]?.ok));
            expect(events.filter((event) => event.scope === "item" && event.itemId === fx.alpha.id)).toHaveLength(
              outcomes[0]?.ok ? 1 : 0,
            );
            expect(events.filter((event) => event.scope === "item" && event.itemId === fx.file.id)).toHaveLength(1);
            const afterJob = await pool.query<{ count: string }>(
              "SELECT count(*)::text AS count FROM graphile_worker._private_jobs WHERE key = $1",
              [jobKey],
            );
            expect(afterJob.rows[0]?.count).toBe("1");
          } catch (error) {
            failure = error;
          } finally {
            releaseJob.resolve();
            releaseLink.resolve();
            const errors = await settleParticipants(
              user,
              system,
              () => userPid,
              () => systemPid,
            );
            linkSpy.mockRestore();
            setInvalidationHook(() => {});
            if (errors.length)
              failure = new AggregateError(
                failure === undefined ? errors : [failure, ...errors],
                "Rollup diagnostic cleanup failed",
              );
          }
          if (failure !== undefined) throwFailure(failure);
        }),
      );
    }, 30000);

    it.each(["system-first", "user-first"] as const)(
      "diagnoses relation definition advisory and handoff with %s",
      async (order) => {
        const tenant = await createTestTenant(pool);
        await withRuntimePool(async (userPool) =>
          withRuntimePool(async (systemPool) => {
            const cp = createChokePoint(userPool);
            const fx = await runInTenant(tenant, () => setup(cp));
            await withTenantTransaction(userPool, tenant, (client) =>
              insertValueLink(client, { itemId: fx.file.id, propertyKey: "projects", ruleKey: "test", sources: [] }),
            );
            const edgeHeld = barrier();
            const userStarted = barrier();
            const linkHeld = barrier();
            const releaseEdge = barrier();
            const releaseLink = barrier();
            let userClient: PoolClient | undefined;
            let systemClient: PoolClient | undefined;
            let userPid: number | undefined;
            let systemPid: number | undefined;
            const originalInsert = relationsStore.createItemRelationReportingInsert;
            const originalLink = valueLinksStore.lockOnValueLink;
            const edgeSpy = vi
              .spyOn(relationsStore, "createItemRelationReportingInsert")
              .mockImplementation(async (client, input) => {
                const result = await originalInsert(client, input);
                if (client === userClient) {
                  edgeHeld.resolve();
                  await bounded(releaseEdge.promise);
                }
                return result;
              });
            const linkSpy = vi
              .spyOn(valueLinksStore, "lockOnValueLink")
              .mockImplementation(async (client, id, key, mode) => {
                const result = await originalLink(client, id, key, mode);
                if (client === systemClient && result && mode === "nowait") {
                  linkHeld.resolve();
                  await bounded(releaseLink.promise);
                }
                return result;
              });
            type Outcome = { ok: true } | { ok: false; error: unknown };
            const run = (kind: "user" | "system"): Promise<Outcome> =>
              runInTenant(tenant, () =>
                withTransaction(kind === "user" ? userPool : systemPool, async (client) => {
                  await client.query("SET LOCAL statement_timeout = '7s'");
                  const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
                  if (!pid) throw new Error("Missing relation participant PID");
                  if (kind === "user") {
                    userClient = client;
                    userPid = pid;
                    userStarted.resolve();
                  } else {
                    systemClient = client;
                    systemPid = pid;
                  }
                  return createRelationWithClient(
                    client,
                    {
                      relationPropertyId: fx.projectsProperty.id,
                      callerItemId: fx.file.id,
                      targetItemId: kind === "user" ? fx.alpha.id : fx.beta.id,
                    },
                    kind === "system" ? VALUE_LINKS : undefined,
                    kind === "user" ? USER : SYSTEM_WRITER,
                  );
                }),
              ).then(
                () => ({ ok: true }),
                (error: unknown) => ({ ok: false, error }),
              );
            let user: Promise<Outcome> | undefined;
            let system: Promise<Outcome> | undefined;
            let failure: unknown;
            const events: InvalidationEvent[] = [];
            setInvalidationHook((event) => events.push(event));
            try {
              if (order === "system-first") {
                system = run("system");
                await bounded(linkHeld.promise);
                user = run("user");
                await bounded(userStarted.promise);
                if (!userPid || !systemPid) throw new Error("Missing relation participant PID");
                await waitBlocked(systemPid, userPid);
                releaseLink.resolve();
                releaseEdge.resolve();
              } else {
                user = run("user");
                await bounded(edgeHeld.promise);
                system = run("system");
                expect(await bounded(system)).toMatchObject({
                  ok: false,
                  error: { code: "value_link_busy", status: 409 },
                });
                releaseEdge.resolve();
              }
              const outcomes = await bounded(Promise.all([user, system]));
              console.info("Relation advisory admission", { order, userPid, systemPid });
              expect(outcomes[0]).toEqual({ ok: true });
              if (order === "system-first") expect(outcomes[1]).toEqual({ ok: true });
              else expect(outcomes[1]).toMatchObject({ ok: false, error: { code: "value_link_busy" } });
              const links = await withTenantTransaction(userPool, tenant, (client) =>
                listValueLinksByItemIds(client, [fx.file.id]),
              );
              expect(links[0]).toMatchObject(outcomes[0]?.ok ? { state: "broken", brokenBy: "user" } : { state: "on" });
              expect(events.filter((event) => event.scope === "item" && event.itemId === fx.file.id)).toHaveLength(1);
              const edges = await runInTenant(tenant, () => cp.listItemRelations(fx.file.id, fx.projectsProperty.id));
              expect(edges).toHaveLength(order === "system-first" ? 2 : 1);
            } catch (error) {
              failure = error;
            } finally {
              releaseEdge.resolve();
              releaseLink.resolve();
              const errors = await settleParticipants(
                user,
                system,
                () => userPid,
                () => systemPid,
              );
              edgeSpy.mockRestore();
              linkSpy.mockRestore();
              setInvalidationHook(() => {});
              if (errors.length)
                failure = new AggregateError(
                  failure === undefined ? errors : [failure, ...errors],
                  "Relation diagnostic cleanup failed",
                );
            }
            if (failure !== undefined) throwFailure(failure);
          }),
        );
      },
      30000,
    );

    it.each(["system-first", "user-first"] as const)(
      "diagnoses the supported Inbox source and relation handoff with %s",
      async (order) => {
        await seedSystem(pool);
        const tenant = getTenantZeroId();
        await withRuntimePool(async (userPool) =>
          withRuntimePool(async (systemPool) => {
            const cp = createChokePoint(userPool);
            const databases = await runInTenant(tenant, () => cp.listDatabases());
            const inbox = databases.find((db) => db.ownerModuleId === "inbox");
            const types = databases.find((db) => db.ownerModuleId === "inboxItemTypes");
            if (!inbox || !types) throw new Error("Missing seeded Inbox databases");
            const property = await runInTenant(tenant, () => cp.getPropertyByKey(inbox.id, "type"));
            if (!property) throw new Error("Missing Inbox type relation");
            const fixture = await withTenantTransaction(userPool, tenant, async (client) => {
              const type = await createInboxTypeWithClient(client, {
                inboxItemTypesDatabaseId: types.id,
                name: "Task",
                emoji: "T",
                processingMethod: "database",
                targetDatabase: "tasks",
              });
              const other = await createInboxTypeWithClient(client, {
                inboxItemTypesDatabaseId: types.id,
                name: "Page",
                emoji: "P",
                processingMethod: "pageContent",
              });
              const item = await createInboxItemWithClient(client, {
                inboxDatabaseId: inbox.id,
                date: "2026-10-01",
                time: "09:00",
                text: "Source",
              });
              await insertValueLink(client, { itemId: item.id, propertyKey: "type", ruleKey: "test", sources: [] });
              return { item, type, other };
            });
            const sourceHeld = barrier();
            const userStarted = barrier();
            const linkHeld = barrier();
            const releaseSource = barrier();
            const releaseLink = barrier();
            let userClient: PoolClient | undefined;
            let systemClient: PoolClient | undefined;
            let userPid: number | undefined;
            let systemPid: number | undefined;
            const originalSource = inboxSourceGuard.lockInboxSource;
            const originalLink = valueLinksStore.lockOnValueLink;
            const sourceSpy = vi
              .spyOn(inboxSourceGuard, "lockInboxSource")
              .mockImplementation(async (client, id, allowDeleted, mode) => {
                await originalSource(client, id, allowDeleted, mode);
                if (client === userClient) {
                  sourceHeld.resolve();
                  await bounded(releaseSource.promise);
                }
              });
            const linkSpy = vi
              .spyOn(valueLinksStore, "lockOnValueLink")
              .mockImplementation(async (client, id, key, mode) => {
                const found = await originalLink(client, id, key, mode);
                if (client === systemClient && found && mode === "nowait") {
                  linkHeld.resolve();
                  await bounded(releaseLink.promise);
                }
                return found;
              });
            type Outcome = { ok: true } | { ok: false; error: unknown };
            const run = (kind: "user" | "system"): Promise<Outcome> =>
              runInTenant(tenant, () =>
                withTransaction(kind === "user" ? userPool : systemPool, async (client) => {
                  await client.query("SET LOCAL statement_timeout = '7s'");
                  const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
                  if (!pid) throw new Error("Missing relation participant PID");
                  if (kind === "user") {
                    userClient = client;
                    userPid = pid;
                    userStarted.resolve();
                  } else {
                    systemClient = client;
                    systemPid = pid;
                  }
                  return createRelationWithClient(
                    client,
                    {
                      relationPropertyId: property.id,
                      callerItemId: fixture.item.id,
                      targetItemId: kind === "user" ? fixture.type.id : fixture.other.id,
                    },
                    kind === "system" ? VALUE_LINKS : undefined,
                    kind === "user" ? USER : SYSTEM_WRITER,
                  );
                }),
              ).then(
                () => ({ ok: true }),
                (error: unknown) => ({ ok: false, error }),
              );
            let user: Promise<Outcome> | undefined;
            let system: Promise<Outcome> | undefined;
            let failure: unknown;
            const events: InvalidationEvent[] = [];
            setInvalidationHook((event) => events.push(event));
            try {
              if (order === "system-first") {
                system = run("system");
                await bounded(linkHeld.promise);
                user = run("user");
                await bounded(userStarted.promise);
                if (!userPid || !systemPid) throw new Error("Missing relation participant PID");
                await waitBlocked(systemPid, userPid);
                releaseLink.resolve();
                releaseSource.resolve();
              } else {
                user = run("user");
                await bounded(sourceHeld.promise);
                system = run("system");
                expect(await bounded(system)).toMatchObject({
                  ok: false,
                  error: { code: "value_link_busy", status: 409 },
                });
                releaseSource.resolve();
              }
              const outcomes = await bounded(Promise.all([user, system]));
              console.info("Inbox relation admission", { order, userPid, systemPid });
              expect(outcomes[0]).toEqual({ ok: true });
              if (order === "system-first") expect(outcomes[1]).toEqual({ ok: true });
              else expect(outcomes[1]).toMatchObject({ ok: false, error: { code: "value_link_busy" } });
              const links = await withTenantTransaction(userPool, tenant, (client) =>
                listValueLinksByItemIds(client, [fixture.item.id]),
              );
              expect(links[0]).toMatchObject(outcomes[0]?.ok ? { state: "broken", brokenBy: "user" } : { state: "on" });
              expect(events.filter((event) => event.scope === "item" && event.itemId === fixture.item.id)).toHaveLength(
                1,
              );
              const edges = await runInTenant(tenant, () => cp.listItemRelations(fixture.item.id, property.id));
              expect(edges).toHaveLength(order === "system-first" ? 2 : 1);
            } catch (error) {
              failure = error;
            } finally {
              releaseSource.resolve();
              releaseLink.resolve();
              const errors = await settleParticipants(
                user,
                system,
                () => userPid,
                () => systemPid,
              );
              sourceSpy.mockRestore();
              linkSpy.mockRestore();
              setInvalidationHook(() => {});
              if (errors.length)
                failure = new AggregateError(
                  failure === undefined ? errors : [failure, ...errors],
                  "Relation diagnostic cleanup failed",
                );
            }
            if (failure !== undefined) throwFailure(failure);
          }),
        );
      },
      30000,
    );

    it("checks multiple caller keys once in stable order and preserves ordinary writer locking", async () => {
      const tenant = await createTestTenant(pool);
      await withRuntimePool(async (runtime) => {
        const cp = createChokePoint(runtime);
        const fx = await runInTenant(tenant, () => setup(cp));
        await runInTenant(tenant, () =>
          cp.createProperty({ databaseId: fx.files.id, key: "note", name: "Note", type: "text" }),
        );
        await withTenantTransaction(runtime, tenant, async (client) => {
          for (const propertyKey of ["name", "note"]) {
            await insertValueLink(client, { itemId: fx.file.id, propertyKey, ruleKey: "test", sources: [] });
          }
        });
        const handoff = vi.spyOn(valueLinksStore, "lockOnValueLink");
        const prelock = vi.spyOn(itemsStore, "lockItemById");
        try {
          await runInTenant(tenant, () =>
            withTransaction(runtime, (client) =>
              updateItemWithClient(
                client,
                { databaseId: fx.files.id, itemId: fx.file.id, propertiesPatch: { note: "one", name: "system" } },
                { systemOwnerProcess: VALUE_LINKS_OWNER_PROCESS, writer: SYSTEM_WRITER },
              ),
            ),
          );
          expect(handoff.mock.calls.map((call) => call[2])).toEqual(["name", "note"]);
          expect(prelock).toHaveBeenCalledTimes(1);
          prelock.mockClear();
          await runInTenant(tenant, () =>
            cp.updateItem(
              { databaseId: fx.files.id, itemId: fx.file.id, propertiesPatch: { name: "user" } },
              undefined,
              undefined,
              USER,
            ),
          );
          expect(prelock).not.toHaveBeenCalled();
          const links = await withTenantTransaction(runtime, tenant, (client) =>
            listValueLinksByItemIds(client, [fx.file.id]),
          );
          expect(links.map((entry) => [entry.propertyKey, entry.state])).toEqual([
            ["name", "broken"],
            ["note", "on"],
          ]);
        } finally {
          handoff.mockRestore();
          prelock.mockRestore();
        }
      });
    });

    it("checks a live scoped item before looking up any handoff link", async () => {
      const tenantA = await createTestTenant(pool);
      const tenantB = await createTestTenant(pool);
      await withRuntimePool(async (runtime) => {
        const cp = createChokePoint(runtime);
        const own = await runInTenant(tenantA, () => setup(cp));
        const foreign = await runInTenant(tenantB, () => setup(cp));
        await runInTenant(tenantA, () => cp.softDeleteItem(own.files.id, own.file.id));
        const spy = vi.spyOn(valueLinksStore, "lockOnValueLink");
        const events: InvalidationEvent[] = [];
        setInvalidationHook((event) => events.push(event));
        try {
          for (const itemId of [own.file.id, foreign.file.id, "00000000-0000-4000-8000-000000000001"]) {
            await expect(
              runInTenant(tenantA, () =>
                withTransaction(runtime, (client) =>
                  updateItemWithClient(
                    client,
                    { databaseId: own.files.id, itemId, propertiesPatch: { name: "blocked" } },
                    { systemOwnerProcess: VALUE_LINKS_OWNER_PROCESS, writer: SYSTEM_WRITER },
                  ),
                ),
              ),
            ).rejects.toMatchObject({ status: 404 });
          }
          expect(spy).not.toHaveBeenCalled();
          expect(events).toEqual([]);
          expect(
            (await runInTenant(tenantB, () => cp.getItem(foreign.files.id, foreign.file.id)))?.properties.name,
          ).toBe("a.pdf");
        } finally {
          spy.mockRestore();
          setInvalidationHook(() => {});
        }
      });
    });

    it("retains version conflicts and normal equal-value update effects", async () => {
      const tenant = await createTestTenant(pool);
      await withRuntimePool(async (runtime) => {
        const cp = createChokePoint(runtime);
        const fx = await runInTenant(tenant, () => setup(cp));
        await withTenantTransaction(runtime, tenant, (client) =>
          insertValueLink(client, {
            itemId: fx.file.id,
            propertyKey: "name",
            ruleKey: "test",
            sources: [],
          }),
        );
        const events: InvalidationEvent[] = [];
        setInvalidationHook((event) => events.push(event));
        try {
          await expect(
            runInTenant(tenant, () =>
              withTransaction(runtime, (client) =>
                updateItemWithClient(
                  client,
                  {
                    databaseId: fx.files.id,
                    itemId: fx.file.id,
                    propertiesPatch: { name: "new" },
                    ifVersion: "2000-01-01T00:00:00.000Z",
                  },
                  { systemOwnerProcess: VALUE_LINKS_OWNER_PROCESS, writer: SYSTEM_WRITER },
                ),
              ),
            ),
          ).rejects.toMatchObject({ status: 409 });
          expect(events).toEqual([]);
          await runInTenant(tenant, () =>
            cp.updateItem(
              { databaseId: fx.files.id, itemId: fx.file.id, propertiesPatch: { name: "a.pdf" } },
              undefined,
              undefined,
              USER,
            ),
          );
          expect(events.filter((event) => event.scope === "item" && event.itemId === fx.file.id)).toHaveLength(1);
          const links = await withTenantTransaction(runtime, tenant, (client) =>
            listValueLinksByItemIds(client, [fx.file.id]),
          );
          expect(links[0]).toMatchObject({ state: "on" });
          expect((await runInTenant(tenant, () => cp.getItem(fx.files.id, fx.file.id)))?.properties.name).toBe("a.pdf");
        } finally {
          setInvalidationHook(() => {});
        }
      });
    });

    it.each([
      ["plain", "user-first"],
      ["plain", "system-first"],
      ["transformed", "user-first"],
      ["transformed", "system-first"],
      ["plain", "system-rollback"],
    ] as const)(
      "serializes %s item and handoff writes with %s",
      async (kind, order) => {
        const tenant = await createTestTenant(pool);
        const otherTenant = await createTestTenant(pool);
        await withRuntimePool(async (userPool) =>
          withRuntimePool(async (systemPool) => {
            const cp = createChokePoint(userPool);
            const fx = await runInTenant(tenant, async () => {
              if (kind === "plain") return setup(cp);
              const files = await cp.createDatabase({ name: "Transformed", ownerModuleId: "handoffProbe" });
              await cp.createProperty({ databaseId: files.id, key: "name", name: "Name", type: "text" });
              registerItemPreWriteTransform("handoffProbe", async ({ patch }) => patch);
              const file = await cp.createItem({ databaseId: files.id, properties: { name: "initial" } });
              return { files, file };
            });
            const unrelated = await runInTenant(tenant, () =>
              cp.createItem({ databaseId: fx.files.id, properties: { name: "other" } }),
            );
            const foreign = await runInTenant(otherTenant, () => setup(cp));
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
            const userStarted = barrier();
            const systemStarted = barrier();
            let userClient: PoolClient | undefined;
            let systemClient: PoolClient | undefined;
            let userPid: number | undefined;
            let systemPid: number | undefined;
            const realUpdate = itemsStore.updateItemProperties;
            const realLock = itemsStore.lockItemById;
            const updateSpy = vi.spyOn(itemsStore, "updateItemProperties").mockImplementation(async (client, input) => {
              const result = await realUpdate(client, input);
              if (client === userClient) {
                userHeld.resolve();
                await bounded(releaseUser.promise);
              }
              return result;
            });
            const lockSpy = vi
              .spyOn(itemsStore, "lockItemById")
              .mockImplementation(async (client, databaseId, itemId) => {
                const found = await realLock(client, databaseId, itemId);
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
                      userStarted.resolve();
                    } else {
                      systemClient = client;
                      systemPid = pid;
                      systemStarted.resolve();
                    }
                    const result = await updateItemWithClient(
                      client,
                      { databaseId: fx.files.id, itemId: fx.file.id, propertiesPatch: { name: kind } },
                      kind === "user"
                        ? { writer: USER }
                        : { systemOwnerProcess: VALUE_LINKS_OWNER_PROCESS, writer: SYSTEM_WRITER },
                    );
                    if (kind === "system" && order === "system-rollback") throw new Error("forced rollback");
                    return result;
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
                await bounded(systemStarted.promise);
                if (!userPid || !systemPid) throw new Error("Missing participant PID");
                await waitBlocked(userPid, systemPid);
                console.info("Observed item handoff wait", {
                  kind,
                  order,
                  holderPid: userPid,
                  competitorPid: systemPid,
                });
                releaseUser.resolve();
                releaseSystem.resolve();
              } else {
                system = run("system");
                await bounded(systemHeld.promise);
                await bounded(
                  runInTenant(tenant, () =>
                    cp.updateItem(
                      { databaseId: fx.files.id, itemId: unrelated.id, propertiesPatch: { name: "progress" } },
                      undefined,
                      undefined,
                      USER,
                    ),
                  ),
                );
                await bounded(
                  runInTenant(otherTenant, () =>
                    cp.updateItem(
                      { databaseId: foreign.files.id, itemId: foreign.file.id, propertiesPatch: { name: "progress" } },
                      undefined,
                      undefined,
                      USER,
                    ),
                  ),
                );
                user = run("user");
                await bounded(userStarted.promise);
                if (!userPid || !systemPid) throw new Error("Missing participant PID");
                await waitBlocked(systemPid, userPid);
                console.info("Observed item handoff wait", {
                  kind,
                  order,
                  holderPid: systemPid,
                  competitorPid: userPid,
                });
                releaseSystem.resolve();
                releaseUser.resolve();
              }
              const results = await bounded(Promise.all([user, system]));
              expect(results[0]).toEqual({ ok: true });
              if (order === "user-first") {
                expect(results[1]).toMatchObject({ ok: false, error: { status: 403, code: "owner_violation" } });
              } else if (order === "system-rollback") {
                expect(results[1]).toMatchObject({ ok: false, error: { message: "forced rollback" } });
              } else {
                expect(results[1]).toEqual({ ok: true });
              }
              expect(events.filter((event) => event.scope === "item" && event.itemId === fx.file.id)).toHaveLength(
                order === "system-first" ? 2 : 1,
              );
              const current = await runInTenant(tenant, () => cp.getItem(fx.files.id, fx.file.id));
              const links = await withTenantTransaction(userPool, tenant, (client) =>
                listValueLinksByItemIds(client, [fx.file.id]),
              );
              expect(current?.properties.name).toBe("user");
              expect(links[0]).toMatchObject({ state: "broken", brokenBy: "user" });
            } catch (error) {
              failure = error;
            } finally {
              releaseUser.resolve();
              releaseSystem.resolve();
              const cleanupErrors = await settleParticipants(
                user,
                system,
                () => userPid,
                () => systemPid,
              );
              updateSpy.mockRestore();
              lockSpy.mockRestore();
              setInvalidationHook(() => {});
              if (kind === "transformed") clearHooksForTests();
              if (cleanupErrors.length) {
                failure = new AggregateError(
                  failure === undefined ? cleanupErrors : [failure, ...cleanupErrors],
                  "Diagnostic and cleanup failed",
                );
              }
            }
            if (failure !== undefined) throwFailure(failure);
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
