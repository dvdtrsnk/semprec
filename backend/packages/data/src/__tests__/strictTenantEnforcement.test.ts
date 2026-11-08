import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant, TenantScopeMissingError } from "@semprec/shared";
import { bootstrapFirstAccount } from "../auth/authActions.js";
import { createPool } from "../db/pool.js";
import {
  createRuntimeRolePool,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../testSupport/testDb.js";

/**
 * Issue #1067: the strict switch. `app_tenant_default()` no longer falls back to the sole tenant and
 * an unset `SEMPREC_TENANT_SCOPE` means strict. Assertions go through a runtime-role pool (the
 * superuser pool bypasses row-level security); `tenant_observability_checks` stands in for every
 * tenant table, since all of them share the same default and policies.
 */
const MIGRATION_SQL = await readFile(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations/0085_strict_tenant_enforcement.sql"),
  "utf8",
);
const SELECT_CHECKS = "SELECT check_key, tenant_id FROM tenant_observability_checks ORDER BY check_key";
const INSERT_CHECK =
  "INSERT INTO tenant_observability_checks (check_key, status) VALUES ($1, 'ok') RETURNING tenant_id";

let adminPool: Pool;
const originalMode = process.env.SEMPREC_TENANT_SCOPE;

function restoreMode(): void {
  if (originalMode === undefined) delete process.env.SEMPREC_TENANT_SCOPE;
  else process.env.SEMPREC_TENANT_SCOPE = originalMode;
}

/** Every check row of every tenant, read on the superuser pool so no policy hides one. */
async function allCheckKeys(): Promise<string[]> {
  const { rows } = await adminPool.query<{ check_key: string }>(
    "SELECT check_key FROM tenant_observability_checks ORDER BY check_key",
  );
  return rows.map((row) => row.check_key);
}

beforeAll(() => {
  adminPool = getTestPool();
});

afterAll(async () => {
  await adminPool?.end();
});

beforeEach(async () => {
  await resetDatabase(adminPool);
  await withTenantTransaction(adminPool, getTenantZeroId(), (client) =>
    client.query("INSERT INTO tenant_observability_checks (check_key, status) VALUES ('seeded', 'ok')"),
  );
});

afterEach(() => {
  restoreMode();
});

describe("tenant tables with only tenant zero present (issue #1067)", () => {
  let sidePool: Pool;

  beforeAll(async () => {
    sidePool = await createRuntimeRolePool(adminPool, "semprec_side");
  });

  afterAll(async () => {
    await sidePool?.end();
  });

  it("shows no row and refuses a defaulted insert without a scope in warn mode", async () => {
    process.env.SEMPREC_TENANT_SCOPE = "warn";
    const { rows } = await sidePool.query(SELECT_CHECKS);
    expect(rows).toEqual([]);

    const refusal: unknown = await sidePool.query(INSERT_CHECK, ["unscoped"]).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(Error);
    expect(["42501", "23502"]).toContain((refusal as { code?: unknown }).code);
    expect(await allCheckKeys()).toEqual(["seeded"]);
  });

  it.each([undefined, ""])(
    "rejects both calls with TenantScopeMissingError before any statement with SEMPREC_TENANT_SCOPE=%j",
    async (mode) => {
      // A fresh pool: it has opened no connection yet, so a statement sent would show in totalCount.
      const freshPool = await createRuntimeRolePool(adminPool, "semprec_side");
      try {
        if (mode === undefined) delete process.env.SEMPREC_TENANT_SCOPE;
        else process.env.SEMPREC_TENANT_SCOPE = mode;
        await expect(freshPool.query(SELECT_CHECKS)).rejects.toBeInstanceOf(TenantScopeMissingError);
        await expect(freshPool.query(INSERT_CHECK, ["unscoped"])).rejects.toBeInstanceOf(TenantScopeMissingError);
        expect(freshPool.totalCount).toBe(0);
      } finally {
        restoreMode();
        await freshPool.end();
      }
      expect(await allCheckKeys()).toEqual(["seeded"]);
    },
  );

  it("reads and inserts tenant zero's rows inside runInTenant(tenant zero)", async () => {
    delete process.env.SEMPREC_TENANT_SCOPE;
    const tenantZero = getTenantZeroId();
    await runInTenant(tenantZero, async () => {
      const inserted = await sidePool.query<{ tenant_id: string }>(INSERT_CHECK, ["scoped"]);
      expect(inserted.rows).toEqual([{ tenant_id: tenantZero }]);
      const { rows } = await sidePool.query(SELECT_CHECKS);
      expect(rows).toEqual([
        { check_key: "scoped", tenant_id: tenantZero },
        { check_key: "seeded", tenant_id: tenantZero },
      ]);
    });
  });

  it("shows no tenant row inside runAsSystem", async () => {
    delete process.env.SEMPREC_TENANT_SCOPE;
    const { rows } = await runAsSystem("strict enforcement test", () => sidePool.query(SELECT_CHECKS));
    expect(rows).toEqual([]);
  });
});

describe("users.tenant_id NOT NULL (issue #1067)", () => {
  it("refuses a users row without tenant_id with 23502", async () => {
    await expect(
      adminPool.query("INSERT INTO users (email, password_hash) VALUES ($1, 'unused')", [
        `${randomUUID()}@example.com`,
      ]),
    ).rejects.toMatchObject({ code: "23502", column: "tenant_id" });
    const { rows } = await adminPool.query<{ count: string }>("SELECT count(*)::text AS count FROM users");
    expect(rows).toEqual([{ count: "0" }]);
  });

  it("still lets bootstrapFirstAccount create tenant zero's admin on an empty database", async () => {
    delete process.env.SEMPREC_TENANT_SCOPE;
    // Through the production pool constructor, in the system scope the setup route uses (`setupHandler.ts`).
    const setupPool = createPool(process.env.TEST_DATABASE_URL!);
    let account: { id: string };
    try {
      account = await runAsSystem("setup", () =>
        bootstrapFirstAccount(setupPool, "token", "token", { email: "owner@example.com", password: "s3cret-password" }),
      );
    } finally {
      await setupPool.end();
    }
    const { rows } = await adminPool.query<{ tenant_id: string; role: string }>(
      "SELECT tenant_id, role FROM users WHERE id = $1",
      [account.id],
    );
    expect(rows).toEqual([{ tenant_id: getTenantZeroId(), role: "admin" }]);
  });

  it("fails the migration with the guard's exception naming the count while a user has no tenant", async () => {
    const client = await adminPool.connect();
    try {
      await client.query("BEGIN");
      try {
        // Raw SQL: the state the guard refuses (a user with no tenant) cannot be produced any other way.
        await client.query("ALTER TABLE users ALTER COLUMN tenant_id DROP NOT NULL");
        await client.query("INSERT INTO users (email, password_hash) VALUES ($1, 'unused'), ($2, 'unused')", [
          `${randomUUID()}@example.com`,
          `${randomUUID()}@example.com`,
        ]);
        await expect(client.query(MIGRATION_SQL)).rejects.toMatchObject({
          code: "P0001",
          message: expect.stringContaining("2 users row(s) have a NULL tenant_id") as string,
        });
      } finally {
        await client.query("ROLLBACK");
      }
    } finally {
      client.release();
    }
    const { rows } = await adminPool.query<{ attnotnull: boolean }>(
      "SELECT attnotnull FROM pg_attribute WHERE attrelid = 'public.users'::regclass AND attname = 'tenant_id'",
    );
    expect(rows).toEqual([{ attnotnull: true }]);
  });
});
