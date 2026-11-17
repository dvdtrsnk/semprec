import { afterAll, describe, expect, inject, it } from "vitest";
import { runAsSystem, TenantScopeMissingError } from "@semprec/shared";
import { createPool } from "../../db/pool.js";

declare module "vitest" {
  interface ProvidedContext {
    /** `null` when the vitest process was started without `SEMPREC_TENANT_SCOPE`. */
    explicitTenantScopeMode: string | null;
  }
}

/**
 * Probes the integration tier's default mode: this file is not on the warn list, so it must run `strict`. A value the
 * vitest process was started with is a developer override, so the cases skip instead of asserting the default.
 */

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error("TEST_DATABASE_URL is not set; globalSetup did not run");

const explicitTenantScopeMode = inject("explicitTenantScopeMode");
const pool = createPool(connectionString);

function skipUnderOverride(context: { skip: (note?: string) => never }): void {
  if (explicitTenantScopeMode !== null) {
    context.skip(`the vitest process carries an explicit SEMPREC_TENANT_SCOPE=${explicitTenantScopeMode}`);
  }
}

describe("the default tenant-scope mode of an integration test file that is not listed", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("is strict", (context) => {
    skipUnderOverride(context);
    expect(process.env.SEMPREC_TENANT_SCOPE).toBe("strict");
  });

  it("refuses a query through createPool outside any scope", async (context) => {
    skipUnderOverride(context);
    await expect(pool.query("SELECT 1 AS one")).rejects.toBeInstanceOf(TenantScopeMissingError);
  });

  it("still lets the same query run inside an explicit system scope", async (context) => {
    skipUnderOverride(context);
    const result = await runAsSystem("tenantScopeModeDefault probe", () =>
      pool.query<{ one: number }>("SELECT 1 AS one"),
    );
    expect(result.rows).toEqual([{ one: 1 }]);
  });
});
