import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { ingestEmailMessage } from "../ingest.js";
import { LocalFsBlobStorageWriter } from "../blobStorage.js";

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
          { key: "tasks", type: "relation", owner: "user" },
          { key: "attachments", type: "relation", owner: "system" },
        ]),
      );
      expect(properties).toHaveLength(5);
      const definitions = await runtime.query<{ key: string; cardinality: string; property_id_b: string | null }>(
        `SELECT p.key, r.cardinality, r.property_id_b FROM properties p JOIN relation_definitions r ON r.tenant_id = p.tenant_id AND r.property_id_a = p.id WHERE p.tenant_id = app_tenant_default() AND p.database_id = $1 ORDER BY p.key`,
        [database.id],
      );
      expect(definitions.rows).toEqual([
        { key: "attachments", cardinality: "one_to_many", property_id_b: null },
        { key: "company", cardinality: "many_to_many", property_id_b: null },
        { key: "project", cardinality: "many_to_many", property_id_b: null },
        { key: "tasks", cardinality: "one_to_many", property_id_b: null },
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
  it("preserves an ingested message subject on its canonical Threads item", async () => {
    await runInTenant(tenant, async () => {
      const cp = createChokePoint(runtime);
      const databases = await cp.listDatabases();
      const db = (key: string) => {
        const value = databases.find((entry) => entry.ownerModuleId === key);
        if (!value) throw new Error(`Missing ${key} database`);
        return value.id;
      };
      const props = await cp.listProperties(db("emails"));
      const prop = (key: string) => {
        const value = props.find((entry) => entry.key === key);
        if (!value) throw new Error(`Missing ${key} property`);
        return value.id;
      };
      const mailbox = await cp.createItem({
        databaseId: db("mailboxes"),
        properties: { name: "Mailbox", provider: "gmail" },
      });
      const folder = await withTransaction(runtime, (client) =>
        createItemWithClient(
          client,
          {
            databaseId: db("folders"),
            properties: { name: "Inbox", behavior: "folder", specialPurpose: "inbox" },
          },
          { allowedSystemKeys: ["name", "behavior", "specialPurpose"] },
        ),
      );
      const result = await withTransaction(runtime, (client) =>
        ingestEmailMessage(client, {
          emailsDatabaseId: db("emails"),
          filesDatabaseId: db("files"),
          folderRelationPropertyId: prop("folder"),
          attachmentsRelationPropertyId: prop("attachments"),
          mailboxItemId: mailbox.id,
          folderItemId: folder.id,
          messageId: "<subject@example.test>",
          references: [],
          subject: "Canonical ingested subject",
          envelope: { from: { address: "sender@example.test" } },
          bodyText: "Body",
          attachments: [],
          storage: new LocalFsBlobStorageWriter(join(tmpdir(), `threads-ingest-${randomUUID()}`)),
          storageKeyPrefix: "fixture",
        }),
      );
      const linked = await withTransaction(runtime, (client) =>
        client.query<{ email_id: string; thread_id: string; item_id: string; name: string }>(
          `SELECT m.item_id AS email_id, t.id AS thread_id, t.item_id, i.properties->>'name' AS name
         FROM mail_message_meta m JOIN mail_threads t ON t.tenant_id = m.tenant_id AND t.id = m.thread_id
         JOIN items i ON i.tenant_id = t.tenant_id AND i.database_id = $2 AND i.id = t.item_id
         WHERE m.tenant_id = app_tenant_default() AND m.item_id = $1`,
          [result.itemId, db("threads")],
        ),
      );
      expect(linked.rows).toEqual([
        {
          email_id: result.itemId,
          thread_id: expect.any(String),
          item_id: expect.any(String),
          name: "Canonical ingested subject",
        },
      ]);
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
  it("creates a missing historical Threads catalog through the registered cutover and replays", async () => {
    const threadId = await runInTenant(tenant, () =>
      withTransaction(runtime, async (client) => {
        const threads = await getDatabaseByModuleId(client, "threads");
        const emails = await getDatabaseByModuleId(client, "emails");
        if (!threads || !emails) throw new Error("Missing seeded catalog");
        const existing = await client.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM items WHERE tenant_id = $1 AND database_id = $2",
          [tenant, threads.id],
        );
        expect(existing.rows).toEqual([{ count: 0 }]);
        // Synthetic pre-cutover catalog: supported current seeding always creates Threads.
        const removed = await client.query(
          "DELETE FROM databases WHERE tenant_id = $1 AND id = $2 AND owner_module_id = 'threads'",
          [tenant, threads.id],
        );
        expect(removed.rowCount).toBe(1);
        const thread = await client.query<{ id: string }>(
          "INSERT INTO mail_threads (tenant_id, subject_hint) VALUES ($1, 'Historical subject') RETURNING id",
          [tenant],
        );
        expect(thread.rowCount).toBe(1);
        if (!thread.rows[0]) throw new Error("Missing historical thread");
        const email = await createItemWithClient(
          client,
          {
            databaseId: emails.id,
            properties: { name: "Historical subject", date: "2025-01-01T00:00:00Z" },
          },
          { allowedSystemKeys: ["name", "date"] },
        );
        const meta = await client.query(
          "INSERT INTO mail_message_meta (tenant_id, item_id, message_id, thread_id) VALUES ($1, $2, $3, $4)",
          [tenant, email.id, `<historical-${thread.rows[0].id}@example.test>`, thread.rows[0].id],
        );
        expect(meta.rowCount).toBe(1);
        return thread.rows[0].id;
      }),
    );
    const run = () => runAsSystem("test registered missing Threads cutover", () => runTenantCutoverMigrations(runtime));
    await run();
    const read = () =>
      runInTenant(tenant, () =>
        withTransaction(runtime, async (client) => {
          const threads = await getDatabaseByModuleId(client, "threads");
          if (!threads) throw new Error("Threads catalog was not created");
          const properties = await createChokePoint(runtime).listProperties(threads.id);
          const row = await client.query<{ item_id: string; name: string; created_at: string }>(
            `SELECT t.item_id, i.properties->>'name' AS name,
          to_char(t.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
         FROM mail_threads t JOIN items i ON i.tenant_id = t.tenant_id AND i.database_id = $2 AND i.id = t.item_id
         WHERE t.tenant_id = $1 AND t.id = $3`,
            [tenant, threads.id, threadId],
          );
          return { threads, properties, rows: row.rows };
        }),
      );
    const first = await read();
    expect(first.threads.schemaLocked).toBe(true);
    expect(first.properties.map((property) => property.key).sort()).toEqual([
      "attachments",
      "company",
      "name",
      "project",
      "tasks",
    ]);
    expect(first.rows).toEqual([
      { item_id: expect.any(String), name: "Historical subject", created_at: "2025-01-01T00:00:00.000000Z" },
    ]);
    await run();
    expect(await read()).toEqual(first);
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
