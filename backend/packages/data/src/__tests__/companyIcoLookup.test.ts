import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@alldots/shared";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { withTransaction } from "../db/pool.js";
import { lookupLiveCompanyIdByIco } from "../inbox/companyIcoLookup.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

let admin: Pool;
let runtime: Pool;

async function seedTenant(): Promise<{ tenantId: string; databaseId: string }> {
  const tenantId = await createTestTenant(admin);
  const databaseId = await runInTenant(tenantId, async () => {
    await seedSystem(runtime);
    const { rows } = await runtime.query<{ id: string }>(
      "SELECT id FROM databases WHERE owner_module_id = 'companies'",
    );
    if (!rows[0]) throw new Error("Missing Companies database");
    return rows[0].id;
  });
  return { tenantId, databaseId };
}

const lookup = (tenantId: string, ico: string) =>
  runInTenant(tenantId, () => withTransaction(runtime, (client) => lookupLiveCompanyIdByIco(client, ico)));

describe("lookupLiveCompanyIdByIco (issue gh-1992)", () => {
  beforeEach(async () => {
    admin ??= getTestPool();
    runtime ??= await createRuntimeRolePool(admin, "alldots_data");
    await resetDatabase(admin);
  });
  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  async function createCompany(tenantId: string, databaseId: string, properties: Record<string, unknown>) {
    return runInTenant(tenantId, () => createChokePoint(runtime).createItem({ databaseId, properties }));
  }

  it("finds a live company by its exact number, an IČO whose check digit is wrong included", async () => {
    const { tenantId, databaseId } = await seedTenant();
    const company = await createCompany(tenantId, databaseId, { name: "Bakery", ico: "07654321" });
    await createCompany(tenantId, databaseId, { name: "Other", ico: "27419363" });

    expect(await lookup(tenantId, "07654321")).toBe(company.id);
  });

  it("answers null for a number no company holds, and for a company without a number", async () => {
    const { tenantId, databaseId } = await seedTenant();
    await createCompany(tenantId, databaseId, { name: "Bakery", ico: "07654321" });
    await createCompany(tenantId, databaseId, { name: "No number" });

    expect(await lookup(tenantId, "07654322")).toBeNull();
  });

  it("compares a stored number in its eight-digit form: spaces removed, short numbers left-padded", async () => {
    const { tenantId, databaseId } = await seedTenant();
    const spaced = await createCompany(tenantId, databaseId, { name: "Spaced", ico: " 274 19 363 " });
    const short = await createCompany(tenantId, databaseId, { name: "Short", ico: "12345" });

    expect(await lookup(tenantId, "27419363")).toBe(spaced.id);
    expect(await lookup(tenantId, "00012345")).toBe(short.id);
  });

  it("does not match a stored value that is not one to eight digits, even when its first eight digits match", async () => {
    const { tenantId, databaseId } = await seedTenant();
    await createCompany(tenantId, databaseId, { name: "Too long", ico: "123456789" });
    await createCompany(tenantId, databaseId, { name: "Letters", ico: "0765432a" });

    expect(await lookup(tenantId, "12345678")).toBeNull();
    expect(await lookup(tenantId, "07654321")).toBeNull();
  });

  it("does not find a company in the Trash, and finds it again once it is restored", async () => {
    const { tenantId, databaseId } = await seedTenant();
    const company = await createCompany(tenantId, databaseId, { name: "Bakery", ico: "07654321" });
    const writer = createChokePoint(runtime);
    await runInTenant(tenantId, () => writer.softDeleteItem(databaseId, company.id));

    expect(await lookup(tenantId, "07654321")).toBeNull();

    await runInTenant(tenantId, () => writer.restoreItem(databaseId, company.id));
    expect(await lookup(tenantId, "07654321")).toBe(company.id);
  });

  it("does not find a company of an archived Companies database", async () => {
    const { tenantId, databaseId } = await seedTenant();
    await createCompany(tenantId, databaseId, { name: "Bakery", ico: "07654321" });
    // The choke point has no write that archives a system database, so the state is set directly.
    await admin.query("UPDATE databases SET archived_at = now() WHERE id = $1", [databaseId]);

    expect(await lookup(tenantId, "07654321")).toBeNull();
  });

  it("answers the oldest of two live companies that hold one number", async () => {
    const { tenantId, databaseId } = await seedTenant();
    const first = await createCompany(tenantId, databaseId, { name: "First", ico: "07654321" });
    await createCompany(tenantId, databaseId, { name: "Second", ico: "07654321" });

    expect(await lookup(tenantId, "07654321")).toBe(first.id);
  });

  it("reads only the caller's tenant: another tenant's company with the same number is not found", async () => {
    const a = await seedTenant();
    const b = await seedTenant();
    const foreign = await createCompany(b.tenantId, b.databaseId, { name: "Foreign", ico: "07654321" });
    const local = await createCompany(a.tenantId, a.databaseId, { name: "Local", ico: "11111111" });

    expect(await lookup(a.tenantId, "07654321")).toBeNull();
    expect(await lookup(b.tenantId, "07654321")).toBe(foreign.id);
    expect(await lookup(a.tenantId, "11111111")).toBe(local.id);
  });

  it("writes no row", async () => {
    const { tenantId, databaseId } = await seedTenant();
    await createCompany(tenantId, databaseId, { name: "Bakery", ico: "07654321" });
    const count = async () =>
      (
        await admin.query<{ n: string }>(
          "SELECT (SELECT count(*) FROM items) + (SELECT count(*) FROM item_relations) AS n",
        )
      ).rows[0]!.n;
    const before = await count();

    await lookup(tenantId, "07654321");

    expect(await count()).toBe(before);
  });
});
