import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import "../domainWriteHooks.js";
import { createUser } from "../auth/usersStore.js";
import { createAgentRun } from "../agentRuns/agentRunsStore.js";
import { createBlob } from "../blobs/blobsStore.js";
import { createDatabase, dropDatabaseWithPartition } from "../chokePoint/databasesStore.js";
import { insertItem } from "../chokePoint/itemsStore.js";
import { createProperty } from "../chokePoint/propertiesStore.js";
import { createView, deleteView } from "../chokePoint/viewsStore.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../db/pool.js";
import { mutateDocWithClient } from "../docs/docPersistence.js";
import { deleteDocByItemId, getOrCreateDoc } from "../docs/docsStore.js";
import { createMailThread } from "../mail/mailMessageMetaStore.js";
import { upsertMcpToolRegistration } from "../mcp/mcpToolRegistrationsStore.js";
import { writeNotification } from "../notifications/notify.js";
import { upsertWebPushSubscription } from "../push/pushSubscriptionsStore.js";
import { createHeartbeat } from "../scheduler/schedulerStore.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

/**
 * Issue #1066: foreign-key checks ignore row-level security, so each reference between tenant rows
 * has a (tenant_id, <column>) twin. A row of tenant B that names tenant A's parent must fail exactly
 * like one naming a random UUID (23503), so the outcome tells B nothing about A's ids.
 *
 * The parents are written through their production stores. The child rows are raw INSERTs on
 * purpose: the production writers check that the parent exists before they insert, so they would
 * refuse a foreign parent before the foreign key is reached, and these tests are about the key.
 */

interface Parents {
  userId: string;
  databaseId: string;
  propertyId: string;
  viewId: string;
  itemId: string;
  docId: string;
  heartbeatId: string;
  agentRunId: string;
  threadId: string;
  blobId: string;
  notificationId: string;
  pushSubscriptionId: string;
  toolRegistrationId: string;
}

let adminPool: Pool;
let pool: Pool;
let tenantA: string;
let tenantB: string;
let parentsA: Parents;
let parentsB: Parents;

/** Runs `fn` in one transaction inside `tenantId`, on the runtime-role pool. */
function inTenant<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(pool, fn));
}

async function seedParents(tenantId: string): Promise<Parents> {
  return inTenant(tenantId, async (client) => {
    const user = await createUser(client, {
      email: `${randomUUID()}@example.com`,
      passwordHash: "unused",
      tenantId,
    });
    const database = await createDatabase(client, { name: `Tenant FK ${tenantId}` });
    const property = await createProperty(client, {
      databaseId: database.id,
      key: "title",
      name: "Title",
      type: "text",
    });
    const view = await createView(
      client,
      { databaseId: database.id, type: "table", name: "Table" },
      createViewTypeRegistry(),
    );
    const item = await insertItem(client, { databaseId: database.id, properties: {} });
    const doc = await getOrCreateDoc(client, item.id, "page");
    const heartbeat = await createHeartbeat(client, {
      projectItemId: item.id,
      name: "Daily",
      rule: { kind: "dailyTime", at: "09:00" },
      actionId: "noop",
      enabled: false,
    });
    const agentRun = await createAgentRun(client, { triggeredBy: "user", task: "probe", userId: user.id });
    const thread = await createMailThread(client, "Probe");
    const blob = await createBlob(client, { mimeType: "text/plain", byteSize: 1, storageKey: `${tenantId}/probe` });
    const notificationId = await writeNotification(client, {
      userId: user.id,
      kind: "agent_run_error",
      linkHref: null,
      sourceTable: "agent_runs",
      sourceId: agentRun.id,
      transitionInstance: "1",
    });
    const subscription = await upsertWebPushSubscription(client, {
      userId: user.id,
      sessionId: null,
      endpoint: `https://push.example.com/${randomUUID()}`,
      p256dh: "p256dh",
      authSecret: "auth",
    });
    const registration = await upsertMcpToolRegistration(client, {
      mcpServerItemId: item.id,
      toolName: "probe",
      toolSchema: {},
    });
    return {
      userId: user.id,
      databaseId: database.id,
      propertyId: property.id,
      viewId: view.id,
      itemId: item.id,
      docId: doc.id,
      heartbeatId: heartbeat.id,
      agentRunId: agentRun.id,
      threadId: thread.id,
      blobId: blob.id,
      notificationId,
      pushSubscriptionId: subscription.id,
      toolRegistrationId: registration.id,
    };
  });
}

