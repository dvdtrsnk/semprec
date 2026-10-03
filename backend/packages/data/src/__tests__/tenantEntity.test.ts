import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runMigrations } from "../db/migrate.js";
import { createPool, withTransaction } from "../db/pool.js";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createUser } from "../auth/usersStore.js";
import { bootstrapFirstAccount } from "../auth/authActions.js";
import { getSoleTenantId } from "../tenancy/tenantsStore.js";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");
const THIS_MIGRATION = "0056_tenants.sql";
const SCRATCH_TEST_TIMEOUT_MS = 120_000;

function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set — is vitest.config.ts's globalSetup wired up?");
  return url;
}

/** A database of its own: the shared test database has the single-tenant guard dropped by the harness. */
async function withFreshDatabase(fn: (pool: Pool) => Promise<void>): Promise<void> {
  const name = `tenant_entity_${randomUUID().replaceAll("-", "")}`;
  const admin = createPool(testDatabaseUrl());
  try {
    await admin.query(`CREATE DATABASE "${name}" ENCODING 'UTF8' TEMPLATE template0`);
  } catch (createError) {
    try {
      await admin.end();
    } catch {
      // The CREATE DATABASE rejection is the real failure; a failed pool teardown must not replace it.
    }
    throw createError;
  }
  const url = new URL(testDatabaseUrl());
  url.pathname = `/${name}`;
  const pool = createPool(url.toString());
  let failure: { error: unknown } | undefined;
  try {
    await fn(pool);
  } catch (error) {
    failure = { error };
  }
  const cleanup = [() => pool.end(), () => admin.query(`DROP DATABASE "${name}" WITH (FORCE)`), () => admin.end()];
  for (const step of cleanup) {
    try {
      await step();
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure) throw failure.error;
}

/** Migrates a scratch database through every migration before this one, runs `beforeThis`, then applies this one. */
async function migrateAcrossThisMigration(pool: Pool, beforeThis?: (pool: Pool) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "semprec-tenant-entity-"));
  try {
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql") && f < THIS_MIGRATION).sort();
    await mkdir(dir, { recursive: true });
    for (const file of files) await copyFile(path.join(MIGRATIONS_DIR, file), path.join(dir, file));
    await runMigrations(pool, dir);
    await beforeThis?.(pool);
    await copyFile(path.join(MIGRATIONS_DIR, THIS_MIGRATION), path.join(dir, THIS_MIGRATION));
    await runMigrations(pool, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function scalar(pool: Pool, sql: string): Promise<string | null> {
  const { rows } = await pool.query<{ v: string | null }>(sql);
  return rows[0]?.v ?? null;
}

describe("tenant entity (issue #968)", () => {
  describe("on a scratch database", () => {
    it(
      "creates exactly one active tenant zero that the sole-tenant functions resolve",
      async () => {
        await withFreshDatabase(async (pool) => {
          await migrateAcrossThisMigration(pool);

          const { rows } = await pool.query<{ id: string; status: string }>("SELECT id, status FROM tenants");
          expect(rows).toHaveLength(1);
          expect(rows[0]?.status).toBe("active");
          const tenantId = rows[0]?.id;
          expect(await scalar(pool, "SELECT app_sole_tenant()::text AS v")).toBe(tenantId);
          expect(await scalar(pool, "SELECT app_tenant_default()::text AS v")).toBe(tenantId);
          expect(await scalar(pool, "SELECT obj_description('tenants'::regclass, 'pg_class') AS v")).toBe(
            "semprec:tenancy=global",
          );
        });
      },
      SCRATCH_TEST_TIMEOUT_MS,
    );

    it(
      "binds only the earliest pre-existing user to tenant zero as admin",
      async () => {
        await withFreshDatabase(async (pool) => {
          await migrateAcrossThisMigration(pool, async (p) => {
            await p.query(
              `INSERT INTO users (email, password_hash, created_at) VALUES
                 ('later@example.com', 'x', now()), ('earlier@example.com', 'x', now() - interval '1 day')`,
            );
          });

          const tenantId = await scalar(pool, "SELECT id::text AS v FROM tenants");
          const { rows } = await pool.query<{ email: string; tenant_id: string | null; role: string }>(
            "SELECT email, tenant_id, role FROM users ORDER BY email",
          );
          expect(rows).toEqual([
            { email: "earlier@example.com", tenant_id: tenantId, role: "admin" },
            { email: "later@example.com", tenant_id: null, role: "member" },
          ]);
        });
      },
      SCRATCH_TEST_TIMEOUT_MS,
    );

    it(
      "rejects a second tenant through the single-tenant guard",
      async () => {
        await withFreshDatabase(async (pool) => {
          await migrateAcrossThisMigration(pool);

          await expect(pool.query("INSERT INTO tenants DEFAULT VALUES")).rejects.toMatchObject({
            code: "23505",
            constraint: "tenants_single_tenant_guard",
          });
        });
      },
      SCRATCH_TEST_TIMEOUT_MS,
    );

    it(
      "scopes app_current_tenant() and app_tenant_default() to the transaction-local setting",
      async () => {
        await withFreshDatabase(async (pool) => {
          await migrateAcrossThisMigration(pool);
          const tenantZero = await scalar(pool, "SELECT id::text AS v FROM tenants");
          const scoped = randomUUID();
          const client = await pool.connect();
          try {
            const read = async (): Promise<{ current: string | null; dflt: string | null }> => {
              const { rows } = await client.query<{ current: string | null; dflt: string | null }>(
                "SELECT app_current_tenant()::text AS current, app_tenant_default()::text AS dflt",
              );
              return rows[0] ?? { current: null, dflt: null };
            };

            expect(await read()).toEqual({ current: null, dflt: tenantZero });

            await client.query("BEGIN");
            await client.query("SELECT set_config('app.tenant_id', $1, true)", [scoped]);
            expect(await read()).toEqual({ current: scoped, dflt: scoped });
            await client.query("COMMIT");

            expect(await read()).toEqual({ current: null, dflt: tenantZero });

            await client.query("BEGIN");
            await client.query("SELECT set_config('app.tenant_id', 'not-a-uuid', true)");
            await expect(client.query("SELECT app_current_tenant()")).rejects.toThrow(/invalid input syntax/);
            await client.query("ROLLBACK");
            await client.query("BEGIN");
            await client.query("SELECT set_config('app.tenant_id', 'not-a-uuid', true)");
            await expect(client.query("SELECT app_tenant_default()")).rejects.toThrow(/invalid input syntax/);
            await client.query("ROLLBACK");
          } finally {
            client.release();
          }
        });
      },
      SCRATCH_TEST_TIMEOUT_MS,
    );
  });

  describe("on the shared test database", () => {
    const pool = getTestPool();
    beforeEach(async () => {
      await resetDatabase(pool);
    });
    afterAll(async () => {
      await pool.end();
    });

    it("binds the bootstrapped account to the sole tenant as admin without changing the result shape", async () => {
      const account = await bootstrapFirstAccount(pool, "tok", "tok", {
        email: "owner@example.com",
        password: "s3cret-password",
      });

      expect(Object.keys(account).sort()).toEqual(["createdAt", "email", "id", "locale"]);
      const { rows } = await pool.query<{ tenant_id: string; role: string }>(
        "SELECT tenant_id, role FROM users WHERE id = $1",
        [account.id],
      );
      expect(rows).toEqual([{ tenant_id: await getSoleTenantId(pool), role: "admin" }]);
    });

    it("throws the invariant error when no tenant exists", async () => {
      await expect(
        withTransaction(pool, async (client) => {
          await client.query("UPDATE users SET tenant_id = NULL");
          await client.query("DELETE FROM tenants");
          await getSoleTenantId(client);
          throw new Error("unreachable: getSoleTenantId should have thrown");
        }),
      ).rejects.toThrow("Expected exactly one tenant, found none or several");
      // The delete was rolled back with the transaction.
      expect(await getSoleTenantId(pool)).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("createUser stores NULL/member by default and the given tenant and role when passed", async () => {
      const a = await createUser(pool, { email: "a@example.com", passwordHash: "x" });
      const b = await createUser(pool, { email: "b@example.com", passwordHash: "x" });
      const tenantId = await getSoleTenantId(pool);
      const c = await createUser(pool, { email: "c@example.com", passwordHash: "x", tenantId, role: "admin" });

      const { rows } = await pool.query<{ id: string; tenant_id: string | null; role: string }>(
        "SELECT id, tenant_id, role FROM users WHERE id = ANY($1)",
        [[a.id, b.id, c.id]],
      );
      const byId = new Map(rows.map((r) => [r.id, r]));
      expect(byId.get(a.id)).toMatchObject({ tenant_id: null, role: "member" });
      expect(byId.get(b.id)).toMatchObject({ tenant_id: null, role: "member" });
      expect(byId.get(c.id)).toMatchObject({ tenant_id: tenantId, role: "admin" });
    });
  });
});
