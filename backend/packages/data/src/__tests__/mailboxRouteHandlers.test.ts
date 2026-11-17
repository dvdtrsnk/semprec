import "../domainWriteHooks.js";
import { runAsSystem, runInTenant } from "@semprec/shared";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import { withTransaction } from "../db/pool.js";
import { ensureMailAccountSyncState, recordGmailActivity, recordSyncError } from "../mail/mailAccountSyncStateStore.js";
import { writeMailboxAddresses } from "../mail/mailboxAddresses.js";
import { createMailboxDetailRouteHandler, createMailboxListRouteHandler } from "../mail/mailboxRouteHandlers.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;
let foreign: string;
describe("mailbox routes", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("verify mailbox role", () =>
      runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    foreign = await createTestTenant(admin);
    for (const id of [tenant, foreign]) await runInTenant(id, () => seedSystem(runtime));
  });
  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });
  async function createMailbox() {
    const cp = createChokePoint(runtime);
    const db = (await cp.listDatabases()).find((d) => d.ownerModuleId === "mailboxes");
    if (!db) throw new Error("Missing mailboxes database");
    const mailbox = await cp.createItem({ databaseId: db.id, properties: { name: "Work", provider: "gmail" } });
    await withTransaction(runtime, (client) =>
      writeMailboxAddresses(client, {
        mailboxesDatabaseId: db.id,
        mailboxItemId: mailbox.id,
        address: "me@example.test",
        aliases: ["alias@example.test"],
      }),
    );
    return mailbox.id;
  }
  it("reports initial state, API mode and success retained after failure without provider text", async () => {
    await runInTenant(tenant, async () => {
      const id = await createMailbox();
      const detail = createMailboxDetailRouteHandler(runtime);
      expect((await detail({ params: { id } })).body).toMatchObject({
        syncStatus: "never",
        initialSyncInProgress: true,
        addresses: ["me@example.test", "alias@example.test"],
        primaryAddress: "me@example.test",
        connectionLimit: { value: 5, default: 5, applies: false },
      });
      await withTransaction(runtime, async (client) => {
        await ensureMailAccountSyncState(client, { itemId: id, syncMode: "gmail_api" });
        await recordGmailActivity(client, {
          itemId: id,
          historyId: "1",
          nextExpectedActivityAt: new Date("2030-01-01T00:00:00Z"),
        });
      });
      const before = (await detail({ params: { id } })).body.lastSuccessfulSyncAt;
      expect(before).not.toBeNull();
      const database = (await createChokePoint(runtime).listDatabases()).find((d) => d.ownerModuleId === "mailboxes");
      if (!database) throw new Error("Missing mailboxes database");
      await withTransaction(runtime, async (client) => {
        await recordSyncError(client, id, "secret provider text", "other");
        await updateItemWithClient(
          client,
          { databaseId: database.id, itemId: id, propertiesPatch: { syncStatus: "error" } },
          { allowedSystemKeys: ["syncStatus"] },
        );
      });
      const after = (await detail({ params: { id } })).body;
      expect(after.lastSuccessfulSyncAt).toBe(before);
      expect(after.initialSyncInProgress).toBe(false);
      expect(after.reason).toBe("other");
      expect(JSON.stringify(after)).not.toContain("secret provider text");
    });
  });
  it("reports Graph mode and excludes deleted mailboxes", async () => {
    await runInTenant(tenant, async () => {
      const id = await createMailbox();
      await withTransaction(runtime, (client) =>
        ensureMailAccountSyncState(client, { itemId: id, syncMode: "graph_api" }),
      );
      const detail = createMailboxDetailRouteHandler(runtime);
      expect((await detail({ params: { id } })).body.connectionLimit.applies).toBe(false);
      const cp = createChokePoint(runtime);
      const database = (await cp.listDatabases()).find((d) => d.ownerModuleId === "mailboxes");
      if (!database) throw new Error("Missing mailboxes database");
      await cp.softDeleteItem(database.id, id);
      expect((await createMailboxListRouteHandler(runtime)()).body.mailboxes).toEqual([]);
      await expect(detail({ params: { id } })).rejects.toMatchObject({ status: 404 });
    });
  });
  it("excludes foreign mailboxes and answers foreign and unknown ids alike", async () => {
    const foreignId = await runInTenant(foreign, createMailbox);
    await runInTenant(tenant, async () => {
      const ownId = await createMailbox();
      const list = await createMailboxListRouteHandler(runtime)();
      expect(list.body.mailboxes.map((m) => m.id)).toEqual([ownId]);
      const detail = createMailboxDetailRouteHandler(runtime);
      await expect(detail({ params: { id: foreignId } })).rejects.toMatchObject({
        status: 404,
        message: "Mailbox not found",
      });
      await expect(detail({ params: { id: "00000000-0000-4000-8000-000000000000" } })).rejects.toMatchObject({
        status: 404,
        message: "Mailbox not found",
      });
    });
  });
});
