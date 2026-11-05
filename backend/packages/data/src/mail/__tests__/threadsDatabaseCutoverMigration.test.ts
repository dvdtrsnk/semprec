import "../../domainWriteHooks.js";
import { runAsSystem, runInTenant } from "@semprec/shared";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { runTenantCutoverMigrations } from "../../db/tenantCutoverMigrations.js";
import { withTransaction } from "../../db/pool.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createMailThread } from "../mailMessageMetaStore.js";
import { runThreadsDatabaseCutoverMigration } from "../threadsDatabaseCutoverMigration.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;
describe("Threads database cutover", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("verify Threads role", () =>
      runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(runtime));
  });
  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });
  it("seeds the locked Threads catalog with its user-owned relation properties", async () => {
    await runInTenant(tenant, async () => {
      const cp = createChokePoint(runtime);
      const database = (await cp.listDatabases()).find((item) => item.ownerModuleId === "threads");
      if (!database) throw new Error("Missing Threads database");
      expect(database.schemaLocked).toBe(true);
      const properties = await cp.listProperties(database.id);
      expect(properties.map((property) => ({ key: property.key, type: property.type, owner: property.owner }))).toEqual(
        expect.arrayContaining([
          { key: "name", type: "title", owner: "system" },
          { key: "project", type: "relation", owner: "user" },
          { key: "company", type: "relation", owner: "user" },
        ]),
      );
      expect(properties).toHaveLength(3);
      const definitions = await runtime.query<{ key: string; cardinality: string; property_id_b: string | null }>(
        `SELECT p.key, r.cardinality, r.property_id_b FROM properties p JOIN relation_definitions r ON r.tenant_id = p.tenant_id AND r.property_id_a = p.id WHERE p.tenant_id = app_tenant_default() AND p.database_id = $1 ORDER BY p.key`,
        [database.id],
      );
      expect(definitions.rows).toEqual([
        { key: "company", cardinality: "many_to_many", property_id_b: null },
        { key: "project", cardinality: "many_to_many", property_id_b: null },
      ]);
    });
  });
  it("creates the internal item in the thread transaction", async () => {
    await runInTenant(tenant, async () => {
      const thread = await withTransaction(runtime, (client) => createMailThread(client, "A subject"));
      const result = await runtime.query<{ name: string; item_id: string }>(
        `SELECT i.properties->>'name' AS name, t.item_id FROM mail_threads t
         JOIN databases d ON d.tenant_id = t.tenant_id AND d.owner_module_id = 'threads'
         JOIN items i ON i.tenant_id = t.tenant_id AND i.database_id = d.id AND i.id = t.item_id
         WHERE t.tenant_id = app_tenant_default() AND t.id = $1`,
        [thread.id],
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({ name: "A subject" });
    });
  });
  it("rolls back the new thread and item together", async () => {
    await runInTenant(tenant, async () => {
      let threadId = "";
      await expect(
        withTransaction(runtime, async (client) => {
          threadId = (await createMailThread(client, "Rollback fixture")).id;
          throw new Error("rollback fixture");
        }),
      ).rejects.toThrow("rollback fixture");
      const threads = await runtime.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM mail_threads WHERE tenant_id = app_tenant_default() AND id = $1",
        [threadId],
      );
      const items = await runtime.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM items i JOIN databases d ON d.tenant_id = i.tenant_id AND d.id = i.database_id WHERE i.tenant_id = app_tenant_default() AND d.owner_module_id = 'threads' AND i.properties->>'name' = 'Rollback fixture'`,
      );
      expect(threads.rows).toEqual([{ count: 0 }]);
      expect(items.rows).toEqual([{ count: 0 }]);
    });
  });
  it("backfills a synthetic historical thread and replay preserves its item", async () => {
    await runInTenant(tenant, async () => {
      // Current creation always makes an item; this checked fixture represents a pre-cutover row.
      const inserted = await runtime.query<{ id: string }>(
        "INSERT INTO mail_threads (subject_hint) VALUES ($1) RETURNING id",
        ["Historical"],
      );
      expect(inserted.rowCount).toBe(1);
      const id = inserted.rows[0]!.id;
      await withTransaction(runtime, async (client) => {
        const emails = await getDatabaseByModuleId(client, "emails");
        if (!emails) throw new Error("Missing emails database");
        for (const [index, date] of ["2025-01-01T00:00:00.123456Z", "2025-02-01T00:00:00Z"].entries()) {
          const item = await createItemWithClient(
            client,
            { databaseId: emails.id, properties: { name: "Historical", date } },
            { allowedSystemKeys: ["name", "date"] },
          );
          // Current ingest cannot attach a message to this synthetic pre-cutover row.
          const meta = await client.query(
            "INSERT INTO mail_message_meta (item_id, message_id, thread_id) VALUES ($1, $2, $3)",
            [item.id, `<historical-${index}@example.test>`, id],
          );
          expect(meta.rowCount).toBe(1);
        }
      });
      await runThreadsDatabaseCutoverMigration(runtime);
      const read = () =>
        runtime.query<{ item_id: string; created_at: Date }>(
          "SELECT item_id, created_at FROM mail_threads WHERE tenant_id = app_tenant_default() AND id = $1",
          [id],
        );
      const first = await read();
      expect(first.rows).toHaveLength(1);
      expect(first.rows[0]?.item_id).toBeTruthy();
      const exact = await runtime.query<{ stamp: string }>(
        `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS stamp FROM mail_threads WHERE tenant_id = app_tenant_default() AND id = $1`,
        [id],
      );
      expect(exact.rows).toEqual([{ stamp: "2025-01-01T00:00:00.123456Z" }]);
      await runThreadsDatabaseCutoverMigration(runtime);
      expect((await read()).rows).toEqual(first.rows);
    });
  });
  it("backfills more than one batch without touching another tenant", async () => {
    const foreign = await createTestTenant(admin);
    await runInTenant(foreign, () => seedSystem(runtime));
    const seed = async (count: number) => {
      // Synthetic pre-cutover rows: the current thread writer always creates the item immediately.
      const result = await runtime.query<{ id: string }>(
        "INSERT INTO mail_threads (subject_hint) SELECT 'Historical' FROM generate_series(1, $1::int) RETURNING id",
        [count],
      );
      expect(result.rowCount).toBe(count);
      return result.rows.map((row) => row.id);
    };
    const foreignIds = await runInTenant(foreign, () => seed(1));
    await runInTenant(tenant, async () => {
      const ids = await seed(201);
      await runThreadsDatabaseCutoverMigration(runtime);
      const rows = await runtime.query<{ total: number; filled: number }>(
        "SELECT count(*)::int AS total, count(item_id)::int AS filled FROM mail_threads WHERE tenant_id = app_tenant_default() AND id = ANY($1::uuid[])",
        [ids],
      );
      expect(rows.rows).toEqual([{ total: 201, filled: 201 }]);
    });
    await runInTenant(foreign, async () => {
      const rows = await runtime.query<{ item_id: string | null }>(
        "SELECT item_id FROM mail_threads WHERE tenant_id = app_tenant_default() AND id = $1",
        [foreignIds[0]],
      );
      expect(rows.rows).toEqual([{ item_id: null }]);
    });
  });
  it("runs the registered populated-tenant cutover and preserves its result on replay", async () => {
    const id = await runInTenant(tenant, async () => {
      // Synthetic pre-cutover row; current creation always creates the Threads item.
      const inserted = await runtime.query<{ id: string }>(
        "INSERT INTO mail_threads (subject_hint) VALUES ('Runner fixture') RETURNING id",
      );
      expect(inserted.rowCount).toBe(1);
      return inserted.rows[0]!.id;
    });
    const run = () => runAsSystem("test registered Threads cutover", () => runTenantCutoverMigrations(runtime));
    await run();
    const read = () =>
      runInTenant(tenant, () =>
        runtime.query<{ item_id: string | null }>(
          "SELECT item_id FROM mail_threads WHERE tenant_id = app_tenant_default() AND id = $1",
          [id],
        ),
      );
    const first = await read();
    expect(first.rows[0]?.item_id).toBeTruthy();
    await run();
    expect((await read()).rows).toEqual(first.rows);
  });

  it("does nothing for a tenant without Emails", async () => {
    const empty = await createTestTenant(admin);
    await runInTenant(empty, async () => {
      await runThreadsDatabaseCutoverMigration(runtime);
      const rows = await runtime.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM databases WHERE tenant_id = app_tenant_default() AND owner_module_id = 'threads'",
      );
      expect(rows.rows).toEqual([{ count: 0 }]);
    });
  });
});
