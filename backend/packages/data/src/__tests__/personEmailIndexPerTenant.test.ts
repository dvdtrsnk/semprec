import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { lookupPersonIdByEmail, reindexPersonEmails } from "../mail/personEmailIndexStore.js";

let pool: Pool;

/** Runs `fn` in a transaction on the owner role that is always rolled back. */
async function inRolledBackTransaction(fn: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await fn(client);
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
}

/** Reproduces the post-#1065 schema: the legacy global primary key is gone. */
async function dropLegacyKey(client: PoolClient): Promise<void> {
  await client.query("ALTER TABLE person_email_index DROP CONSTRAINT person_email_index_pkey");
}

async function addSecondTenant(client: PoolClient): Promise<string> {
  await client.query("DROP INDEX IF EXISTS tenants_single_tenant_guard");
  const { rows } = await client.query<{ id: string }>("INSERT INTO tenants (status) VALUES ('active') RETURNING id");
  const id = rows[0]?.id;
  if (!id) throw new Error("second tenant was not inserted");
  return id;
}

async function currentTenant(client: PoolClient): Promise<string> {
  const { rows } = await client.query<{ id: string }>("SELECT app_tenant_default() AS id");
  const id = rows[0]?.id;
  if (!id) throw new Error("no current tenant");
  return id;
}

async function scopeTo(client: PoolClient, tenantId: string): Promise<void> {
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
}

describe("person_email_index is keyed per tenant", () => {
  beforeAll(async () => {
    pool = getTestPool();
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("reports a conflict for the second Person in one tenant without the legacy key", async () => {
    await resetDatabase(pool);
    await inRolledBackTransaction(async (client) => {
      await dropLegacyKey(client);
      const p1 = randomUUID();
      const p2 = randomUUID();
      expect(await reindexPersonEmails(client, p1, ["a@example.com"])).toEqual({ conflicts: [] });
      expect(await reindexPersonEmails(client, p2, ["a@example.com"])).toEqual({ conflicts: ["a@example.com"] });
      expect(await lookupPersonIdByEmail(client, "a@example.com")).toBe(p1);
    });
  });

  it("lets two tenants claim the same address and resolves each in its own scope", async () => {
    await resetDatabase(pool);
    await inRolledBackTransaction(async (client) => {
      await dropLegacyKey(client);
      const tenantA = await currentTenant(client);
      const tenantB = await addSecondTenant(client);
      await client.query("SET LOCAL ROLE semprec_data");
      const p1 = randomUUID();
      const p2 = randomUUID();

      await scopeTo(client, tenantA);
      expect(await reindexPersonEmails(client, p1, ["a@example.com"])).toEqual({ conflicts: [] });
      await scopeTo(client, tenantB);
      expect(await reindexPersonEmails(client, p2, ["a@example.com"])).toEqual({ conflicts: [] });

      await scopeTo(client, tenantA);
      expect(await lookupPersonIdByEmail(client, "A@Example.com ")).toBe(p1);
      await scopeTo(client, tenantB);
      expect(await lookupPersonIdByEmail(client, "A@Example.com ")).toBe(p2);
    });
  });

  it("releasing an address in one tenant leaves the other tenant's row in place", async () => {
    await resetDatabase(pool);
    await inRolledBackTransaction(async (client) => {
      await dropLegacyKey(client);
      const tenantA = await currentTenant(client);
      const tenantB = await addSecondTenant(client);
      await client.query("SET LOCAL ROLE semprec_data");
      const p1 = randomUUID();
      const p2 = randomUUID();

      await scopeTo(client, tenantA);
      await reindexPersonEmails(client, p1, ["a@example.com"]);
      await scopeTo(client, tenantB);
      await reindexPersonEmails(client, p2, ["a@example.com"]);

      await reindexPersonEmails(client, p2, ["b@example.com"]);
      expect(await lookupPersonIdByEmail(client, "a@example.com")).toBeNull();
      expect(await lookupPersonIdByEmail(client, "b@example.com")).toBe(p2);

      await scopeTo(client, tenantA);
      expect(await lookupPersonIdByEmail(client, "a@example.com")).toBe(p1);
    });
  });

  it("keeps exactly one row when two concurrent reindexes claim one address on today's schema", async () => {
    await resetDatabase(pool);
    const first = await pool.connect();
    const second = await pool.connect();
    const p1 = randomUUID();
    const p2 = randomUUID();
    let secondResult: Promise<unknown> | undefined;
    try {
      await first.query("BEGIN");
      await second.query("BEGIN");
      const tenantId = await currentTenant(first);
      await scopeTo(first, tenantId);
      await scopeTo(second, tenantId);
      // The first claim is uncommitted, so the second one reads nothing and its insert
      // blocks on the first writer's row until that commits.
      await reindexPersonEmails(first, p1, ["a@example.com"]);
      secondResult = reindexPersonEmails(second, p2, ["a@example.com"]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await first.query("COMMIT");
      await expect(secondResult).resolves.toEqual({ conflicts: [] });
      await second.query("COMMIT");

      // The scope is transaction-local, so the post-commit check re-establishes it explicitly.
      await inRolledBackTransaction(async (client) => {
        await scopeTo(client, tenantId);
        const { rows } = await client.query<{ item_id: string }>(
          "SELECT item_id FROM person_email_index WHERE tenant_id = $1 AND email = 'a@example.com'",
          [tenantId],
        );
        expect(rows).toEqual([{ item_id: p1 }]);
      });
    } finally {
      // Roll the first connection back before settling the second: it holds the row lock the
      // second insert may still be blocked on. Neither connection is released while a query is
      // in flight, and a failure here must not replace the test's own error.
      const rollbackQuietly = async (client: typeof first): Promise<void> => {
        try {
          await client.query("ROLLBACK");
        } catch {
          // The transaction is already committed or the connection is broken; release proceeds.
        }
      };
      await rollbackQuietly(first);
      await secondResult?.catch(() => undefined);
      await rollbackQuietly(second);
      first.release();
      second.release();
    }
  });
});
