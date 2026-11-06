import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import {
  createChokePoint,
  getDatabaseByModuleId,
  listSempThreadMessages,
  seedSystem,
  sendSempMessage,
  withTransaction,
} from "../index.js";

describe("Semp history reference resolution", () => {
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

  it("resolves current names and trash/purge state while preserving mixed historical entries", async () => {
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
      cp.createItem({ databaseId: database.id, properties: { name: "Old" } }),
    );
    const foreignItem = await runInTenant(foreign, () =>
      cp.createItem({ databaseId: foreignDatabase.id, properties: { name: "Private" } }),
    );
    const ref = { kind: "item" as const, itemId: item.id, databaseId: database.id };
    const foreignRef = { kind: "item" as const, itemId: foreignItem.id, databaseId: foreignDatabase.id };
    const randomRef = { kind: "item" as const, itemId: randomUUID(), databaseId: database.id };
    const sent = await runInTenant(tenant, () =>
      withTransaction(runtime, (client) =>
        sendSempMessage(client, {
          text: "Question",
          context: [{ ...ref, label: "Historic" }, { kind: "future", data: "kept" }, foreignRef, randomRef],
          hasContext: true,
        }),
      ),
    );
    const read = () =>
      runInTenant(tenant, () =>
        withTransaction(runtime, (client) => listSempThreadMessages(client, sent.threadId, 50, null)),
      );
    await runInTenant(tenant, () =>
      cp.updateItem({ databaseId: database.id, itemId: item.id, propertiesPatch: { name: "New" } }),
    );
    let history = await read();
    let user = history.rows.find((row) => row.id === sent.messageId);
    expect(user?.context).toEqual([
      { ...ref, label: "Historic", resolved: { label: "New", databaseKey: "tasks", state: "active" } },
      { kind: "future", data: "kept" },
      { ...foreignRef, resolved: { label: null, databaseKey: null, state: "purged" } },
      { ...randomRef, resolved: { label: null, databaseKey: null, state: "purged" } },
    ]);
    await runInTenant(tenant, () => cp.softDeleteItem(database.id, item.id));
    history = await read();
    user = history.rows.find((row) => row.id === sent.messageId);
    expect(user?.context).toEqual(
      expect.arrayContaining([
        { ...ref, label: "Historic", resolved: { label: "New", databaseKey: "tasks", state: "trashed" } },
      ]),
    );
    await runInTenant(tenant, () => cp.purgeExpiredTrashSubtree(item.id, new Date("9999-01-01T00:00:00Z")));
    history = await read();
    user = history.rows.find((row) => row.id === sent.messageId);
    expect(user?.context).toEqual(
      expect.arrayContaining([
        { ...ref, label: "Historic", resolved: { label: null, databaseKey: null, state: "purged" } },
      ]),
    );
  });
});
