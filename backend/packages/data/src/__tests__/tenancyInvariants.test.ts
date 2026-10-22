import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { findTenancyViolations, verifyTenancy, type TenancyViolation } from "../db/tenancyInvariants.js";

/**
 * Issue #1085: the deploy-time tenancy verification. Each break runs inside a transaction that is
 * rolled back, so the catalog is unchanged for the next test. Every SQL identifier interpolated
 * below is a fixed name or a random hex probe name generated here, never input; DDL takes no bind
 * parameters.
 */
let pool: Pool;
let partitionName: string;

function probeName(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString("hex")}`;
}

/** Runs `statements` in a transaction, returns the violations seen inside it, and rolls it back. */
async function violationsAfter(statements: string[]): Promise<TenancyViolation[]> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      for (const statement of statements) {
        await client.query(statement);
      }
      return await findTenancyViolations(client);
    } finally {
      await client.query("ROLLBACK");
    }
  } finally {
    client.release();
  }
}

function only(violations: TenancyViolation[], invariant: string): TenancyViolation[] {
  return violations.filter((violation) => violation.invariant === invariant);
}

describe("findTenancyViolations", () => {
  beforeAll(async () => {
    pool = getTestPool();
    await resetDatabase(pool);
    const db = await createChokePoint(pool).createDatabase({ name: "Tenancy invariants partition" });
    partitionName = `items_p_${db.id.replaceAll("-", "")}`;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("finds no violation on the migrated database", async () => {
    const { rows } = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM pg_class WHERE relname = $1 AND relispartition",
      [partitionName],
    );
    expect(rows).toEqual([{ count: 1 }]);
    expect(await findTenancyViolations(pool)).toEqual([]);
  });

  describe("names exactly the broken invariant and object", () => {
    it("classification: a table without a tenancy comment", async () => {
      const table = probeName("tenancy_invariants_probe");
      expect(await violationsAfter([`CREATE TABLE ${table} (id int)`])).toEqual([
        { invariant: "classification", object: table, detail: "has no semprec:tenancy=tenant|global comment" },
      ]);
    });

    it("tenantColumn: a tenant table's tenant_id default dropped", async () => {
      expect(await violationsAfter(["ALTER TABLE views ALTER COLUMN tenant_id DROP DEFAULT"])).toEqual([
        { invariant: "tenantColumn", object: "views", detail: "tenant_id does not default to app_tenant_default()" },
      ]);
    });

    it("rowLevelSecurity: a tenant table's tenant_rows policy dropped", async () => {
      expect(await violationsAfter(["DROP POLICY tenant_rows ON views"])).toEqual([
        { invariant: "rowLevelSecurity", object: "views", detail: "has no permissive tenant_rows policy" },
      ]);
    });

    it("strictDefault: app_tenant_default() redefined with the transitional body", async () => {
      expect(
        await violationsAfter([
          `CREATE OR REPLACE FUNCTION app_tenant_default() RETURNS uuid LANGUAGE sql STABLE AS
             $$ SELECT COALESCE(public.app_current_tenant(), public.app_sole_tenant()) $$`,
        ]),
      ).toEqual([{ invariant: "strictDefault", object: "app_tenant_default()", detail: "references app_sole_tenant" }]);
    });

    it("runtimeRole: semprec_data given BYPASSRLS", async () => {
      expect(await violationsAfter(["ALTER ROLE semprec_data BYPASSRLS"])).toEqual([
        { invariant: "runtimeRole", object: "semprec_data", detail: "has BYPASSRLS" },
      ]);
    });

    it("partitionPrivilege: SELECT on an items partition granted to semprec_data", async () => {
      expect(await violationsAfter([`GRANT SELECT ON ${partitionName} TO semprec_data`])).toEqual([
        {
          invariant: "partitionPrivilege",
          object: partitionName,
          detail: "semprec_data holds a table privilege on the partition",
        },
      ]);
    });

    it("definerFunction: a SECURITY DEFINER function without SET search_path", async () => {
      const fn = probeName("tenancy_invariants_definer");
      expect(
        await violationsAfter([
          `CREATE FUNCTION ${fn}() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'`,
          `REVOKE EXECUTE ON FUNCTION ${fn}() FROM PUBLIC`,
        ]),
      ).toEqual([{ invariant: "definerFunction", object: `${fn}()`, detail: "has no pinned search_path" }]);
    });

    it("foreignKey: a composite tenant foreign key re-added NOT VALID", async () => {
      expect(
        await violationsAfter([
          "ALTER TABLE views DROP CONSTRAINT views_database_id_tenant_fkey",
          `ALTER TABLE views ADD CONSTRAINT views_database_id_tenant_fkey FOREIGN KEY (tenant_id, database_id)
             REFERENCES databases (tenant_id, id) ON DELETE CASCADE NOT VALID`,
        ]),
      ).toEqual([
        {
          invariant: "foreignKey",
          object: "views.views_database_id_tenant_fkey",
          detail: "foreign key over tenant_id is not validated",
        },
      ]);
    });
  });

  describe("reports every other way an invariant breaks", () => {
    it("classification: a comment that is not exactly a classification", async () => {
      const table = probeName("tenancy_invariants_probe");
      expect(
        await violationsAfter([
          `CREATE TABLE ${table} (id int)`,
          `COMMENT ON TABLE ${table} IS 'semprec:tenancy=tenant '`,
        ]),
      ).toEqual([
        {
          invariant: "classification",
          object: table,
          detail: "its comment is not exactly semprec:tenancy=tenant or semprec:tenancy=global",
        },
      ]);
    });

    it("tenantColumn: a missing tenant_id, a non-uuid tenant_id, and a nullable tenant_id", async () => {
      const missing = probeName("tenancy_invariants_missing");
      const textual = probeName("tenancy_invariants_text");
      const violations = await violationsAfter([
        `CREATE TABLE ${missing} (id int)`,
        `COMMENT ON TABLE ${missing} IS 'semprec:tenancy=tenant'`,
        `CREATE TABLE ${textual} (tenant_id text NOT NULL DEFAULT app_tenant_default())`,
        `COMMENT ON TABLE ${textual} IS 'semprec:tenancy=tenant'`,
        "ALTER TABLE views ALTER COLUMN tenant_id DROP NOT NULL",
      ]);
      expect(only(violations, "tenantColumn")).toEqual(
        expect.arrayContaining([
          { invariant: "tenantColumn", object: missing, detail: "has no tenant_id column" },
          { invariant: "tenantColumn", object: textual, detail: "tenant_id is not uuid" },
          { invariant: "tenantColumn", object: "views", detail: "tenant_id is nullable" },
        ]),
      );
      expect(only(violations, "tenantColumn")).toHaveLength(3);
    });

    it("rowLevelSecurity: RLS disabled and the tenant_isolation policy dropped", async () => {
      const violations = await violationsAfter([
        "ALTER TABLE views DISABLE ROW LEVEL SECURITY",
        "DROP POLICY tenant_isolation ON views",
      ]);
      expect(violations).toEqual([
        {
          invariant: "rowLevelSecurity",
          object: "views",
          detail: "row-level security is disabled; has no restrictive tenant_isolation policy for all commands",
        },
      ]);
    });

    it("rowLevelSecurity: a permissive tenant_isolation policy does not count", async () => {
      const violations = await violationsAfter([
        "DROP POLICY tenant_isolation ON views",
        "CREATE POLICY tenant_isolation ON views AS PERMISSIVE FOR ALL USING (tenant_id = app_tenant_default())",
      ]);
      expect(violations).toEqual([
        {
          invariant: "rowLevelSecurity",
          object: "views",
          detail: "has no restrictive tenant_isolation policy for all commands",
        },
      ]);
    });

    it("strictDefault: app_tenant_default() missing", async () => {
      const violations = await violationsAfter(["DROP FUNCTION app_tenant_default() CASCADE"]);
      expect(only(violations, "strictDefault")).toEqual([
        { invariant: "strictDefault", object: "app_tenant_default()", detail: "is not defined" },
      ]);
    });

    it("runtimeRole: a missing runtime role", async () => {
      const renamed = probeName("tenancy_invariants_side");
      expect(await violationsAfter([`ALTER ROLE semprec_side RENAME TO ${renamed}`])).toEqual([
        { invariant: "runtimeRole", object: "semprec_side", detail: "does not exist" },
      ]);
    });

    it("runtimeRole: a superuser runtime role", async () => {
      // A superuser is a member of every role, so the membership and partition checks fire as well.
      const violations = await violationsAfter(["ALTER ROLE semprec_side SUPERUSER"]);
      const side = only(violations, "runtimeRole").find((violation) => violation.object === "semprec_side");
      expect(side?.detail.split("; ")[0]).toBe("is a superuser");
    });

    it("runtimeRole: membership in a BYPASSRLS role", async () => {
      const role = probeName("tenancy_invariants_bypass");
      expect(await violationsAfter([`CREATE ROLE ${role} NOLOGIN BYPASSRLS`, `GRANT ${role} TO semprec_data`])).toEqual(
        [
          {
            invariant: "runtimeRole",
            object: "semprec_data",
            detail: `is a member of superuser or BYPASSRLS role(s) ${role}`,
          },
        ],
      );
    });

    it("runtimeRole: membership in the owner of a relation in public, and owning one directly", async () => {
      const owner = probeName("tenancy_invariants_owner");
      const table = probeName("tenancy_invariants_owned");
      const ownedBySide = probeName("tenancy_invariants_side_owned");
      expect(
        await violationsAfter([
          `CREATE ROLE ${owner} NOLOGIN`,
          `CREATE TABLE ${table} (id int)`,
          `COMMENT ON TABLE ${table} IS 'semprec:tenancy=global'`,
          `ALTER TABLE ${table} OWNER TO ${owner}`,
          `GRANT ${owner} TO semprec_data`,
          `CREATE TABLE ${ownedBySide} (id int)`,
          `COMMENT ON TABLE ${ownedBySide} IS 'semprec:tenancy=global'`,
          `ALTER TABLE ${ownedBySide} OWNER TO semprec_side`,
        ]),
      ).toEqual([
        // semprec_data inherits semprec_side (0040_least_privilege_roles.sql), so it is flagged for both owners.
        {
          invariant: "runtimeRole",
          object: "semprec_data",
          detail: `is or is a member of ${[owner, "semprec_side"].sort().join(", ")}, owning relations in public`,
        },
        {
          invariant: "runtimeRole",
          object: "semprec_side",
          detail: "is or is a member of semprec_side, owning relations in public",
        },
      ]);
    });

    it("definerFunction: executable by PUBLIC through the default ACL and through an explicit grant", async () => {
      const byDefault = probeName("tenancy_invariants_default_acl");
      const granted = probeName("tenancy_invariants_granted");
      const violations = await violationsAfter([
        `CREATE FUNCTION ${byDefault}() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS 'SELECT 1'`,
        `CREATE FUNCTION ${granted}() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS 'SELECT 1'`,
        `REVOKE EXECUTE ON FUNCTION ${granted}() FROM PUBLIC`,
        `GRANT EXECUTE ON FUNCTION ${granted}() TO PUBLIC`,
      ]);
      expect(violations).toEqual(
        [
          { invariant: "definerFunction", object: `${byDefault}()`, detail: "is executable by PUBLIC" },
          { invariant: "definerFunction", object: `${granted}()`, detail: "is executable by PUBLIC" },
        ].sort((a, b) => a.object.localeCompare(b.object)),
      );
    });

    it("definerFunction: an owner that is neither semprec_router nor the owner of items", async () => {
      const owner = probeName("tenancy_invariants_fn_owner");
      const fn = probeName("tenancy_invariants_owned_fn");
      expect(
        await violationsAfter([
          `CREATE ROLE ${owner} NOLOGIN`,
          `CREATE FUNCTION ${fn}() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS 'SELECT 1'`,
          `REVOKE EXECUTE ON FUNCTION ${fn}() FROM PUBLIC`,
          `ALTER FUNCTION ${fn}() OWNER TO ${owner}`,
        ]),
      ).toEqual([
        {
          invariant: "definerFunction",
          object: `${fn}()`,
          detail: "is owned by neither semprec_router nor the owner of items",
        },
      ]);
    });

    it("definerFunction: accepts a pinned, revoked function owned by semprec_router", async () => {
      const fn = probeName("tenancy_invariants_router_fn");
      expect(
        await violationsAfter([
          `CREATE FUNCTION ${fn}() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS 'SELECT 1'`,
          `REVOKE EXECUTE ON FUNCTION ${fn}() FROM PUBLIC`,
          `ALTER FUNCTION ${fn}() OWNER TO semprec_router`,
        ]),
      ).toEqual([]);
    });
  });
});