interface Reference {
  /** The parent kind as the issue names it. */
  parent: string;
  /** The twin that must refuse another tenant's parent. */
  constraint: string;
  table: string;
  column: string;
  parentId: (parents: Parents) => string;
  /**
   * The SQLSTATE for a random parent id when it is not the foreign-key violation: an items row is
   * routed to its database's partition before any constraint runs, so an unknown database has no
   * partition (23514).
   */
  unknownParentCode?: string;
  /** Inserts one child row of the tenant in scope pointing at `parentId`; `own` holds that tenant's other parents. */
  insert: (client: PoolClient, parentId: string, own: Parents) => Promise<unknown>;
}

const REFERENCES: Reference[] = [
  {
    parent: "database",
    constraint: "properties_database_id_tenant_fkey",
    table: "properties",
    column: "database_id",
    parentId: (p) => p.databaseId,
    insert: (client, id) =>
      client.query("INSERT INTO properties (database_id, key, name, type) VALUES ($1, $2, 'Probe', 'text')", [
        id,
        `probe_${randomUUID().slice(0, 8)}`,
      ]),
  },
  {
    parent: "database",
    constraint: "items_database_id_tenant_fkey",
    table: "items",
    column: "database_id",
    parentId: (p) => p.databaseId,
    unknownParentCode: "23514",
    insert: (client, id) => client.query("INSERT INTO items (database_id, properties) VALUES ($1, '{}')", [id]),
  },
  {
    parent: "property",
    constraint: "relation_definitions_property_id_a_tenant_fkey",
    table: "relation_definitions",
    column: "property_id_a",
    parentId: (p) => p.propertyId,
    insert: (client, id) => client.query("INSERT INTO relation_definitions (property_id_a) VALUES ($1)", [id]),
  },
  {
    parent: "view",
    constraint: "view_items_view_id_tenant_fkey",
    table: "view_items",
    column: "view_id",
    parentId: (p) => p.viewId,
    insert: (client, id, own) =>
      client.query("INSERT INTO view_items (view_id, item_id, position) VALUES ($1, $2, 0)", [id, own.itemId]),
  },
  {
    parent: "doc",
    constraint: "doc_updates_doc_id_tenant_fkey",
    table: "doc_updates",
    column: "doc_id",
    parentId: (p) => p.docId,
    insert: (client, id) => client.query("INSERT INTO doc_updates (doc_id, update) VALUES ($1, '\\x00')", [id]),
  },
  {
    parent: "heartbeat",
    constraint: "heartbeat_occurrences_heartbeat_id_tenant_fkey",
    table: "heartbeat_occurrences",
    column: "heartbeat_id",
    parentId: (p) => p.heartbeatId,
    insert: (client, id) =>
      client.query(
        `INSERT INTO heartbeat_occurrences (heartbeat_id, scheduled_for, rule_snapshot, status)
         VALUES ($1, now(), '{}', 'queued')`,
        [id],
      ),
  },
  {
    parent: "agent run",
    constraint: "agent_run_events_agent_run_id_tenant_fkey",
    table: "agent_run_events",
    column: "agent_run_id",
    parentId: (p) => p.agentRunId,
    insert: (client, id) =>
      client.query("INSERT INTO agent_run_events (agent_run_id, kind, payload) VALUES ($1, 'message', '{}')", [id]),
  },
  {
    parent: "thread",
    constraint: "mail_message_meta_thread_id_tenant_fkey",
    table: "mail_message_meta",
    column: "thread_id",
    parentId: (p) => p.threadId,
    insert: (client, id) =>
      client.query(
        "INSERT INTO mail_message_meta (item_id, message_id, mailbox_item_id, thread_id) VALUES ($1, $2, $3, $4)",
        [randomUUID(), `<${randomUUID()}@example.com>`, randomUUID(), id],
      ),
  },
  {
    parent: "blob",
    constraint: "mail_attachments_blob_id_tenant_fkey",
    table: "mail_attachments",
    column: "blob_id",
    parentId: (p) => p.blobId,
    insert: (client, id) =>
      client.query(
        `INSERT INTO mail_attachments (message_item_id, blob_id, filename, content_type, disposition, byte_size)
         VALUES ($1, $2, 'probe.txt', 'text/plain', 'attachment', 1)`,
        [randomUUID(), id],
      ),
  },
  {
    parent: "notification",
    constraint: "push_deliveries_notification_id_tenant_fkey",
    table: "push_deliveries",
    column: "notification_id",
    parentId: (p) => p.notificationId,
    insert: (client, id, own) =>
      client.query("INSERT INTO push_deliveries (notification_id, push_subscription_id) VALUES ($1, $2)", [
        id,
        own.pushSubscriptionId,
      ]),
  },
  {
    parent: "tool registration",
    constraint: "project_mcp_grants_mcp_tool_registration_id_tenant_fkey",
    table: "project_mcp_grants",
    column: "mcp_tool_registration_id",
    parentId: (p) => p.toolRegistrationId,
    insert: (client, id) =>
      client.query("INSERT INTO project_mcp_grants (project_item_id, mcp_tool_registration_id) VALUES ($1, $2)", [
        randomUUID(),
        id,
      ]),
  },
  {
    parent: "user",
    constraint: "project_agent_guidance_owner_user_id_tenant_fkey",
    table: "project_agent_guidance",
    column: "owner_user_id",
    parentId: (p) => p.userId,
    insert: (client, id) =>
      client.query(
        "INSERT INTO project_agent_guidance (project_item_id, owner_user_id, markdown) VALUES ($1, $2, 'Probe')",
        [randomUUID(), id],
      ),
  },
  {
    parent: "user",
    constraint: "notifications_user_id_tenant_fkey",
    table: "notifications",
    column: "user_id",
    parentId: (p) => p.userId,
    insert: (client, id) =>
      client.query(
        `INSERT INTO notifications (user_id, kind, title, source_table, source_id, transition_instance)
         VALUES ($1, 'agent_run_error', 'Probe', 'agent_runs', $2, 'probe')`,
        [id, randomUUID()],
      ),
  },
];

