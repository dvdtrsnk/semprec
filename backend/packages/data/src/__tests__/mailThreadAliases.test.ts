import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../db/migrate.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import "../domainWriteHooks.js";
import { withTransaction } from "../db/pool.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createMailThread, reassignThread, resolveMergedThreadId } from "../mail/mailMessageMetaStore.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";

let adminPool: Pool;
let pool: Pool;
let tenantA: string;
let tenantB: string;

function inTenant<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(pool, fn));
}

function newThread(tenantId: string): Promise<string> {
  return inTenant(tenantId, async (client) => (await createMailThread(client)).id);
}

function merge(tenantId: string, from: string, to: string): Promise<void> {
  return inTenant(tenantId, (client) => reassignThread(client, from, to));
}

function resolve(tenantId: string, id: string): Promise<string | null> {
  return inTenant(tenantId, (client) => resolveMergedThreadId(client, id));
}

async function aliasRows(): Promise<{ from: string; to: string }[]> {
  const { rows } = await adminPool.query<{ from: string; to: string }>(
    'SELECT from_thread_id AS "from", to_thread_id AS "to" FROM mail_thread_aliases',
  );
  return rows;
}

describe("mail thread aliases", () => {
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
    tenantA = getTenantZeroId();
    tenantB = await createTestTenant(adminPool);
    for (const tenant of [tenantA, tenantB]) await runInTenant(tenant, () => seedSystem(pool));
  });

  it("resolves a chain of merges to the final thread in one query each", async () => {
    const a = await newThread(tenantA);
    const b = await newThread(tenantA);
    const c = await newThread(tenantA);
    await merge(tenantA, a, b);
    await merge(tenantA, b, c);

    const countingPool = await createRuntimeRolePool(adminPool, "semprec_data");
    let resolvedAndCounted: { fromA: string | null; fromB: string | null; perCall: number[] } | undefined;
    const failures: unknown[] = [];
    try {
      resolvedAndCounted = await runInTenant(tenantA, () =>
        withTransaction(countingPool, async (client) => {
          const query = vi.spyOn(client, "query");
          try {
            const fromA = await resolveMergedThreadId(client, a);
            const afterA = query.mock.calls.length;
            const fromB = await resolveMergedThreadId(client, b);
            return { fromA, fromB, perCall: [afterA, query.mock.calls.length - afterA] };
          } finally {
            query.mockRestore();
          }
        }),
      );
    } catch (error) {
      failures.push(error);
    }
    try {
      await countingPool.end();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Alias query count and cleanup failed");

    expect(resolvedAndCounted).toEqual({ fromA: c, fromB: c, perCall: [1, 1] });
    expect(await resolve(tenantA, c)).toBe(c);
    const rows = await aliasRows();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.to === c)).toBe(true);
  });

  it("writes no alias when a thread is merged with itself and keeps the thread", async () => {
    const a = await newThread(tenantA);
    await merge(tenantA, a, a);
    expect(await aliasRows()).toEqual([]);
    expect(await resolve(tenantA, a)).toBe(a);
  });

  it("returns null for an unknown id without an alias", async () => {
    expect(await resolve(tenantA, "00000000-0000-4000-8000-000000000001")).toBeNull();
  });

  it("enforces alias constraints in the runtime role and cascades only the owning target", async () => {
    const targetA = await newThread(tenantA);
    const targetB = await newThread(tenantB);
    const aliasA = randomUUID();
    const aliasB = randomUUID();
    const insert = (tenantId: string, from: string, to: string) =>
      inTenant(tenantId, (client) =>
        client.query("INSERT INTO mail_thread_aliases (from_thread_id, to_thread_id) VALUES ($1, $2)", [from, to]),
      );
    await insert(tenantA, aliasA, targetA);
    await insert(tenantB, aliasB, targetB);
    await expect(insert(tenantA, targetA, targetA)).rejects.toMatchObject({ code: "23514" });
    await expect(insert(tenantA, randomUUID(), targetB)).rejects.toMatchObject({ code: "23503" });
    await expect(insert(tenantA, aliasA, targetA)).rejects.toMatchObject({ code: "23505" });
    await expect(
      inTenant(tenantA, (client) =>
        client.query("INSERT INTO mail_thread_aliases (tenant_id, from_thread_id, to_thread_id) VALUES ($1, $2, $3)", [
          tenantB,
          randomUUID(),
          targetB,
        ]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    expect(await aliasRows()).toHaveLength(2);
    await inTenant(tenantA, (client) => client.query("DELETE FROM mail_threads WHERE id = $1", [targetA]));
    expect(await resolve(tenantA, aliasA)).toBeNull();
    expect(await resolve(tenantB, aliasB)).toBe(targetB);
    expect(await aliasRows()).toEqual([{ from: aliasB, to: targetB }]);
  });

  it("does not expose one tenant's aliases to another", async () => {
    const a = await newThread(tenantA);
    const b = await newThread(tenantA);
    await merge(tenantA, a, b);
    expect(await resolve(tenantA, a)).toBe(b);
    expect(await resolve(tenantB, a)).toBeNull();
    const visible = await inTenant(
      tenantB,
      async (client) => (await client.query("SELECT 1 FROM mail_thread_aliases")).rows,
    );
    expect(visible).toEqual([]);
  });
});

it("upgrades populated legacy state before installing the alias table", async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("Missing test database URL");
  const name = `mail_upgrade_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url });
  const dir = await mkdtemp(path.join(tmpdir(), "semprec-mail-upgrade-"));
  const migrations = fileURLToPath(new URL("../db/migrations/", import.meta.url));
  const target = "0111_mail_thread_aliases.sql";
  const existingId = randomUUID();
  let scratch: Pool | undefined;
  let created = false;
  const failures: unknown[] = [];
  try {
    // name is a fixed prefix followed only by hexadecimal UUID digits.
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const scratchUrl = new URL(url);
    scratchUrl.pathname = `/${name}`;
    scratch = new Pool({ connectionString: scratchUrl.toString() });
    const database = scratch;
    for (const file of (await readdir(migrations)).filter((entry) => entry.endsWith(".sql") && entry < target).sort()) {
      await copyFile(path.join(migrations, file), path.join(dir, file));
    }
    await runMigrations(database, dir);
    const tenant = await database.query<{ id: string }>("SELECT id FROM tenants ORDER BY id LIMIT 1");
    const tenantId = tenant.rows[0]?.id;
    if (!tenantId) throw new Error("Missing tenant");
    await runInTenant(tenantId, () =>
      withTransaction(database, (client) =>
        client.query("INSERT INTO mail_threads (id, subject_hint) VALUES ($1, 'legacy thread')", [existingId]),
      ),
    );
    await copyFile(path.join(migrations, target), path.join(dir, target));
    await runMigrations(database, dir);
    const preserved = await runInTenant(tenantId, () =>
      withTransaction(database, (client) =>
        client.query<{ subject_hint: string }>("SELECT subject_hint FROM mail_threads WHERE id = $1", [existingId]),
      ),
    );
    expect(preserved.rows).toEqual([{ subject_hint: "legacy thread" }]);
    const catalog = await database.query<{ relrowsecurity: boolean; comment: string | null }>(
      "SELECT c.relrowsecurity, obj_description(c.oid, 'pg_class') AS comment FROM pg_class c WHERE c.oid = 'mail_thread_aliases'::regclass",
    );
    expect(catalog.rows[0]).toEqual({ relrowsecurity: true, comment: "semprec:tenancy=tenant" });
  } catch (error) {
    failures.push(error);
  }
  try {
    await scratch?.end();
  } catch (error) {
    failures.push(error);
  }
  try {
    // The same fixed-prefix, hexadecimal UUID identifier was created above.
    if (created) await admin.query(`DROP DATABASE "${name}"`);
  } catch (error) {
    failures.push(error);
  }
  try {
    await admin.end();
  } catch (error) {
    failures.push(error);
  }
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Upgrade test and cleanup failed");
});
