import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { ModuleCatalogs } from "@semprec/module-registry";
import { runInTenant } from "@semprec/shared";

const loadModuleCatalogs = vi.hoisted(() => vi.fn<(modulePath: string) => Promise<ModuleCatalogs>>());

vi.mock("@semprec/module-registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@semprec/module-registry")>()),
  loadModuleCatalogs,
}));

import { createProjectHeartbeatsRouteHandler } from "../projectHeartbeatsRoute.js";

const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

describe("project heartbeats route catalog loading (issue gh-1910)", () => {
  it("does not keep a failed load: the next request loads the catalogs again and the one after reuses them", async () => {
    loadModuleCatalogs.mockRejectedValueOnce(new Error("catalog unreadable"));
    loadModuleCatalogs.mockResolvedValue({ cs: {}, en: {} });
    // The catalogs are read before the database is, so a pool that cannot connect shows how far each request got.
    const connect = vi.fn().mockRejectedValue(new Error("no connection"));
    const handler = createProjectHeartbeatsRouteHandler({ connect } as unknown as Pool);
    const run = () => runInTenant(TENANT_ID, () => handler(context));
    const context = { params: { id: PROJECT_ID }, identity: { user: { locale: "en" } } };

    await expect(run()).rejects.toThrow("catalog unreadable");
    expect(connect).not.toHaveBeenCalled();
    await expect(run()).rejects.toThrow("no connection");
    await expect(run()).rejects.toThrow("no connection");

    expect(loadModuleCatalogs).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenCalledTimes(2);
  });
});
