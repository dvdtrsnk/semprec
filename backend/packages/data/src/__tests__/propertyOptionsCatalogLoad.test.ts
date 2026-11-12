import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import * as registryLoader from "../manifest/fullModuleRegistry.js";
import { setInvalidationHook, type InvalidationEvent } from "../realtimeHook.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

/**
 * The option writes of issue #1699 read the module catalogs through a resolver that `propertyOps.ts` builds once per
 * process. Its load has this file to itself, because a built resolver stays for the rest of a test file.
 */
describe("the catalog load of the select option writes (issue #1699)", () => {
  let admin: Pool;
  let runtime: Pool;
  let chokePoint: ChokePoint;
  let tenant: string;
  const invalidation = vi.fn<(event: InvalidationEvent) => void>();

  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    chokePoint = createChokePoint(runtime);
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    invalidation.mockClear();
    setInvalidationHook(invalidation);
  });
  afterEach(() => {
    setInvalidationHook(() => {});
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  it("fails an option write whose catalog load fails without writing, loads again for the next write and keeps that load", async () => {
    const property = await runInTenant(tenant, async () => {
      const database = await chokePoint.createDatabase({ name: "Catalog load" });
      return chokePoint.createProperty({
        databaseId: database.id,
        key: "choice",
        name: "Choice",
        type: "select",
        config: { options: [{ key: "one" }] },
      });
    });
    invalidation.mockClear();
    const failure = new Error("module manifests unavailable");
    const loader = vi.spyOn(registryLoader, "loadFullModuleRegistry").mockRejectedValueOnce(failure);

    await expect(runInTenant(tenant, () => chokePoint.addPropertyOption(property.id, { label: "Two" }))).rejects.toBe(
      failure,
    );

    expect(loader).toHaveBeenCalledTimes(1);
    expect((await runInTenant(tenant, () => chokePoint.getProperty(property.id)))?.config).toEqual({
      options: [{ key: "one" }],
    });
    expect(invalidation).not.toHaveBeenCalled();

    // The failed load was not kept: the next write loads the catalogs again and succeeds.
    const added = await runInTenant(tenant, () => chokePoint.addPropertyOption(property.id, { label: "Two" }));
    expect(added).toEqual({ key: "two", label: "Two" });
    expect(loader).toHaveBeenCalledTimes(2);

    // The successful load is kept: a later write of either operation loads nothing.
    const renamed = await runInTenant(tenant, () =>
      chokePoint.updatePropertyOption(property.id, "two", { label: "Second" }, "en"),
    );
    expect(renamed).toEqual({ key: "two", label: "Second" });
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
