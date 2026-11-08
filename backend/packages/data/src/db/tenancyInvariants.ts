import type { Pool } from "pg";
import { runAsSystem } from "@semprec/shared";
import type { Queryable } from "./pool.js";

/**
 * Issue #1085: the tenancy invariants of `docs/adr/2026-10-03-tenant-isolation-through-row-level-security.md`,
 * read from the catalog of the database the deploy is about to activate a release on. The catalog
 * test (`__tests__/tenancyCatalog.test.ts`) proves the same invariants on the test database in CI;
 * this module catches a hole opened on the production database by hand (an `ALTER ROLE … BYPASSRLS`,
 * a dropped policy, a grant on an `items_p_*` partition, a hand-edited function).
 *
 * Every `object` and `detail` is built from catalog names only, never from row content.
 */
export type TenancyViolation = { invariant: string; object: string; detail: string };

const RUNTIME_ROLES = ["semprec_data", "semprec_side"];

const TENANT_COMMENT = "semprec:tenancy=tenant";

/** A table in `public` (ordinary or partitioned, not a partition) whose comment is not exactly a tenancy classification. */
async function findClassificationViolations(client: Queryable): Promise<TenancyViolation[]> {
  const { rows } = await client.query<{ table_name: string; comment: string | null }>(
    `SELECT c.relname::text AS table_name, obj_description(c.oid, 'pg_class') AS comment
       FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace
        AND c.relkind IN ('r', 'p')
        AND NOT c.relispartition
        AND COALESCE(obj_description(c.oid, 'pg_class'), '') NOT IN ('semprec:tenancy=tenant', 'semprec:tenancy=global')
      ORDER BY c.relname`,
  );
  return rows.map((row) => ({
    invariant: "classification",
    object: row.table_name,
    detail:
      row.comment === null
        ? "has no semprec:tenancy=tenant|global comment"
        : "its comment is not exactly semprec:tenancy=tenant or semprec:tenancy=global",
  }));
}

/** A tenant table whose `tenant_id` is missing, not `uuid`, nullable, or not defaulted to `app_tenant_default()`. */
async function findTenantColumnViolations(client: Queryable): Promise<TenancyViolation[]> {
  const { rows } = await client.query<{
    table_name: string;
    has_column: boolean;
    type_name: string | null;
    not_null: boolean | null;
    default_expr: string | null;
  }>(
    `SELECT c.relname::text AS table_name, a.attnum IS NOT NULL AS has_column, t.typname::text AS type_name,
            a.attnotnull AS not_null, pg_get_expr(d.adbin, d.adrelid) AS default_expr
       FROM pg_class c
       LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
       LEFT JOIN pg_type t ON t.oid = a.atttypid
       LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
      WHERE c.relnamespace = 'public'::regnamespace
        AND c.relkind IN ('r', 'p')
        AND NOT c.relispartition
        AND obj_description(c.oid, 'pg_class') = $1
      ORDER BY c.relname`,
    [TENANT_COMMENT],
  );
  const violations: TenancyViolation[] = [];
  for (const row of rows) {
    const problems: string[] = [];
    if (!row.has_column) {
      problems.push("has no tenant_id column");
    } else {
      if (row.type_name !== "uuid") problems.push("tenant_id is not uuid");
      if (row.not_null !== true) problems.push("tenant_id is nullable");
      if (row.default_expr !== "app_tenant_default()")
        problems.push("tenant_id does not default to app_tenant_default()");
    }
    if (problems.length > 0) {
      violations.push({ invariant: "tenantColumn", object: row.table_name, detail: problems.join("; ") });
    }
  }
  return violations;
}

/** A tenant table without row-level security, a restrictive all-command `tenant_isolation` policy or a permissive `tenant_rows` policy. */
async function findRowLevelSecurityViolations(client: Queryable): Promise<TenancyViolation[]> {
  const { rows } = await client.query<{
    table_name: string;
    row_security: boolean;
    has_isolation: boolean;
    has_rows: boolean;
  }>(
    `SELECT c.relname::text AS table_name, c.relrowsecurity AS row_security,
            EXISTS (SELECT 1 FROM pg_policy p
                     WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation'
                       AND NOT p.polpermissive AND p.polcmd = '*') AS has_isolation,
            EXISTS (SELECT 1 FROM pg_policy p
                     WHERE p.polrelid = c.oid AND p.polname = 'tenant_rows' AND p.polpermissive) AS has_rows
       FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace
        AND c.relkind IN ('r', 'p')
        AND NOT c.relispartition
        AND obj_description(c.oid, 'pg_class') = $1
      ORDER BY c.relname`,
    [TENANT_COMMENT],
  );
  const violations: TenancyViolation[] = [];
  for (const row of rows) {
    const problems: string[] = [];
    if (!row.row_security) problems.push("row-level security is disabled");
    if (!row.has_isolation) problems.push("has no restrictive tenant_isolation policy for all commands");
    if (!row.has_rows) problems.push("has no permissive tenant_rows policy");
    if (problems.length > 0) {
      violations.push({ invariant: "rowLevelSecurity", object: row.table_name, detail: problems.join("; ") });
    }
  }
  return violations;
}

