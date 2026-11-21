import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  insertItemsWithIds,
  resetDatabase,
  withTenantTransaction,
} from "../testSupport/testDb.js";
import { createUser } from "../auth/usersStore.js";

/**
 * Each uniqueness holds per tenant only: one row per tenant is accepted, a second in the same tenant fails with
 * `23505`. Raw SQL because the production writers absorb same-tenant duplicates (`ON CONFLICT`).
 */

interface Tenant {
  id: string;
  userId: string;
}

interface KeyCase {
  table: string;
  constraint: string;
  insert: (client: PoolClient, tenant: Tenant) => Promise<unknown>;
  /** The key names an item, whose id exists in one tenant only, so two tenants never hold the same key. */
  singleTenant?: true;
}

const SHARED_ITEM_ID = "11111111-1111-4111-8111-111111111111";

/** An item of the client's tenant for a row whose item column has a key to items. */
async function itemOf(client: PoolClient): Promise<string> {
  const id = randomUUID();
  await insertItemsWithIds(client, [id]);
  return id;
}

const CASES: KeyCase[] = [
  {
    table: "idempotency_keys",
    constraint: "idempotency_keys_pkey",
    insert: async (client) =>
      client.query("INSERT INTO idempotency_keys (key, database_id, item_id) VALUES ('shared-key', $1, $2)", [
        randomUUID(),
        await itemOf(client),
      ]),
  },
  {
    table: "person_email_index",
    constraint: "person_email_index_pkey",
    insert: async (client) =>
      client.query("INSERT INTO person_email_index (email, item_id) VALUES ('shared@example.com', $1)", [
        await itemOf(client),
      ]),
  },
  {
    table: "blobs",
    constraint: "blobs_tenant_content_hash_uq",
    insert: (client) =>
      client.query(
        `INSERT INTO blobs (mime_type, byte_size, storage_key, content_hash)
         VALUES ('application/pdf', 1, $1, 'shared-hash')`,
        [`files/${randomUUID()}.pdf`],
      ),
  },
  {
    table: "mail_message_meta",
    constraint: "mail_message_meta_tenant_provider_msg_uq",
    insert: async (client) =>
      client.query(
        `INSERT INTO mail_message_meta (item_id, message_id, envelope, mailbox_item_id, provider_message_id, arrival)
         VALUES ($1, $2, '{}'::jsonb, $3, 'shared-provider-id', 'live')`,
        [await itemOf(client), `<${randomUUID()}@example.com>`, randomUUID()],
      ),
  },
  {
    table: "notifications",
    constraint: "notifications_tenant_dedupe_idx",
    insert: (client, tenant) =>
      client.query(
        `INSERT INTO notifications (user_id, kind, title, source_table, source_id, transition_instance)
         VALUES ($1, 'heartbeat_error', 'Shared', 'project_heartbeats', 'hb-shared', 'job-1')`,
        [tenant.userId],
      ),
  },
  {
    table: "manifest_drift_findings",
    constraint: "manifest_drift_findings_tenant_active_idx",
    insert: (client) =>
      client.query(
        "INSERT INTO manifest_drift_findings (kind, dedupe_key) VALUES ('unknownHeartbeatAction', 'shared-dedupe')",
      ),
  },
  {
    table: "docs",
    constraint: "docs_tenant_item_id_uq",
    insert: (client) => client.query("INSERT INTO docs (item_id) VALUES ($1)", [SHARED_ITEM_ID]),
    singleTenant: true,
  },
];

let adminPool: Pool;
let dataPool: Pool;
let tenantA: Tenant;
let tenantB: Tenant;

async function createTenantWithUser(): Promise<Tenant> {
  const id = await createTestTenant(adminPool);
  const user = await createUser(adminPool, {
    email: `${randomUUID()}@example.com`,
    passwordHash: "unused",
    tenantId: id,
  });
  return { id, userId: user.id };
}

async function countRows(table: string, tenant: Tenant): Promise<number> {
  return withTenantTransaction(dataPool, tenant.id, async (client) => {
    // `table` comes from the closed CASES list.
    const { rows } = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
    return rows[0]?.n ?? 0;
  });
}

describe("formerly global unique keys hold per tenant", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    tenantA = await createTenantWithUser();
    tenantB = await createTenantWithUser();
    // The docs case names one fixed item id; items.id is global, so only tenant A can hold that item.
    await withTenantTransaction(dataPool, tenantA.id, (client) => insertItemsWithIds(client, [SHARED_ITEM_ID]));
  });

  afterAll(async () => {
    await dataPool?.end();
    await adminPool?.end();
  });

  it.each(CASES.filter((entry) => entry.singleTenant !== true))(
    "accepts the same $table key in two tenants",
    async ({ table, insert }) => {
      await withTenantTransaction(dataPool, tenantA.id, (client) => insert(client, tenantA));
      await withTenantTransaction(dataPool, tenantB.id, (client) => insert(client, tenantB));

      expect(await countRows(table, tenantA)).toBe(1);
      expect(await countRows(table, tenantB)).toBe(1);
    },
  );

  it.each(CASES)(
    "refuses a duplicate $table key inside one tenant with 23505",
    async ({ table, constraint, insert }) => {
      await withTenantTransaction(dataPool, tenantA.id, (client) => insert(client, tenantA));

      await expect(
        withTenantTransaction(dataPool, tenantA.id, (client) => insert(client, tenantA)),
      ).rejects.toMatchObject({ code: "23505", constraint });
      expect(await countRows(table, tenantA)).toBe(1);
      expect(await countRows(table, tenantB)).toBe(0);
    },
  );
});
