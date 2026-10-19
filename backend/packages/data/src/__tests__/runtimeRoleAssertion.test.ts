import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRuntimeRole, RuntimeRoleAssertionError } from "../db/runtimeRoleAssertion.js";
import { createRuntimeRolePool, getTestPool } from "../testSupport/testDb.js";

// Role and table names are generated here from hex only, so they are never user input.
function generatedName(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

function connectionStringAs(role: string, password: string): string {
  const baseUrl = process.env.TEST_DATABASE_URL;
  if (!baseUrl) throw new Error("TEST_DATABASE_URL is not set");
  const url = new URL(baseUrl);
  url.username = role;
  url.password = password;
  return url.toString();
}

describe("assertRuntimeRole", () => {
  let adminPool: Pool;
  const createdRoles: string[] = [];
  const createdTables: string[] = [];
  const openedPools: Pool[] = [];

  beforeAll(() => {
    adminPool = getTestPool();
  });

  afterEach(async () => {
    // Pools must close before their roles can be dropped: a role with a live session cannot be dropped.
    await Promise.all(openedPools.splice(0).map((pool) => pool.end()));
  });

  afterAll(async () => {
    for (const table of createdTables.splice(0)) {
      await adminPool.query(`DROP TABLE IF EXISTS public.${table}`);
    }
    for (const role of createdRoles.splice(0)) {
      await adminPool.query(`DROP ROLE IF EXISTS ${role}`);
    }
    await adminPool.end();
  });

  // Creates a role with the given attributes and returns its name. The password is a UUID, so it
  // is safe inside the statement (ALTER ROLE accepts no bind parameters).
  async function createRole(attributes: string): Promise<{ name: string; password: string }> {
    const name = generatedName("rra");
    const password = randomUUID();
    await adminPool.query(`CREATE ROLE ${name} ${attributes}`);
    await adminPool.query(`ALTER ROLE ${name} WITH PASSWORD '${password}'`);
    createdRoles.push(name);
    return { name, password };
  }

  function poolAs(role: { name: string; password: string }): Pool {
    const pool = new Pool({ connectionString: connectionStringAs(role.name, role.password) });
    openedPools.push(pool);
    return pool;
  }

  it("refuses the superuser pool and names the role without the connection string or password", async () => {
    const error = await assertRuntimeRole(adminPool).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(RuntimeRoleAssertionError);
    if (!(error instanceof RuntimeRoleAssertionError)) throw new Error("unreachable: asserted above");
    expect(error.violations).toContain("superuser");
    expect(error.message).toContain(`"${error.role}"`);
    const connectionString = process.env.TEST_DATABASE_URL ?? "";
    expect(error.message).not.toContain(connectionString);
    // The superuser of the test database has a password equal to its role name, so the password check
    // only means something when the two differ.
    const password = new URL(connectionString).password;
    if (password && password !== error.role) expect(error.message).not.toContain(password);
  });

  it("resolves for a pool logged in as semprec_data", async () => {
    const pool = await createRuntimeRolePool(adminPool, "semprec_data");
    openedPools.push(pool);

    await expect(assertRuntimeRole(pool)).resolves.toBeUndefined();
  });

  it("resolves for a pool logged in as semprec_side", async () => {
    const pool = await createRuntimeRolePool(adminPool, "semprec_side");
    openedPools.push(pool);

    await expect(assertRuntimeRole(pool)).resolves.toBeUndefined();
  });

  it("reports exactly bypassrls for a login role with BYPASSRLS", async () => {
    const role = await createRole("LOGIN NOSUPERUSER BYPASSRLS");
    const pool = poolAs(role);

    const error = await assertRuntimeRole(pool).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(RuntimeRoleAssertionError);
    if (!(error instanceof RuntimeRoleAssertionError)) throw new Error("unreachable: asserted above");
    expect(error.violations).toEqual(["bypassrls"]);
    expect(error.role).toBe(role.name);
  });

  it("reports exactly memberOfPrivilegedRole for a login role that is a member of a BYPASSRLS role", async () => {
    const privileged = await createRole("NOLOGIN NOSUPERUSER BYPASSRLS");
    const member = await createRole("LOGIN NOSUPERUSER NOBYPASSRLS");
    await adminPool.query(`GRANT ${privileged.name} TO ${member.name}`);
    const pool = poolAs(member);

    const error = await assertRuntimeRole(pool).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(RuntimeRoleAssertionError);
    if (!(error instanceof RuntimeRoleAssertionError)) throw new Error("unreachable: asserted above");
    expect(error.violations).toEqual(["memberOfPrivilegedRole"]);
  });

  it("reports exactly ownsPublicRelation for a login role that owns a table in public", async () => {
    const owner = await createRole("LOGIN NOSUPERUSER NOBYPASSRLS");
    const table = generatedName("rra_owned");
    createdTables.push(table);
    await adminPool.query(`CREATE TABLE public.${table} (id integer)`);
    await adminPool.query(`ALTER TABLE public.${table} OWNER TO ${owner.name}`);
    const pool = poolAs(owner);

    const error = await assertRuntimeRole(pool).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(RuntimeRoleAssertionError);
    if (!(error instanceof RuntimeRoleAssertionError)) throw new Error("unreachable: asserted above");
    expect(error.violations).toEqual(["ownsPublicRelation"]);
  });

  it("reports exactly ownsPublicRelation for a login role that is only a member of the table owner", async () => {
    const owner = await createRole("NOLOGIN NOSUPERUSER NOBYPASSRLS");
    const member = await createRole("LOGIN NOSUPERUSER NOBYPASSRLS");
    const table = generatedName("rra_inherited");
    createdTables.push(table);
    await adminPool.query(`CREATE TABLE public.${table} (id integer)`);
    await adminPool.query(`ALTER TABLE public.${table} OWNER TO ${owner.name}`);
    await adminPool.query(`GRANT ${owner.name} TO ${member.name}`);
    const pool = poolAs(member);

    const error = await assertRuntimeRole(pool).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(RuntimeRoleAssertionError);
    if (!(error instanceof RuntimeRoleAssertionError)) throw new Error("unreachable: asserted above");
    expect(error.violations).toEqual(["ownsPublicRelation"]);
  });

  it("throws a plain Error when the catalog query returns no row", async () => {
    // current_user always has a row, so the no-row branch is reached only through a stub pool whose
    // query returns none. The stub implements only the one method the assertion calls.
    const stubPool = { query: () => Promise.resolve({ rows: [] }) } as unknown as Pool;

    const error = await assertRuntimeRole(stubPool).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RuntimeRoleAssertionError);
    expect((error as Error).message).toBe("Runtime role assertion query returned no row for current_user");
  });

  describe("tenant scope", () => {
    const originalMode = process.env.SEMPREC_TENANT_SCOPE;

    afterEach(() => {
      if (originalMode === undefined) delete process.env.SEMPREC_TENANT_SCOPE;
      else process.env.SEMPREC_TENANT_SCOPE = originalMode;
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });

    it("resolves under strict scope with no surrounding scope", async () => {
      const pool = await createRuntimeRolePool(adminPool, "semprec_data");
      openedPools.push(pool);
      process.env.SEMPREC_TENANT_SCOPE = "strict";

      await expect(assertRuntimeRole(pool)).resolves.toBeUndefined();
    });

    it("logs no tenant_scope_missing under warn scope", async () => {
      // This stdout-observing fixture needs warn output despite the tier's error default (#1199).
      // Reload both consumers so they share a fresh tenant-scope logger that reads this override.
      vi.stubEnv("LOG_LEVEL", "warn");
      vi.resetModules();
      const freshTestDb = await import("../testSupport/testDb.js");
      const freshAssertion = await import("../db/runtimeRoleAssertion.js");
      const pool = await freshTestDb.createRuntimeRolePool(adminPool, "semprec_data");
      openedPools.push(pool);
      process.env.SEMPREC_TENANT_SCOPE = "warn";
      // pino writes records to fd 1 with the asynchronous fs.write, so that call is the capture point.
      const writes: string[] = [];
      const realWrite = fs.write.bind(fs);
      vi.spyOn(fs, "write").mockImplementation((fd: number, ...rest: unknown[]) => {
        writes.push(String(rest[0]));
        return (realWrite as (...args: unknown[]) => unknown)(fd, ...rest);
      });
      // sonic-boom flushes asynchronously; give it a tick before reading the capture.
      const flush = () => new Promise((resolve) => setTimeout(resolve, 50));

      // Positive control: an unscoped query through a createPool pool under warn logs
      // tenant_scope_missing, so the capture would see it if the assertion had emitted it. getTestPool
      // is a plain pg Pool with no scope hook, so it cannot serve as the control.
      await pool.query("SELECT 1");
      await flush();
      expect(writes.join("")).toContain("tenant_scope_missing");
      writes.length = 0;

      await freshAssertion.assertRuntimeRole(pool);
      await flush();
      expect(writes.join("")).not.toContain("tenant_scope_missing");
    });
  });
});