/** `app_tenant_default()` missing, or still falling back to the sole tenant. */
async function findStrictDefaultViolations(client: Queryable): Promise<TenancyViolation[]> {
  const { rows } = await client.query<{ definition: string | null }>(
    `SELECT CASE WHEN to_regprocedure('public.app_tenant_default()') IS NULL THEN NULL
                 ELSE pg_get_functiondef(to_regprocedure('public.app_tenant_default()')) END AS definition`,
  );
  const definition = rows[0]?.definition ?? null;
  const object = "app_tenant_default()";
  if (definition === null) {
    return [{ invariant: "strictDefault", object, detail: "is not defined" }];
  }
  if (definition.includes("app_sole_tenant")) {
    return [{ invariant: "strictDefault", object, detail: "references app_sole_tenant" }];
  }
  return [];
}

/**
 * A runtime role that is missing, superuser, `BYPASSRLS`, a member of a superuser or `BYPASSRLS`
 * role, or a member of (or itself) the owner of a relation in `public`.
 */
async function findRuntimeRoleViolations(client: Queryable): Promise<TenancyViolation[]> {
  const { rows } = await client.query<{
    role_name: string;
    exists: boolean;
    is_super: boolean | null;
    bypass_rls: boolean | null;
    privileged_roles: string[];
    owner_roles: string[];
  }>(
    `SELECT wanted.role_name, r.oid IS NOT NULL AS exists, r.rolsuper AS is_super, r.rolbypassrls AS bypass_rls,
            COALESCE((SELECT array_agg(p.rolname::text ORDER BY p.rolname)
                        FROM pg_roles p
                       WHERE r.oid IS NOT NULL AND p.oid <> r.oid AND (p.rolsuper OR p.rolbypassrls)
                         AND pg_has_role(r.oid, p.oid, 'MEMBER')), '{}') AS privileged_roles,
            COALESCE((SELECT array_agg(o.rolname::text ORDER BY o.rolname)
                        FROM pg_roles o
                       WHERE r.oid IS NOT NULL
                         AND EXISTS (SELECT 1 FROM pg_class c
                                      WHERE c.relnamespace = 'public'::regnamespace AND c.relowner = o.oid)
                         AND pg_has_role(r.oid, o.oid, 'MEMBER')), '{}') AS owner_roles
       FROM unnest($1::text[]) AS wanted(role_name)
       LEFT JOIN pg_roles r ON r.rolname = wanted.role_name
      ORDER BY wanted.role_name`,
    [RUNTIME_ROLES],
  );
  const violations: TenancyViolation[] = [];
  for (const row of rows) {
    const problems: string[] = [];
    if (!row.exists) {
      problems.push("does not exist");
    } else {
      if (row.is_super) problems.push("is a superuser");
      if (row.bypass_rls) problems.push("has BYPASSRLS");
      if (row.privileged_roles.length > 0) {
        problems.push(`is a member of superuser or BYPASSRLS role(s) ${row.privileged_roles.join(", ")}`);
      }
      if (row.owner_roles.length > 0) {
        problems.push(`is or is a member of ${row.owner_roles.join(", ")}, owning relations in public`);
      }
    }
    if (problems.length > 0) {
      violations.push({ invariant: "runtimeRole", object: row.role_name, detail: problems.join("; ") });
    }
  }
  return violations;
}