describe("verifyTenancy", () => {
  let verifyPool: Pool;

  beforeAll(() => {
    verifyPool = getTestPool();
  });

  afterAll(async () => {
    await verifyPool?.end();
  });

  function recordingOutput(): {
    info: string[];
    error: string[];
    sink: { info(l: string): void; error(l: string): void };
  } {
    const info: string[] = [];
    const error: string[] = [];
    return { info, error, sink: { info: (line) => info.push(line), error: (line) => error.push(line) } };
  }

  it("returns 0 and writes only tenancy: verified when every invariant holds", async () => {
    const output = recordingOutput();
    expect(await verifyTenancy(verifyPool, output.sink)).toBe(0);
    expect(output.info).toEqual(["tenancy: verified"]);
    expect(output.error).toEqual([]);
  });

  it("returns 1 and writes one error line per violation", async () => {
    // verifyTenancy reads through its own pool connections, so the break must be committed; the
    // probe tables are dropped again below, and integration files run one at a time.
    const first = probeName("tenancy_invariants_verify_a");
    const second = probeName("tenancy_invariants_verify_b");
    const [a, b] = [first, second].sort();
    await verifyPool.query(`CREATE TABLE ${first} (id int)`);
    try {
      await verifyPool.query(`CREATE TABLE ${second} (id int)`);
      const output = recordingOutput();
      expect(await verifyTenancy(verifyPool, output.sink)).toBe(1);
      expect(output.error).toEqual([
        `tenancy violation [classification] ${a}: has no semprec:tenancy=tenant|global comment`,
        `tenancy violation [classification] ${b}: has no semprec:tenancy=tenant|global comment`,
      ]);
      expect(output.info).toEqual([]);
    } finally {
      await verifyPool.query(`DROP TABLE IF EXISTS ${first}, ${second}`);
    }
  });
});
