import type { Pool } from "pg";
import { runAsSystem } from "@alldots/shared";
import type { Queryable } from "./pool.js";

/**
 * Tenancy invariants read from the catalog a deploy is about to activate, catching holes opened by hand in
 * production. `object`/`detail` use catalog names only, never row content.
 */
export type TenancyViolation = { invariant: string; object: string; detail: string };

const RUNTIME_ROLES = ["alldots_data", "alldots_side"];

const TENANT_COMMENT = "alldots:tenancy=tenant";

/** A table in `public` (ordinary or partitioned, not a partition) whose comment is not exactly a tenancy classification. */
async function findClassificationViolations(client: Queryable): Promise<TenancyViolation[]> {
  const { rows } = await client.query<{ table_name: string; comment: string | null }>(
    `SELECT c.relname::text AS table_name, obj_description(c.oid, 'pg_class') AS comment
       FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace
        AND c.relkind IN ('r', 'p')
        AND NOT c.relispartition
        AND COALESCE(obj_description(c.oid, 'pg_class'), '') NOT IN ('alldots:tenancy=tenant', 'alldots:tenancy=global')
      ORDER BY c.relname`,
  );
  return rows.map((row) => ({
    invariant: "classification",
    object: row.table_name,
    detail:
      row.comment === null
        ? "has no alldots:tenancy=tenant|global comment"
        : "its comment is not exactly alldots:tenancy=tenant or alldots:tenancy=global",
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

/** Missing, superuser, `BYPASSRLS`, member of such a role, or owner (or member of the owner) of a `public` relation. */
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

/**
 * A foreign key to `items` that is not `(tenant_id, <column>) REFERENCES items (tenant_id, id)`. FK checks ignore RLS,
 * so a key on the bare item id would accept another tenant's item and answer whether that id exists.
 */
async function findItemForeignKeyViolations(client: Queryable): Promise<TenancyViolation[]> {
  const { rows } = await client.query<{ table_name: string; constraint_name: string }>(
    `SELECT c.relname::text AS table_name, k.conname::text AS constraint_name
       FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid
      WHERE k.contype = 'f'
        AND k.confrelid = to_regclass('public.items')
        AND (ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY AS u(attnum, ord)
                     JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = u.attnum ORDER BY u.ord)
               IS DISTINCT FROM ARRAY['tenant_id', 'id']
             OR (SELECT a.attname::text FROM pg_attribute a
                  WHERE a.attrelid = k.conrelid AND a.attnum = k.conkey[1]) IS DISTINCT FROM 'tenant_id')
      ORDER BY c.relname, k.conname`,
  );
  return rows.map((row) => ({
    invariant: "itemForeignKey",
    object: `${row.table_name}.${row.constraint_name}`,
    detail: "foreign key to items is not over (tenant_id, id)",
  }));
}

/** Splits a `proconfig` `search_path=` value into trimmed, unquoted, non-empty elements. */
function parseSearchPath(value: string): string[] {
  return value
    .split(",")
    .map((element) => element.trim())
    .map((element) =>
      element.length >= 2 && element.startsWith('"') && element.endsWith('"') ? element.slice(1, -1) : element,
    )
    .filter((element) => element.length > 0);
}

type SchemaFacts = { exists: boolean; runtimeRoleMayCreate: boolean };

/** Existence and `CREATE` for `PUBLIC`/`alldots_data`/`alldots_side`; a missing runtime role is skipped here. */
async function readSchemaFacts(client: Queryable, names: string[]): Promise<Map<string, SchemaFacts>> {
  const facts = new Map<string, SchemaFacts>();
  if (names.length === 0) return facts;
  const { rows } = await client.query<{ name: string; schema_exists: boolean; may_create: boolean }>(
    `SELECT wanted.name, ns.oid IS NOT NULL AS schema_exists,
            COALESCE(has_schema_privilege('public', ns.oid, 'CREATE')
                     OR EXISTS (SELECT 1 FROM pg_roles r
                                 WHERE r.rolname = ANY($2::text[])
                                   AND has_schema_privilege(r.oid, ns.oid, 'CREATE')), false) AS may_create
       FROM unnest($1::text[]) AS wanted(name)
      CROSS JOIN LATERAL (SELECT to_regnamespace(quote_ident(wanted.name))::oid AS oid) AS ns`,
    [names, RUNTIME_ROLES],
  );
  for (const row of rows) {
    facts.set(row.name, { exists: row.schema_exists, runtimeRoleMayCreate: row.may_create });
  }
  return facts;
}

/**
 * A `SECURITY DEFINER` function outside `pg_catalog`/`information_schema` that
 * - has no pinned `search_path`, or one not ending in `pg_temp` (otherwise the temporary schema is
 *   searched first), lists `pg_temp` earlier, names a missing schema (`"$user"` included), or names a
 *   schema `PUBLIC`, `alldots_data` or `alldots_side` may create in;
 * - is executable by `PUBLIC` (a NULL `proacl` grants it);
 * - or is owned by neither `alldots_router` nor the owner of `public.items`.
 */
async function findDefinerFunctionViolations(client: Queryable): Promise<TenancyViolation[]> {
  const { rows } = await client.query<{
    function_name: string;
    search_path: string | null;
    public_execute: boolean;
    allowed_owner: boolean;
  }>(
    `SELECT p.oid::regprocedure::text AS function_name,
            (SELECT substr(setting, length('search_path=') + 1)
               FROM unnest(COALESCE(p.proconfig, '{}')) AS setting
              WHERE setting LIKE 'search\\_path=%'
              LIMIT 1) AS search_path,
            (p.proacl IS NULL
             OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) AS acl
                         WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE')) AS public_execute,
            (p.proowner = (SELECT oid FROM pg_roles WHERE rolname = 'alldots_router')
             OR p.proowner = (SELECT relowner FROM pg_class WHERE oid = to_regclass('public.items'))) IS TRUE
              AS allowed_owner
       FROM pg_proc p
      WHERE p.pronamespace NOT IN ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
        AND p.prosecdef
      ORDER BY 1`,
  );
  const elementsOf = new Map(
    rows.map((row) => [row.function_name, row.search_path === null ? null : parseSearchPath(row.search_path)]),
  );
  // `pg_catalog` always exists, but CREATE on it would let a runtime role shadow functions and operators.
  const schemaNames = new Set<string>();
  for (const elements of elementsOf.values()) {
    for (const element of elements ?? []) {
      if (element !== "pg_temp") schemaNames.add(element);
    }
  }
  const schemaFacts = await readSchemaFacts(client, [...schemaNames]);

  const violations: TenancyViolation[] = [];
  for (const row of rows) {
    const problems: string[] = [];
    const elements = elementsOf.get(row.function_name) ?? null;
    if (elements === null) {
      problems.push("has no pinned search_path");
    } else {
      const tempPositions = elements.flatMap((element, index) => (element === "pg_temp" ? [index] : []));
      if (elements.at(-1) !== "pg_temp" || tempPositions.length > 1) {
        problems.push("search_path does not end with pg_temp");
      }
      if (tempPositions.some((position) => position !== elements.length - 1)) {
        problems.push("search_path lists pg_temp before its end");
      }
      const schemas = [...new Set(elements.filter((element) => schemaNames.has(element)))];
      for (const schema of schemas) {
        if (schemaFacts.get(schema)?.exists !== true) {
          problems.push(`search_path names ${schema}, which is not an existing schema`);
        }
      }
      for (const schema of schemas) {
        if (schemaFacts.get(schema)?.runtimeRoleMayCreate === true) {
          problems.push(`search_path names ${schema}, in which a runtime role may create objects`);
        }
      }
    }
    if (row.public_execute) problems.push("is executable by PUBLIC");
    if (!row.allowed_owner) problems.push("is owned by neither alldots_router nor the owner of items");
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

export async function findTenancyViolations(client: Queryable): Promise<TenancyViolation[]> {
  const checks = [
    findClassificationViolations,
    findTenantColumnViolations,
    findRowLevelSecurityViolations,
    findStrictDefaultViolations,
    findRuntimeRoleViolations,
    findItemForeignKeyViolations,
    findDefinerFunctionViolations,
    findForeignKeyViolations,
  ];
  const violations: TenancyViolation[] = [];
  for (const check of checks) {
    violations.push(...(await check(client)));
  }
  return violations;
}

/** Returns 0 when all hold, else 1 with one line per violation; a failing catalog query rejects. */
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
