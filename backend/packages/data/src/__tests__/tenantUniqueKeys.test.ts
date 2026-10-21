import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../testSupport/testDb.js";
import { createUser } from "../auth/usersStore.js";

/**
 * Issue #1065: with the legacy global keys dropped (migration 0082), each formerly global
 * uniqueness holds per tenant only. The same key value is accepted once in each of two tenants,
 * and a second row with that value inside one tenant is still refused with `23505`.
 *
 * Every row is written with raw SQL because the test targets the unique keys themselves: the
 * production writers absorb a same-tenant duplicate on purpose (`ON CONFLICT`), so they cannot
 * surface the `23505` this test asserts.
 */

interface Tenant {
  id: string;
  userId: string;
}

interface KeyCase {
  table: string;
  constraint: string;
  /** Inserts one row carrying the shared key value; every other unique column is fresh per call. */
  insert: (client: PoolClient, tenant: Tenant) => Promise<unknown>;
}

const SHARED_ITEM_ID = "11111111-1111-4111-8111-111111111111";

const CASES: KeyCase[] = [
  {
    table: "idempotency_keys",
    constraint: "idempotency_keys_pkey",
    insert: (client) =>
      client.query("INSERT INTO idempotency_keys (key, database_id, item_id) VALUES ('shared-key', $1, $2)", [
        randomUUID(),
        randomUUID(),
      ]),
  },
  {
    table: "person_email_index",
    constraint: "person_email_index_pkey",
    insert: (client) =>
      client.query("INSERT INTO person_email_index (email, item_id) VALUES ('shared@example.com', $1)", [randomUUID()]),
  },
  {
    table: "module_migrations",
    constraint: "module_migrations_pkey",
    insert: (client) =>
      client.query(
        `INSERT INTO module_migrations (module_id, database_key, from_version, to_version)
         VALUES ('sharedModule', 'sharedDatabase', '1.0.0', '2.0.0')`,
      ),
  },
  {
    table: "module_migration_progress",
    constraint: "module_migration_progress_pkey",
    insert: (client) =>
      client.query(
        `INSERT INTO module_migration_progress (module_id, database_key, from_version, to_version)
         VALUES ('sharedModule', 'sharedDatabase', '1.0.0', '2.0.0')`,
      ),
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
    insert: (client) =>
      client.query(
        `INSERT INTO mail_message_meta (item_id, message_id, envelope, mailbox_item_id, provider_message_id)
         VALUES ($1, $2, '{}'::jsonb, $3, 'shared-provider-id')`,
        [randomUUID(), `<${randomUUID()}@example.com>`, randomUUID()],
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

/** Counts `table`'s rows visible in `tenant`'s scope through the runtime role. */
async function countRows(table: string, tenant: Tenant): Promise<number> {
  return withTenantTransaction(dataPool, tenant.id, async (client) => {
    // `table` comes from the closed CASES list above, never from input.
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
  });

  afterAll(async () => {
    await dataPool?.end();
    await adminPool?.end();
  });

  it.each(CASES)("accepts the same $table key in two tenants", async ({ table, insert }) => {
    await withTenantTransaction(dataPool, tenantA.id, (client) => insert(client, tenantA));
    await withTenantTransaction(dataPool, tenantB.id, (client) => insert(client, tenantB));

    expect(await countRows(table, tenantA)).toBe(1);
    expect(await countRows(table, tenantB)).toBe(1);
  });

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
