import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  TenantScopeMissingError,
  currentTenantScope,
  runAsSystem,
  runInTenant,
  type TenantScope,
} from "@semprec/shared";
import { createPool, runAfterCommit, withTransaction } from "../db/pool.js";

const T = randomUUID();
const SETTING_SQL = "SELECT current_setting('app.tenant_id', true) AS setting, app_current_tenant() AS tenant";

type Reading = { setting: string | null; tenant: string | null };

let pool: Pool;
const extraPools: Pool[] = [];
const originalMode = process.env.SEMPREC_TENANT_SCOPE;

function newPool(max?: number): Pool {
  const created = createPool(process.env.TEST_DATABASE_URL!);
  if (max !== undefined) (created.options as { max?: number }).max = max;
  extraPools.push(created);
  return created;
}

async function readViaClient(p: Pool): Promise<Reading> {
  const client = await p.connect();
  try {
    return (await client.query<Reading>(SETTING_SQL)).rows[0]!;
  } finally {
    client.release();
  }
}

/** Reads the GUC through every scoped path, in the order: transaction variants, pool.query, connect. */
async function readAllPaths(p: Pool): Promise<Reading[]> {
  const readings: Reading[] = [];
  for (const isolation of [undefined, "repeatable_read", "serializable"] as const) {
    readings.push(
      await withTransaction(p, async (client) => (await client.query<Reading>(SETTING_SQL)).rows[0]!, {
        isolation,
      }),
    );
  }
  readings.push((await p.query<Reading>(SETTING_SQL)).rows[0]!);
  readings.push(await readViaClient(p));
  return readings;
}

beforeAll(() => {
  pool = newPool();
});

afterEach(() => {
  if (originalMode === undefined) delete process.env.SEMPREC_TENANT_SCOPE;
  else process.env.SEMPREC_TENANT_SCOPE = originalMode;
});

afterAll(async () => {
  await Promise.all(extraPools.map((p) => p.end()));
});

describe("tenant scope on the three pool paths", () => {
  it("sets app.tenant_id to the tenant inside runInTenant", async () => {
    const readings = await runInTenant(T, () => readAllPaths(pool));
    expect(readings).toHaveLength(5);
    for (const reading of readings) expect(reading).toEqual({ setting: T, tenant: T });
  });

  it("reads an empty setting and a NULL tenant inside runAsSystem", async () => {
    const readings = await runAsSystem("test", () => readAllPaths(pool));
    expect(readings).toHaveLength(5);
    for (const reading of readings) expect(reading).toEqual({ setting: "", tenant: null });
  });

  it("runs the three paths unchanged without a scope in warn mode", async () => {
    delete process.env.SEMPREC_TENANT_SCOPE;
    const readings = await readAllPaths(pool);
    for (const reading of readings) expect(reading.setting).not.toBe(T);
    // No set_config ran: the setting is unset (NULL) or '' left by an earlier session, never a tenant.
    for (const reading of readings) expect([null, ""]).toContain(reading.setting);
  });
});

describe("no leak between checkouts", () => {
  it("never carries a tenant to the next unscoped checkout on a single connection", async () => {
    const single = newPool(1);
    const pid = async (): Promise<number> =>
      Number((await single.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid);
    const before = await pid();

    await runInTenant(T, async () => {
      await single.query("SELECT 1");
      const client = await single.connect();
      client.release();
      await withTransaction(single, async (c) => c.query("SELECT 1"));
    });

    const client = await single.connect();
    try {
      const { rows } = await client.query<Reading & { pid: number }>(`${SETTING_SQL}, pg_backend_pid() AS pid`);
      expect(Number(rows[0]!.pid)).toBe(before);
      expect(rows[0]!.setting).not.toBe(T);
      expect(rows[0]!.tenant).toBeNull();
    } finally {
      client.release();
    }
  });

  it("rejects a scoped pool.query syntax error with the Postgres error and leaves a clean connection", async () => {
    const single = newPool(1);
    const failure = await runInTenant(T, () =>
      single.query("SELEKT 1").then(
        () => undefined,
        (err: unknown) => err,
      ),
    );
    expect(failure).toMatchObject({ code: "42601" });

    const { rows } = await single.query<Reading & { status: string }>(
      `${SETTING_SQL}, txid_current_if_assigned() IS NULL AS status`,
    );
    expect(rows[0]!.setting).not.toBe(T);
    expect(rows[0]!.tenant).toBeNull();
  });

  it("discards a killed scoped connection without throwing on release", async () => {
    const single = newPool(1);
    const client = await runInTenant(T, () => single.connect());
    client.on("error", () => undefined);
    const killedPid = Number((await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid);
    await pool.query("SELECT pg_terminate_backend($1)", [killedPid]);

    expect(() => client.release()).not.toThrow();
    // The reset fails asynchronously and destroys the connection; the next checkout is a new backend.
    const next = await single.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    expect(Number(next.rows[0]!.pid)).not.toBe(killedPid);
  });
});

describe("strict mode", () => {
  it("rejects all three paths with TenantScopeMissingError and takes no connection", async () => {
    const strict = newPool();
    await strict.query("SELECT 1"); // opens one idle connection (warn mode: no env set yet)
    process.env.SEMPREC_TENANT_SCOPE = "strict";
    const total = strict.totalCount;

    await expect(withTransaction(strict, async () => 1)).rejects.toBeInstanceOf(TenantScopeMissingError);
    await expect(strict.query("SELECT 1")).rejects.toBeInstanceOf(TenantScopeMissingError);
    await expect(strict.connect()).rejects.toBeInstanceOf(TenantScopeMissingError);
    await expect(
      new Promise((resolve, reject) => {
        strict.connect((err) => (err ? reject(err) : resolve(undefined)));
      }),
    ).rejects.toBeInstanceOf(TenantScopeMissingError);

    expect(strict.totalCount).toBe(total);
    expect(strict.idleCount).toBe(total);
    expect(strict.waitingCount).toBe(0);
  });
});

describe("connection scope", () => {
  it("delivers LISTEN notifications of a connection opened inside a tenant in a system scope", async () => {
    const fresh = newPool();
    const channel = `scope_${randomUUID().replaceAll("-", "")}`;
    const client = await runInTenant(T, () => fresh.connect());
    try {
      const seen = new Promise<TenantScope | undefined>((resolve) => {
        client.on("notification", () => resolve(currentTenantScope()));
      });
      await client.query(`LISTEN ${channel}`);
      await pool.query(`SELECT pg_notify('${channel}', 'x')`);
      expect(await seen).toMatchObject({ kind: "system" });
    } finally {
      client.release();
    }
  });
});

describe("runAfterCommit", () => {
  it("fires after COMMIT inside a scoped withTransaction and sees the caller's scope", async () => {
    let fired: TenantScope | undefined;
    let committedAtFire: string | undefined;
    await runInTenant(T, () =>
      withTransaction(pool, async (client) => {
        runAfterCommit(client, () => {
          fired = currentTenantScope();
          committedAtFire = "fired";
        });
        expect(committedAtFire).toBeUndefined();
      }),
    );
    expect(committedAtFire).toBe("fired");
    expect(fired).toEqual({ kind: "tenant", tenantId: T });
  });
});