/** Rows of `table` whose `column` is `parentId`, limited to `tenantId` when it is given. */
async function countReferencing(table: string, column: string, parentId: string, tenantId?: string): Promise<number> {
  // `table` and `column` are always literals of this file or come from the closed REFERENCES list
  // above, never from input; the values are bound parameters.
  const tenantFilter = tenantId === undefined ? "" : " AND tenant_id = $2";
  const { rows } = await adminPool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table} WHERE ${column} = $1${tenantFilter}`,
    tenantId === undefined ? [parentId] : [parentId, tenantId],
  );
  return rows[0]?.n ?? 0;
}

describe("tenant-consistent composite foreign keys (issue #1066)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    pool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.end();
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    tenantA = await createTestTenant(adminPool);
    tenantB = await createTestTenant(adminPool);
    parentsA = await seedParents(tenantA);
    parentsB = await seedParents(tenantB);
  });

  describe.each(REFERENCES)("$constraint ($parent)", (reference) => {
    it("refuses tenant A's parent with 23503 from the twin, exactly like a random id", async () => {
      const foreignId = reference.parentId(parentsA);
      await expect(inTenant(tenantB, (client) => reference.insert(client, foreignId, parentsB))).rejects.toMatchObject({
        code: "23503",
        constraint: reference.constraint,
      });
      await expect(
        inTenant(tenantB, (client) => reference.insert(client, randomUUID(), parentsB)),
      ).rejects.toMatchObject({ code: reference.unknownParentCode ?? "23503" });
      expect(await countReferencing(reference.table, reference.column, foreignId, tenantB)).toBe(0);
    });

    it("accepts tenant B's own parent", async () => {
      const ownId = reference.parentId(parentsB);
      const before = await countReferencing(reference.table, reference.column, ownId);
      await inTenant(tenantB, (client) => reference.insert(client, ownId, parentsB));
      expect(await countReferencing(reference.table, reference.column, ownId)).toBe(before + 1);
    });
  });

  it("still cascades the delete of a database to its properties, views and view items", async () => {
    // A database of its own: the seeded one holds an item, and items do not cascade.
    const { databaseId, viewId } = await inTenant(tenantA, async (client) => {
      const database = await createDatabase(client, { name: "Cascade probe" });
      await createProperty(client, { databaseId: database.id, key: "title", name: "Title", type: "text" });
      const view = await createView(
        client,
        { databaseId: database.id, type: "table", name: "Table" },
        createViewTypeRegistry(),
      );
      await client.query("INSERT INTO view_items (view_id, item_id, position) VALUES ($1, $2, 0)", [
        view.id,
        randomUUID(),
      ]);
      return { databaseId: database.id, viewId: view.id };
    });
    expect(await countReferencing("properties", "database_id", databaseId)).toBe(1);
    expect(await countReferencing("view_items", "view_id", viewId)).toBe(1);

    await inTenant(tenantA, (client) => dropDatabaseWithPartition(client, databaseId));

    expect(await countReferencing("databases", "id", databaseId)).toBe(0);
    expect(await countReferencing("properties", "database_id", databaseId)).toBe(0);
    expect(await countReferencing("views", "database_id", databaseId)).toBe(0);
    expect(await countReferencing("view_items", "view_id", viewId)).toBe(0);
    expect(await countReferencing("properties", "database_id", parentsA.databaseId)).toBe(1);
  });

  it("still cascades the delete of a view to its view items", async () => {
    await inTenant(tenantA, (client) =>
      client.query("INSERT INTO view_items (view_id, item_id, position) VALUES ($1, $2, 0)", [
        parentsA.viewId,
        parentsA.itemId,
      ]),
    );
    await inTenant(tenantA, (client) => deleteView(client, parentsA.viewId));
    expect(await countReferencing("views", "id", parentsA.viewId)).toBe(0);
    expect(await countReferencing("view_items", "view_id", parentsA.viewId)).toBe(0);
  });

  it("still cascades the delete of a doc to its snapshots, updates and history", async () => {
    // getOrCreateDoc wrote the doc_snapshots row and the doc_snapshot_history baseline; one edit
    // through the production writer appends a doc_updates row and its doc_history_updates mirror,
    // so every child table holds a row before the delete.
    await inTenant(tenantA, (client) =>
      mutateDocWithClient(client, parentsA.docId, "user", (doc) => doc.getText("body").insert(0, "probe")),
    );
    const docChildren = ["doc_snapshots", "doc_updates", "doc_snapshot_history", "doc_history_updates"];
    for (const table of docChildren) {
      expect(await countReferencing(table, "doc_id", parentsA.docId), table).toBeGreaterThan(0);
    }
    await inTenant(tenantA, (client) => deleteDocByItemId(client, parentsA.itemId));
    expect(await countReferencing("docs", "id", parentsA.docId)).toBe(0);
    for (const table of docChildren) {
      expect(await countReferencing(table, "doc_id", parentsA.docId), table).toBe(0);
    }
    expect(await countReferencing("docs", "id", parentsB.docId)).toBe(1);
  });

  it("validates every foreign key that contains tenant_id", async () => {
    const { rows } = await adminPool.query<{ table_name: string; constraint_name: string; validated: boolean }>(
      `SELECT k.conrelid::regclass::text AS table_name, k.conname::text AS constraint_name, k.convalidated AS validated
         FROM pg_constraint k
        WHERE k.contype = 'f'
          AND k.connamespace = 'public'::regnamespace
          AND EXISTS (SELECT 1 FROM unnest(k.conkey) u(attnum)
                        JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.attnum
                       WHERE a.attname = 'tenant_id')
        ORDER BY 1, 2`,
    );
    expect(rows.filter((row) => row.constraint_name.endsWith("_tenant_fkey")).length).toBeGreaterThanOrEqual(31);
    expect(rows.filter((row) => !row.validated)).toEqual([]);
  });
});
