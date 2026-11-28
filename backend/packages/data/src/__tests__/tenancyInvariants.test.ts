import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { findTenancyViolations, verifyTenancy, type TenancyViolation } from "../db/tenancyInvariants.js";

/**
 * The deploy-time tenancy verification. Each break runs in a rolled-back transaction. Interpolated identifiers
 * are fixed names or random hex probe names; DDL takes no bind parameters.
 */
let pool: Pool;

function probeName(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString("hex")}`;
}

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
    await createChokePoint(pool).createDatabase({ name: "Tenancy invariants database" });
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("finds no violation on the migrated database", async () => {
    expect(await findTenancyViolations(pool)).toEqual([]);
  });

  describe("names exactly the broken invariant and object", () => {
    it("classification: a table without a tenancy comment", async () => {
      const table = probeName("tenancy_invariants_probe");
      expect(await violationsAfter([`CREATE TABLE ${table} (id int)`])).toEqual([
        { invariant: "classification", object: table, detail: "has no alldots:tenancy=tenant|global comment" },
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

    it("runtimeRole: alldots_data given BYPASSRLS", async () => {
      expect(await violationsAfter(["ALTER ROLE alldots_data BYPASSRLS"])).toEqual([
        { invariant: "runtimeRole", object: "alldots_data", detail: "has BYPASSRLS" },
      ]);
    });

    it("itemForeignKey: a foreign key to items on the bare item id", async () => {
      const table = probeName("tenancy_invariants_item_ref");
      expect(
        await violationsAfter([
          `CREATE TABLE ${table} (item_id uuid REFERENCES items (id))`,
          `COMMENT ON TABLE ${table} IS 'alldots:tenancy=global'`,
        ]),
      ).toEqual([
        {
          invariant: "itemForeignKey",
          object: `${table}.${table}_item_id_fkey`,
          detail: "foreign key to items is not over (tenant_id, id)",
        },
      ]);
    });

    it("itemForeignKey: a foreign key to items that does not lead with tenant_id", async () => {
      const table = probeName("tenancy_invariants_item_ref");
      expect(
        only(
          await violationsAfter([
            `CREATE TABLE ${table} (item_id uuid, tenant_id uuid, FOREIGN KEY (item_id, tenant_id) REFERENCES items (id, tenant_id))`,
            `CREATE UNIQUE INDEX ${table}_probe_uq ON items (id, tenant_id)`,
            `COMMENT ON TABLE ${table} IS 'alldots:tenancy=global'`,
          ]),
          "itemForeignKey",
        ),
      ).toEqual([
        {
          invariant: "itemForeignKey",
          object: `${table}.${table}_item_id_tenant_id_fkey`,
          detail: "foreign key to items is not over (tenant_id, id)",
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
          `COMMENT ON TABLE ${table} IS 'alldots:tenancy=tenant '`,
        ]),
      ).toEqual([
        {
          invariant: "classification",
          object: table,
          detail: "its comment is not exactly alldots:tenancy=tenant or alldots:tenancy=global",
        },
      ]);
    });

    it("tenantColumn: a missing tenant_id, a non-uuid tenant_id, and a nullable tenant_id", async () => {
      const missing = probeName("tenancy_invariants_missing");
      const textual = probeName("tenancy_invariants_text");
      const violations = await violationsAfter([
        `CREATE TABLE ${missing} (id int)`,
        `COMMENT ON TABLE ${missing} IS 'alldots:tenancy=tenant'`,
        `CREATE TABLE ${textual} (tenant_id text NOT NULL DEFAULT app_tenant_default())`,
        `COMMENT ON TABLE ${textual} IS 'alldots:tenancy=tenant'`,
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
      expect(await violationsAfter([`ALTER ROLE alldots_side RENAME TO ${renamed}`])).toEqual([
        { invariant: "runtimeRole", object: "alldots_side", detail: "does not exist" },
      ]);
    });

    it("runtimeRole: a superuser runtime role", async () => {
      // A superuser is a member of every role, so the membership checks fire as well.
      const violations = await violationsAfter(["ALTER ROLE alldots_side SUPERUSER"]);
      const side = only(violations, "runtimeRole").find((violation) => violation.object === "alldots_side");
      expect(side?.detail.split("; ")[0]).toBe("is a superuser");
    });

    it("runtimeRole: membership in a BYPASSRLS role", async () => {
      const role = probeName("tenancy_invariants_bypass");
      expect(await violationsAfter([`CREATE ROLE ${role} NOLOGIN BYPASSRLS`, `GRANT ${role} TO alldots_data`])).toEqual(
        [
          {
            invariant: "runtimeRole",
            object: "alldots_data",
            detail: `is a member of superuser or BYPASSRLS role(s) ${role}`,
          },
        ],
      );
    });

    it("runtimeRole: membership in a superuser role that lacks BYPASSRLS", async () => {
      const role = probeName("tenancy_invariants_super");
      expect(
        await violationsAfter([`CREATE ROLE ${role} NOLOGIN SUPERUSER NOBYPASSRLS`, `GRANT ${role} TO alldots_data`]),
      ).toEqual([
        {
          invariant: "runtimeRole",
          object: "alldots_data",
          detail: `is a member of superuser or BYPASSRLS role(s) ${role}`,
        },
      ]);
    });

    it("runtimeRole: membership in the owner of a relation in public, and owning one directly", async () => {
      const owner = probeName("tenancy_invariants_owner");
      const table = probeName("tenancy_invariants_owned");
      const ownedBySide = probeName("tenancy_invariants_side_owned");
      expect(
        await violationsAfter([
          `CREATE ROLE ${owner} NOLOGIN`,
          `CREATE TABLE ${table} (id int)`,
          `COMMENT ON TABLE ${table} IS 'alldots:tenancy=global'`,
          `ALTER TABLE ${table} OWNER TO ${owner}`,
          `GRANT ${owner} TO alldots_data`,
          `CREATE TABLE ${ownedBySide} (id int)`,
          `COMMENT ON TABLE ${ownedBySide} IS 'alldots:tenancy=global'`,
          `ALTER TABLE ${ownedBySide} OWNER TO alldots_side`,
        ]),
      ).toEqual([
        // alldots_data inherits alldots_side (granted by the schema), so it is flagged for both owners.
        {
          invariant: "runtimeRole",
          object: "alldots_data",
          detail: `is or is a member of ${[owner, "alldots_side"].sort().join(", ")}, owning relations in public`,
        },
        {
          invariant: "runtimeRole",
          object: "alldots_side",
          detail: "is or is a member of alldots_side, owning relations in public",
        },
      ]);
    });

    it("definerFunction: executable by PUBLIC through the default ACL and through an explicit grant", async () => {
      const byDefault = probeName("tenancy_invariants_default_acl");
      const granted = probeName("tenancy_invariants_granted");
      const violations = await violationsAfter([
        `CREATE FUNCTION ${byDefault}() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS 'SELECT 1'`,
        `CREATE FUNCTION ${granted}() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS 'SELECT 1'`,
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

    it("definerFunction: an owner that is neither alldots_router nor the owner of items", async () => {
      const owner = probeName("tenancy_invariants_fn_owner");
      const fn = probeName("tenancy_invariants_owned_fn");
      expect(
        await violationsAfter([
          `CREATE ROLE ${owner} NOLOGIN`,
          `CREATE FUNCTION ${fn}() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS 'SELECT 1'`,
          `REVOKE EXECUTE ON FUNCTION ${fn}() FROM PUBLIC`,
          `ALTER FUNCTION ${fn}() OWNER TO ${owner}`,
        ]),
      ).toEqual([
        {
          invariant: "definerFunction",
          object: `${fn}()`,
          detail: "is owned by neither alldots_router nor the owner of items",
        },
      ]);
    });

    it("definerFunction: accepts a pinned, revoked function owned by alldots_router", async () => {
      const fn = probeName("tenancy_invariants_router_fn");
      expect(
        await violationsAfter([
          `CREATE FUNCTION ${fn}() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS 'SELECT 1'`,
          `REVOKE EXECUTE ON FUNCTION ${fn}() FROM PUBLIC`,
          `ALTER FUNCTION ${fn}() OWNER TO alldots_router`,
        ]),
      ).toEqual([]);
    });

    describe("definerFunction: the shape of the search_path", () => {
      function definerFunction(name: string, searchPath: string): string[] {
        return [
          `CREATE FUNCTION ${name}() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = ${searchPath} AS 'SELECT 1'`,
          `REVOKE EXECUTE ON FUNCTION ${name}() FROM PUBLIC`,
        ];
      }

      it("a search_path that does not name pg_temp", async () => {
        const fn = probeName("tenancy_invariants_no_temp");
        expect(await violationsAfter(definerFunction(fn, "pg_catalog, public"))).toEqual([
          { invariant: "definerFunction", object: `${fn}()`, detail: "search_path does not end with pg_temp" },
        ]);
      });

      it("pg_temp listed first", async () => {
        const fn = probeName("tenancy_invariants_temp_first");
        expect(await violationsAfter(definerFunction(fn, "pg_temp, pg_catalog"))).toEqual([
          {
            invariant: "definerFunction",
            object: `${fn}()`,
            detail: "search_path does not end with pg_temp; search_path lists pg_temp before its end",
          },
        ]);
      });

      it("pg_temp listed twice, once at the end", async () => {
        const fn = probeName("tenancy_invariants_temp_twice");
        expect(await violationsAfter(definerFunction(fn, "pg_catalog, pg_temp, pg_temp"))).toEqual([
          {
            invariant: "definerFunction",
            object: `${fn}()`,
            detail: "search_path does not end with pg_temp; search_path lists pg_temp before its end",
          },
        ]);
      });

      it("pg_temp in the middle of the list and another schema last", async () => {
        const fn = probeName("tenancy_invariants_temp_middle");
        expect(await violationsAfter(definerFunction(fn, "pg_catalog, pg_temp, public"))).toEqual([
          {
            invariant: "definerFunction",
            object: `${fn}()`,
            detail: "search_path does not end with pg_temp; search_path lists pg_temp before its end",
          },
        ]);
      });

      it("an empty search_path", async () => {
        const fn = probeName("tenancy_invariants_empty_path");
        expect(await violationsAfter(definerFunction(fn, "''"))).toEqual([
          { invariant: "definerFunction", object: `${fn}()`, detail: "search_path does not end with pg_temp" },
        ]);
      });

      it('"$user", whose quotes are stripped before the schema is looked up', async () => {
        const fn = probeName("tenancy_invariants_user_path");
        expect(await violationsAfter(definerFunction(fn, '"$user", pg_catalog, pg_temp'))).toEqual([
          {
            invariant: "definerFunction",
            object: `${fn}()`,
            detail: "search_path names $user, which is not an existing schema",
          },
        ]);
      });

      it("a schema that does not exist, named once however often it is listed", async () => {
        const fn = probeName("tenancy_invariants_missing_path");
        const missing = probeName("tenancy_invariants_no_schema");
        const other = probeName("tenancy_invariants_no_other");
        expect(
          await violationsAfter(definerFunction(fn, `pg_catalog, ${missing}, ${other}, ${missing}, pg_temp`)),
        ).toEqual([
          {
            invariant: "definerFunction",
            object: `${fn}()`,
            detail: `search_path names ${missing}, which is not an existing schema; search_path names ${other}, which is not an existing schema`,
          },
        ]);
      });

      it.each(["alldots_data", "alldots_side", "PUBLIC"])(
        "a schema in which %s may create objects",
        async (grantee) => {
          const fn = probeName("tenancy_invariants_writable_path");
          const schema = probeName("tenancy_invariants_writable");
          expect(
            await violationsAfter([
              `CREATE SCHEMA ${schema}`,
              `GRANT CREATE ON SCHEMA ${schema} TO ${grantee}`,
              ...definerFunction(fn, `pg_catalog, ${schema}, pg_temp`),
            ]),
          ).toEqual([
            {
              invariant: "definerFunction",
              object: `${fn}()`,
              detail: `search_path names ${schema}, in which a runtime role may create objects`,
            },
          ]);
        },
      );

      it.each(["alldots_data", "alldots_side", "PUBLIC"])(
        "pg_catalog when %s may create objects in it",
        async (grantee) => {
          const fn = probeName("tenancy_invariants_catalog_path");
          const violations = await violationsAfter([
            `GRANT CREATE ON SCHEMA pg_catalog TO ${grantee}`,
            ...definerFunction(fn, "pg_catalog, public, pg_temp"),
          ]);
          // Every migrated definer function names pg_catalog as well, so all of them are reported with it.
          expect(violations.length).toBeGreaterThan(1);
          for (const violation of violations) {
            expect(violation).toMatchObject({
              invariant: "definerFunction",
              detail: "search_path names pg_catalog, in which a runtime role may create objects",
            });
          }
          expect(violations.map((violation) => violation.object)).toEqual(
            expect.arrayContaining([`${fn}()`, "ops_health_counts()"]),
          );
        },
      );

      it("accepts a schema in which no runtime role may create objects", async () => {
        const fn = probeName("tenancy_invariants_closed_path");
        const schema = probeName("tenancy_invariants_closed");
        expect(
          await violationsAfter([
            `CREATE SCHEMA ${schema}`,
            `GRANT USAGE ON SCHEMA ${schema} TO alldots_data, alldots_side`,
            ...definerFunction(fn, `pg_catalog, ${schema}, public, pg_temp`),
          ]),
        ).toEqual([]);
      });

      it("a missing schema is reported before a writable one", async () => {
        const fn = probeName("tenancy_invariants_both_path");
        const missing = probeName("tenancy_invariants_no_schema");
        const writable = probeName("tenancy_invariants_writable");
        expect(
          await violationsAfter([
            `CREATE SCHEMA ${writable}`,
            `GRANT CREATE ON SCHEMA ${writable} TO alldots_data`,
            ...definerFunction(fn, `${writable}, ${missing}, pg_temp`),
          ]),
        ).toEqual([
          {
            invariant: "definerFunction",
            object: `${fn}()`,
            detail: `search_path names ${missing}, which is not an existing schema; search_path names ${writable}, in which a runtime role may create objects`,
          },
        ]);
      });

      it("a function in a schema other than public", async () => {
        const fn = probeName("tenancy_invariants_other_schema_fn");
        const schema = probeName("tenancy_invariants_other_schema");
        expect(
          await violationsAfter([
            `CREATE SCHEMA ${schema}`,
            `CREATE FUNCTION ${schema}.${fn}() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS 'SELECT 1'`,
            `REVOKE EXECUTE ON FUNCTION ${schema}.${fn}() FROM PUBLIC`,
          ]),
        ).toEqual([
          {
            invariant: "definerFunction",
            object: `${schema}.${fn}()`,
            detail: "search_path does not end with pg_temp",
          },
        ]);
      });

      it("ops_health_counts() with the search_path of finding R2-DB-1", async () => {
        expect(
          await violationsAfter(["ALTER FUNCTION ops_health_counts() SET search_path = pg_catalog, public"]),
        ).toEqual([
          {
            invariant: "definerFunction",
            object: "ops_health_counts()",
            detail: "search_path does not end with pg_temp",
          },
        ]);
      });
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

  it("returns 1 for ops_health_counts() with the search_path of finding R2-DB-1", async () => {
    // verifyTenancy reads through its own connections, so the break is committed and restored below; integration files run serially.
    await verifyPool.query("ALTER FUNCTION ops_health_counts() SET search_path = pg_catalog, public");
    try {
      const output = recordingOutput();
      expect(await verifyTenancy(verifyPool, output.sink)).toBe(1);
      expect(output.error).toEqual([
        "tenancy violation [definerFunction] ops_health_counts(): search_path does not end with pg_temp",
      ]);
      expect(output.info).toEqual([]);
    } finally {
      await verifyPool.query("ALTER FUNCTION ops_health_counts() SET search_path = pg_catalog, public, pg_temp");
    }
    const restored = await verifyPool.query<{ proconfig: string[] }>(
      "SELECT proconfig FROM pg_proc WHERE oid = 'ops_health_counts()'::regprocedure",
    );
    expect(restored.rows).toEqual([{ proconfig: ["search_path=pg_catalog, public, pg_temp"] }]);
  });

  it("returns 1 and writes one error line per violation", async () => {
    // verifyTenancy reads through its own connections, so the break is committed and dropped below; integration files run serially.
    const first = probeName("tenancy_invariants_verify_a");
    const second = probeName("tenancy_invariants_verify_b");
    const [a, b] = [first, second].sort();
    await verifyPool.query(`CREATE TABLE ${first} (id int)`);
    try {
      await verifyPool.query(`CREATE TABLE ${second} (id int)`);
      const output = recordingOutput();
      expect(await verifyTenancy(verifyPool, output.sink)).toBe(1);
      expect(output.error).toEqual([
        `tenancy violation [classification] ${a}: has no alldots:tenancy=tenant|global comment`,
        `tenancy violation [classification] ${b}: has no alldots:tenancy=tenant|global comment`,
      ]);
      expect(output.info).toEqual([]);
    } finally {
      await verifyPool.query(`DROP TABLE IF EXISTS ${first}, ${second}`);
    }
  });
});
