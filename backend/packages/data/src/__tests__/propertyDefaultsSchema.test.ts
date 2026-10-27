import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { markPropertyMigrationDroppedValues, settlePropertyMigrationStatus } from "../chokePoint/propertiesStore.js";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { setInvalidationHook } from "../realtimeHook.js";
import { getTenantZeroId, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import type { PropertyType } from "../types.js";

let pool: Pool;
let chokePoint: ChokePoint;
const invalidation = vi.fn();
const inTenant = <T>(fn: () => Promise<T>) => runInTenant(getTenantZeroId(), fn);

function signal() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function jobs() {
  // Graphile Worker 0.17.3's public jobs view omits payload; inspect it here to verify migration provenance.
  const { rows } = await pool.query<{ key: string | null; task_identifier: string; payload: unknown }>(
    "SELECT j.key, j.task_identifier, p.payload FROM graphile_worker.jobs j JOIN graphile_worker._private_jobs p ON p.id = j.id ORDER BY j.id",
  );
  return rows;
}

async function fixture(type: PropertyType = "text", config: Record<string, unknown> = {}) {
  const db = await chokePoint.createDatabase({ name: "Defaults" });
  const property = await chokePoint.createProperty({ databaseId: db.id, key: "value", name: "Value", type, config });
  invalidation.mockClear();
  return { db, property };
}

describe("property default schema coherence", () => {
  beforeAll(() => {
    pool = getTestPool();
    chokePoint = createChokePoint(pool);
  });
  beforeEach(async () => {
    await resetDatabase(pool);
    invalidation.mockClear();
    setInvalidationHook(invalidation);
  });
  afterEach(() => setInvalidationHook(() => {}));
  afterAll(async () => {
    await pool.end();
  });

  it.each(["patch", "patchWithDatabase"] as const)("%s validates a combined patch against the target type", (entry) =>
    inTenant(async () => {
      const { db, property } = await fixture("text", { default: "old" });
      const patch = { name: "Number", type: "number", config: { default: 7 } } as const;
      const result =
        entry === "patch"
          ? await chokePoint.updateProperty(property.id, patch)
          : await chokePoint.updatePropertyWithDatabase(property.id, patch);
      expect(result.typeChanged).toBe(true);
      expect(result.property).toMatchObject({
        name: "Number",
        type: "number",
        config: { default: 7 },
        migrationStatus: "pending",
      });
      expect(await chokePoint.getProperty(property.id)).toEqual(result.property);
      expect(await jobs()).toEqual([
        expect.objectContaining({
          key: `property-type-migration:${property.id}`,
          task_identifier: "propertyTypeMigration",
          payload: expect.objectContaining({
            tenantId: getTenantZeroId(),
            payload: { propertyId: property.id, fromType: "text" },
          }),
        }),
      ]);
      expect(invalidation).toHaveBeenCalledExactlyOnceWith({ scope: "schema", databaseId: db.id, userId: undefined });
      expect((await chokePoint.createItem({ databaseId: db.id })).properties.value).toBe(7);
    }),
  );

  it.each(["patch", "patchWithDatabase"] as const)(
    "%s refuses a target-incompatible combined default with no side effects",
    (entry) =>
      inTenant(async () => {
        const { property } = await fixture("text", { default: "original" });
        const beforeJobs = await jobs();
        const patch = { name: "Rejected", type: "number", config: { default: "not-a-number" } } as const;
        const pending =
          entry === "patch"
            ? chokePoint.updateProperty(property.id, patch)
            : chokePoint.updatePropertyWithDatabase(property.id, patch);
        await expect(pending).rejects.toMatchObject({ code: "validation_failed", details: { field: "config" } });
        expect(await chokePoint.getProperty(property.id)).toEqual(property);
        expect(await jobs()).toEqual(beforeJobs);
        expect(invalidation).not.toHaveBeenCalled();
      }),
  );

  it.each(["patch", "patchWithDatabase", "changeType"] as const)(
    "%s refuses an incompatible retained default without enqueuing migration",
    (entry) =>
      inTenant(async () => {
        const { property } = await fixture("text", { default: "old" });
        const pending =
          entry === "changeType"
            ? chokePoint.changePropertyType(property.id, "number")
            : entry === "patchWithDatabase"
              ? chokePoint.updatePropertyWithDatabase(property.id, { name: "Rejected", type: "number" })
              : chokePoint.updateProperty(property.id, { name: "Rejected", type: "number" });
        await expect(pending).rejects.toMatchObject({ code: "validation_failed", details: { field: "config" } });
        expect(await chokePoint.getProperty(property.id)).toEqual(property);
        expect(await jobs()).toEqual([]);
        expect(invalidation).not.toHaveBeenCalled();
      }),
  );

  it("retains a compatible default on a type-only change", () =>
    inTenant(async () => {
      const { property } = await fixture("date", { default: "today" });
      expect(await chokePoint.changePropertyType(property.id, "text")).toMatchObject({
        type: "text",
        config: { default: "today" },
        migrationStatus: "pending",
      });
      expect(await jobs()).toHaveLength(1);
      expect(invalidation).toHaveBeenCalledTimes(1);
    }));

  it("preserves earlier migration evidence and its queued job when a combined patch is refused", () =>
    inTenant(async () => {
      const { property } = await fixture("number");
      await chokePoint.changePropertyType(property.id, "text");
      await chokePoint.updatePropertyConfig(property.id, { default: "old" });
      // Reproduce a migration that settled partially before the worker acknowledged its job.
      await withTransaction(pool, async (client) => {
        await markPropertyMigrationDroppedValues(client, property.id);
        await settlePropertyMigrationStatus(client, property.id);
      });
      const before = await chokePoint.getProperty(property.id);
      const beforeJobs = await jobs();
      invalidation.mockClear();
      await expect(
        chokePoint.updateProperty(property.id, {
          name: "Rejected",
          type: "number",
          config: { default: "invalid" },
        }),
      ).rejects.toMatchObject({ code: "validation_failed", details: { field: "config" } });
      expect(await chokePoint.getProperty(property.id)).toEqual(before);
      const { rows } = await pool.query<{ migration_dropped_values: boolean }>(
        "SELECT migration_dropped_values FROM properties WHERE id = $1",
        [property.id],
      );
      expect(rows[0]?.migration_dropped_values).toBe(true);
      expect(await jobs()).toEqual(beforeJobs);
      expect(invalidation).not.toHaveBeenCalled();
    }));

  it("removes an incompatible default when replacement config omits it", () =>
    inTenant(async () => {
      const { db, property } = await fixture("text", { default: "old" });
      const result = await chokePoint.updateProperty(property.id, { type: "number", config: {} });
      expect(result.property).toMatchObject({ type: "number", config: {} });
      expect((await chokePoint.createItem({ databaseId: db.id })).properties).not.toHaveProperty("value");
      expect(await jobs()).toHaveLength(1);
    }));

  it.each(["patch", "config"] as const)("%s validates same-type replacement config and option membership", (entry) =>
    inTenant(async () => {
      const { property } = await fixture("select", { options: [{ key: "one" }], default: "one" });
      const config = { options: [{ key: "two" }], default: "one" };
      const pending =
        entry === "config"
          ? chokePoint.updatePropertyConfig(property.id, config)
          : chokePoint.updateProperty(property.id, { name: "Rejected", type: "select", config });
      await expect(pending).rejects.toMatchObject({ code: "validation_failed", details: { field: "config" } });
      expect(await chokePoint.getProperty(property.id)).toEqual(property);
      expect(await jobs()).toEqual([]);
      expect(invalidation).not.toHaveBeenCalled();
    }),
  );

  it("accepts a same-type patch with a valid replacement default", () =>
    inTenant(async () => {
      const { property } = await fixture("text", { default: "old" });
      expect(await chokePoint.updateProperty(property.id, { type: "text", config: { default: "new" } })).toMatchObject({
        typeChanged: false,
        property: { type: "text", config: { default: "new" } },
      });
      expect(await jobs()).toEqual([]);
      expect(invalidation).toHaveBeenCalledTimes(1);
    }));

  it.each(["patch", "separate"] as const)("keeps type/config coherent during competing %s writes", (entry) =>
    inTenant(async () => {
      const { property } = await fixture();
      const locked = signal();
      const release = signal();
      const blocker = withTransaction(pool, async (client) => {
        await client.query<{ id: string }>("SELECT id FROM properties WHERE id = $1 FOR UPDATE", [property.id]);
        locked.resolve();
        await release.promise;
      });
      const blockerResult = Promise.allSettled([blocker]);
      let writes: PromiseSettledResult<unknown>[] = [];
      let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
      try {
        await Promise.race([
          locked.promise,
          blocker.then(() => {
            throw new Error("Blocker ended before acquiring lock");
          }),
        ]);
        pending = Promise.allSettled(
          entry === "patch"
            ? [
                chokePoint.updateProperty(property.id, { type: "number" }),
                chokePoint.updateProperty(property.id, { config: { default: "text" } }),
              ]
            : [
                chokePoint.changePropertyType(property.id, "number"),
                chokePoint.updatePropertyConfig(property.id, { default: "text" }),
              ],
        );
        await vi.waitFor(
          async () => {
            const { rows } = await pool.query<{ count: string }>(
              "SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%properties%'",
            );
            expect(rows[0]?.count).toBe("2");
          },
          { timeout: 5000, interval: 10 },
        );
      } finally {
        release.resolve();
        await blockerResult;
        if (pending) writes = await pending;
      }
      expect((await blockerResult)[0]?.status).toBe("fulfilled");
      expect(writes.filter((write) => write.status === "fulfilled")).toHaveLength(1);
      const refused = writes.find((write) => write.status === "rejected");
      if (refused?.status !== "rejected" || !(refused.reason instanceof ValidationError))
        throw new Error("Expected one config ValidationError");
      expect(refused.reason.details).toEqual({ field: "config" });
      const final = await chokePoint.getProperty(property.id);
      const retyped = final?.type === "number";
      expect(final).toMatchObject(
        retyped
          ? { type: "number", config: {}, migrationStatus: "pending" }
          : { type: "text", config: { default: "text" }, migrationStatus: "stable" },
      );
      expect(await jobs()).toHaveLength(retyped ? 1 : 0);
      expect(invalidation).toHaveBeenCalledTimes(1);
    }),
  );
});
