import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import {
  createChokePoint,
  createDocStore,
  getDatabaseByModuleId,
  readSempRefContext,
  withTransaction,
} from "../index.js";

describe("Semp reference turn reads", () => {
  let admin: Pool;
  let runtime: Pool;
  beforeAll(async () => {
    admin = getTestPool();
    await resetDatabase(admin);
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });
  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  it("reads a real page and sibling blocks while refusing foreign, mismatched and random refs without effects", async () => {
    const tenant = await createTestTenant(admin);
    const foreign = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(runtime));
    await runInTenant(foreign, () => seedSystem(runtime));
    const database = await runInTenant(tenant, () =>
      withTransaction(runtime, (client) => getDatabaseByModuleId(client, "tasks")),
    );
    const foreignDatabase = await runInTenant(foreign, () =>
      withTransaction(runtime, (client) => getDatabaseByModuleId(client, "tasks")),
    );
    if (!database || !foreignDatabase) throw new Error("Missing tasks database");
    const cp = createChokePoint(runtime);
    const item = await runInTenant(tenant, () =>
      cp.createItem({ databaseId: database.id, properties: { name: "Page" } }),
    );
    const privateItem = await runInTenant(foreign, () =>
      cp.createItem({ databaseId: foreignDatabase.id, properties: { name: "Private" } }),
    );
    const parent = randomUUID();
    const first = randomUUID();
    const second = randomUUID();
    await runInTenant(tenant, async () => {
      const docs = createDocStore(runtime);
      await docs.putBlock(item.id, { id: first, flavour: "paragraph", fields: { text: "First" } }, "user");
      await docs.putBlock(item.id, { id: second, flavour: "paragraph", fields: { text: "Second" } }, "user");
      await docs.putBlock(item.id, { id: parent, flavour: "page", children: [first, second] }, "user");
    });
    const read = (ref: Parameters<typeof readSempRefContext>[1]) =>
      runInTenant(tenant, () => withTransaction(runtime, (client) => readSempRefContext(client, ref)));
    const before = await runInTenant(tenant, () =>
      runtime.query<{ count: number }>("SELECT count(*)::int AS count FROM doc_updates"),
    );
    const block = await read({ kind: "block", itemId: item.id, blockId: first });
    expect(block).toMatchObject({
      label: "Page",
      state: "active",
      details: {
        block: {
          block: { "sys:id": first },
          parent: { "sys:id": parent },
          siblings: [{ "sys:id": first }, { "sys:id": second }],
        },
      },
    });
    await expect(read({ kind: "block", itemId: item.id, blockId: randomUUID() })).resolves.toBeNull();
    await expect(read({ kind: "item", itemId: privateItem.id, databaseId: foreignDatabase.id })).resolves.toBeNull();
    await expect(read({ kind: "item", itemId: item.id, databaseId: foreignDatabase.id })).resolves.toBeNull();
    await expect(read({ kind: "item", itemId: randomUUID(), databaseId: database.id })).resolves.toBeNull();
    const after = await runInTenant(tenant, () =>
      runtime.query<{ count: number }>("SELECT count(*)::int AS count FROM doc_updates"),
    );
    expect(after.rows).toEqual(before.rows);
    await runInTenant(tenant, () => cp.softDeleteItem(database.id, item.id));
    await expect(read({ kind: "item", itemId: item.id, databaseId: database.id })).resolves.toMatchObject({
      state: "trashed",
      label: "Page",
    });
  });
});