/** Any privilege of a runtime role on an `items_p_*` partition, which RLS on `items` does not cover. */
async function findPartitionPrivilegeViolations(client: Queryable): Promise<TenancyViolation[]> {
  const { rows } = await client.query<{ partition_name: string; role_name: string }>(
    `SELECT c.relname::text AS partition_name, r.rolname::text AS role_name
       FROM pg_class c
      CROSS JOIN pg_roles r
      WHERE c.relnamespace = 'public'::regnamespace
        AND c.relkind IN ('r', 'p')
        AND c.relispartition
        AND c.relname LIKE 'items\\_p\\_%'
        AND r.rolname = ANY($1::text[])
        AND has_table_privilege(r.oid, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
      ORDER BY c.relname, r.rolname`,
    [RUNTIME_ROLES],
  );
  return rows.map((row) => ({
    invariant: "partitionPrivilege",
    object: row.partition_name,
    detail: `${row.role_name} holds a table privilege on the partition`,
  }));
}

/**
 * A `SECURITY DEFINER` function in `public` without a pinned `search_path`, executable by
 * `PUBLIC` (a NULL `proacl` is the default, which grants it), or owned by neither `semprec_router`
 * nor the owner of `public.items`.
 */
async function findDefinerFunctionViolations(client: Queryable): Promise<TenancyViolation[]> {
  const { rows } = await client.query<{
    function_name: string;
    pinned_search_path: boolean;
    public_execute: boolean;
    allowed_owner: boolean;
  }>(
    `SELECT p.oid::regprocedure::text AS function_name,
            EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig, '{}')) AS setting
                     WHERE setting LIKE 'search\\_path=%') AS pinned_search_path,
            (p.proacl IS NULL
             OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) AS acl
                         WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE')) AS public_execute,
            (p.proowner = (SELECT oid FROM pg_roles WHERE rolname = 'semprec_router')
             OR p.proowner = (SELECT relowner FROM pg_class WHERE oid = to_regclass('public.items'))) IS TRUE
              AS allowed_owner
       FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace
        AND p.prosecdef
      ORDER BY 1`,
  );
  const violations: TenancyViolation[] = [];
  for (const row of rows) {
    const problems: string[] = [];
    if (!row.pinned_search_path) problems.push("has no pinned search_path");
    if (row.public_execute) problems.push("is executable by PUBLIC");
    if (!row.allowed_owner) problems.push("is owned by neither semprec_router nor the owner of items");
    if (problems.length > 0) {
      violations.push({ invariant: "definerFunction", object: row.function_name, detail: problems.join("; ") });
    }
  }
  return violations;
}

/** A foreign key over `tenant_id` left `NOT VALID`, so rows written before it was added are unchecked. */
async function findForeignKeyViolations(client: Queryable): Promise<TenancyViolation[]> {
  const { rows } = await client.query<{ table_name: string; constraint_name: string }>(
    `SELECT c.relname::text AS table_name, k.conname::text AS constraint_name
       FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid
      WHERE k.contype = 'f'
        AND NOT k.convalidated
        AND c.relnamespace = 'public'::regnamespace
        AND EXISTS (SELECT 1 FROM pg_attribute a
                     WHERE a.attrelid = k.conrelid AND a.attname = 'tenant_id' AND a.attnum = ANY(k.conkey))
      ORDER BY c.relname, k.conname`,
  );
  return rows.map((row) => ({
    invariant: "foreignKey",
    object: `${row.table_name}.${row.constraint_name}`,
    detail: "foreign key over tenant_id is not validated",
  }));
}

/** Every tenancy invariant the catalog of `client`'s database breaks, in invariant order; empty when all hold. */
export async function findTenancyViolations(client: Queryable): Promise<TenancyViolation[]> {
  const checks = [
    findClassificationViolations,
    findTenantColumnViolations,
    findRowLevelSecurityViolations,
    findStrictDefaultViolations,
    findRuntimeRoleViolations,
    findPartitionPrivilegeViolations,
    findDefinerFunctionViolations,
    findForeignKeyViolations,
  ];
  const violations: TenancyViolation[] = [];
  for (const check of checks) {
    violations.push(...(await check(client)));
  }
  return violations;
}

/**
 * Checks every tenancy invariant and reports the outcome: `tenancy: verified` and 0 when all hold,
 * otherwise one `tenancy violation [<invariant>] <object>: <detail>` error line per violation and
 * 1. A failing catalog query rejects rather than reporting either outcome.
 */
export async function verifyTenancy(
  pool: Pool,
  output: { info(line: string): void; error(line: string): void },
): Promise<0 | 1> {
  const violations = await runAsSystem("verify-tenancy", () => findTenancyViolations(pool));
  if (violations.length === 0) {
    output.info("tenancy: verified");
    return 0;
  }
  for (const violation of violations) {
    output.error(`tenancy violation [${violation.invariant}] ${violation.object}: ${violation.detail}`);
  }
  return 1;
}
