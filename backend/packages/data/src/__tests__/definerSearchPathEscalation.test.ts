import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../testSupport/testDb.js";
import { createDatabase } from "../chokePoint/databasesStore.js";

/**
 * A `SECURITY DEFINER` function whose `search_path` does not name `pg_temp` resolves unqualified
 * relation and type names in the caller's temporary schema first. These cases replay that exploit as
 * `semprec_data` (logged in with its own password, so `session_user` is the runtime role): the session
 * creates a `pg_temp.text`/`pg_temp.uuid` domain whose check calls `pg_temp.pwn`, then calls a
 * partition function. `pwn` raises `escalated as <current_user>` when it runs as anyone but
 * `semprec_data`, so running as the owner is visible without escalating anything.
 *
 * Every attack runs in a rolled-back transaction. Every interpolated identifier is an element of the
 * closed unions below; the database id is bound as a parameter.
 */
type Target = "create_items_partition" | "drop_items_partition";
type ShadowedType = "text" | "uuid";

const TARGETS: Target[] = ["create_items_partition", "drop_items_partition"];
const SHADOWED_TYPES: ShadowedType[] = ["text", "uuid"];

const PWN_FUNCTION = `
  CREATE FUNCTION pg_temp.pwn(pg_catalog.text) RETURNS boolean LANGUAGE plpgsql AS $body$
  BEGIN
    IF current_user <> 'semprec_data' THEN
      RAISE EXCEPTION 'escalated as %', current_user;
    END IF;
    RETURN true;
  END
  $body$`;

const SHADOW_DOMAINS: Record<ShadowedType, string> = {
  text: "CREATE DOMAIN pg_temp.text AS pg_catalog.text CHECK (pg_temp.pwn(value))",
  uuid: "CREATE DOMAIN pg_temp.uuid AS pg_catalog.uuid CHECK (pg_temp.pwn(value::pg_catalog.text))",
};

const PINNED = "search_path=pg_catalog, public, pg_temp";

let adminPool: Pool;
let dataPool: Pool;
let tenantId: string;
let databaseId: string;

type AttackOutcome = { partitionExists: boolean; sessionIsSuperuser: boolean };

/**
 * Creates the shadowing domain in a `semprec_data` session and calls `target` on the tenant's own
 * database, in a rolled-back transaction. `create_items_partition` needs a database without a partition,
 * so `drop_items_partition` runs first in that case.
 */
async function attack(target: Target, shadowed: ShadowedType): Promise<AttackOutcome> {
  const client = await dataPool.connect();
  let connectionBroken = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    expect((await client.query<{ session_user: string }>("SELECT session_user")).rows).toEqual([
      { session_user: "semprec_data" },
    ]);
    if (target === "create_items_partition") {
      await client.query("SELECT drop_items_partition($1::uuid)", [databaseId]);
    }
    await client.query(PWN_FUNCTION);
    await client.query(SHADOW_DOMAINS[shadowed]);
    await client.query(`SELECT ${target}($1::uuid)`, [databaseId]);
    const state = await client.query<{ partition_exists: boolean; is_superuser: boolean }>(
      `SELECT to_regclass('public.items_p_' || replace($1::text, '-', '')) IS NOT NULL AS partition_exists,
              (SELECT rolsuper FROM pg_roles WHERE rolname = 'semprec_data') AS is_superuser`,
      [databaseId],
    );
    const row = state.rows[0];
    if (!row) throw new Error("attack: the state query returned no row");
    return { partitionExists: row.partition_exists, sessionIsSuperuser: row.is_superuser };
  } finally {
    // A failed ROLLBACK must not replace the error of the attack: destroy the connection instead.
    try {
      await client.query("ROLLBACK");
    } catch {
      connectionBroken = true;
    }
    client.release(connectionBroken);
  }
}

async function runtimeRoleIsSuperuser(): Promise<boolean> {
  const { rows } = await adminPool.query<{ rolsuper: boolean }>(
    "SELECT rolsuper FROM pg_roles WHERE rolname = 'semprec_data'",
  );
  return rows[0]?.rolsuper === true;
}

async function proconfigOf(target: Target): Promise<string[] | null> {
  const { rows } = await adminPool.query<{ proconfig: string[] | null }>(
    "SELECT proconfig FROM pg_proc WHERE oid = ($1 || '(uuid)')::regprocedure",
    [target],
  );
  return rows[0]?.proconfig ?? null;
}

describe("SECURITY DEFINER partition functions against a temporary-schema type (R2-DB-1)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  afterAll(async () => {
    await dataPool?.end();
    await adminPool?.end();
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    tenantId = await createTestTenant(adminPool);
    const database = await withTenantTransaction(dataPool, tenantId, (client) =>
      createDatabase(client, { name: "definer search path" }),
    );
    databaseId = database.id;
  });

  it.each(TARGETS.flatMap((target) => SHADOWED_TYPES.map((shadowed) => ({ target, shadowed }))))(
    "$target never runs the check of a pg_temp.$shadowed domain as another role",
    async ({ target, shadowed }) => {
      expect(await attack(target, shadowed)).toEqual({
        partitionExists: target === "create_items_partition",
        sessionIsSuperuser: false,
      });
      expect(await runtimeRoleIsSuperuser()).toBe(false);
    },
  );

  it.each(TARGETS)("keeps %s pinned to search_path ending with pg_temp", async (target) => {
    expect(await proconfigOf(target)).toEqual([PINNED]);
  });

  describe("control: the search_path of finding R2-DB-1 restored", () => {
    it.each(TARGETS)(
      "%s runs the check as its owner, so the cases above fail on the unfixed function",
      async (target) => {
        const { rows } = await adminPool.query<{ owner: string }>(
          "SELECT pg_get_userbyid(proowner)::text AS owner FROM pg_proc WHERE oid = ($1 || '(uuid)')::regprocedure",
          [target],
        );
        const owner = rows[0]?.owner;
        expect(owner).toBeTruthy();
        expect(owner).not.toBe("semprec_data");

        // `target` is an element of the closed union above; ALTER FUNCTION takes no bind parameters.
        await adminPool.query(`ALTER FUNCTION ${target}(uuid) SET search_path = pg_catalog, public`);
        try {
          await expect(attack(target, "text")).rejects.toThrow(`escalated as ${owner}`);
        } finally {
          await adminPool.query(`ALTER FUNCTION ${target}(uuid) SET search_path = pg_catalog, public, pg_temp`);
        }
        expect(await proconfigOf(target)).toEqual([PINNED]);
        expect(await runtimeRoleIsSuperuser()).toBe(false);
      },
    );
  });
});
