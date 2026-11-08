import "../domainWriteHooks.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { withTransaction } from "../db/pool.js";
import { writeMailboxAddresses } from "../mail/mailboxAddresses.js";
import { createMailContactsRouteHandler } from "../mail/mailContactsRoute.js";
let admin: Pool;
let pool: Pool;
let tenant: string;
async function create(moduleId: string, properties: Record<string, unknown>) {
  const db = await withTransaction(pool, (client) => getDatabaseByModuleId(client, moduleId));
  if (!db) throw new Error("Missing seeded database");
  return createChokePoint(pool).createItem({ databaseId: db.id, properties });
}
async function request(query: string) {
  return runInTenant(tenant, () =>
    createMailContactsRouteHandler(pool)({ req: { url: `/api/mail/contacts?${query}` } }),
  );
}
describe("mail contacts", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(pool));
  });
  afterAll(async () => {
    await pool.end();
    await admin.end();
  });
  it("matches a name without case or diacritics, returns one row per normalized address and relationship", async () => {
    const person = await runInTenant(tenant, () =>
      create("people", { name: "Petr Novák", emails: "Petr@novak-web.cz\npetr@other.cz", relationship: "client" }),
    );
    expect((await request("q=NOVAK")).body).toEqual({
      contacts: [
        { personId: person.id, name: "Petr Novák", email: "petr@novak-web.cz", relationship: "client" },
        { personId: person.id, name: "Petr Novák", email: "petr@other.cz", relationship: "client" },
      ],
    });
    expect((await request("q=other.cz")).body).toEqual({
      contacts: [{ personId: person.id, name: "Petr Novák", email: "petr@other.cz", relationship: "client" }],
    });
  });
  it("excludes own mailbox addresses and normalized exclude entries", async () => {
    await runInTenant(tenant, async () => {
      await create("people", { name: "Contact", emails: "own@example.com\nexcluded@example.com\nkeep@example.com" });
      await withTransaction(pool, async (client) => {
        const mailboxes = await getDatabaseByModuleId(client, "mailboxes");
        if (!mailboxes) throw new Error("Missing seeded database");
        const mailbox = await createItemWithClient(client, {
          databaseId: mailboxes.id,
          properties: { name: "Account" },
        });
        await writeMailboxAddresses(client, {
          mailboxesDatabaseId: mailboxes.id,
          mailboxItemId: mailbox.id,
          address: " \tOWN@EXAMPLE.COM\t ",
        });
      });
    });
    const response = await request("q=contact&exclude=%20EXCLUDED%40example.com%20");
    expect(response.body).toMatchObject({ contacts: [{ email: "keep@example.com", relationship: null }] });
    expect(JSON.stringify(response.body)).not.toContain("own@example.com");
    expect(JSON.stringify(response.body)).not.toContain("excluded@example.com");
  });
  it.each(["%", "_", "\\"])("matches %s literally", async (symbol) => {
    await runInTenant(tenant, async () => {
      await create("people", { name: `Literal ${symbol}`, emails: "literal@example.com" });
      await create("people", { name: "Other", emails: "other@example.com" });
    });
    expect((await request(`q=${encodeURIComponent(symbol)}`)).body).toMatchObject({
      contacts: [{ email: "literal@example.com" }],
    });
  });
  it("returns no rows for empty q and applies the default and maximum limits", async () => {
    await runInTenant(tenant, () =>
      create("people", {
        name: "Many",
        emails: Array.from({ length: 55 }, (_, n) => `p${String(n).padStart(2, "0")}@example.com`).join("\n"),
      }),
    );
    expect((await request("")).body).toEqual({ contacts: [] });
    expect((await request("q=many")).body).toMatchObject({ contacts: expect.any(Array) });
    const { z } = await import("zod");
    const schema = z.object({ contacts: z.array(z.unknown()) });
    expect(schema.parse((await request("q=many")).body).contacts).toHaveLength(10);
    expect(schema.parse((await request("q=many&limit=999")).body).contacts).toHaveLength(50);
  });
  it.each(["limit=0", "limit=-1", "limit=2.5", "limit=abc", `q=${"x".repeat(257)}`, `exclude=${"x".repeat(16385)}`])(
    "rejects invalid bounded query %s",
    async (query) => {
      await expect(request(query)).rejects.toMatchObject({ code: "validation_failed", status: 400 });
    },
  );
  it("isolates tenant data and excludes deleted people", async () => {
    const other = await createTestTenant(admin);
    await runInTenant(other, async () => {
      await seedSystem(pool);
      await create("people", { name: "Secret", emails: "secret@example.com" });
    });
    expect((await request("q=secret")).body).toEqual({ contacts: [] });
    await runInTenant(tenant, async () => {
      const person = await create("people", { name: "Deleted", emails: "deleted@example.com" });
      await createChokePoint(pool).softDeleteItem(person.databaseId, person.id);
    });
    expect((await request("q=deleted")).body).toEqual({ contacts: [] });
  });
});
