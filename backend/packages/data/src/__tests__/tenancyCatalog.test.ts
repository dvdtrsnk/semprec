import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { seedSystem } from "../seed/seedSystem.js";

/**
 * Issue #971: every ordinary or partitioned table in `public` (partitions are classified through
 * their parent) carries exactly one `semprec:tenancy=tenant|global` comment, written by the
 * migration that creates it. Later tenancy issues append their catalog assertions to this file.
 */
const GLOBAL_TABLES = [
  "users",
  "sessions",
  "login_attempts",
  "password_reset_tokens",
  "push_subscriptions",
  "agent_run_mcp_credentials",
  "process_heartbeats",
  "observability_checks",
  "schema_migrations",
  "tenants",
];

const TENANT_TABLES = [
  "databases",
  "properties",
  "relation_definitions",
  "items",
  "item_relations",
  "views",
  "view_items",
  "idempotency_keys",
  "rollup_dependencies",
  "task_recurrence",
  "item_automation",
  "item_search_index",
  "blobs",
  "docs",
  "doc_snapshots",
  "doc_updates",
  "doc_snapshot_history",
  "doc_history_updates",
  "project_heartbeats",
  "heartbeat_occurrences",
  "agent_runs",
  "agent_run_events",
  "approval_requests",
  "mcp_tool_registrations",
  "project_mcp_grants",
  "project_agent_guidance",
  "agent_guidance_drift_findings",
  "manifest_drift_findings",
  "notifications",
  "push_deliveries",
  "mail_account_sync_state",
  "mail_folder_sync_state",
  "mail_threads",
  "mail_message_meta",
  "mail_attachments",
  "mail_message_flag_sync_state",
  "person_email_index",
  "external_credentials",
  "credential_access_log",
  "ai_gateway_calls",
  "module_migrations",
  "module_migration_progress",
  "resource_grants",
  "tenant_keys",
];

type Queryable = Pick<Pool | PoolClient, "query">;

async function listUnclassifiedTables(db: Queryable): Promise<string[]> {
  const { rows } = await db.query<{ relname: string }>(
    `SELECT c.relname
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p')
        AND NOT c.relispartition
        AND COALESCE(obj_description(c.oid, 'pg_class'), '') NOT IN ('semprec:tenancy=tenant', 'semprec:tenancy=global')
      ORDER BY c.relname`,
  );
  return rows.map((row) => row.relname);
}

async function readClassifications(db: Queryable, tables: string[]): Promise<Map<string, string | null>> {
  const { rows } = await db.query<{ relname: string; comment: string | null }>(
    `SELECT c.relname, obj_description(c.oid, 'pg_class') AS comment
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
    [tables],
  );
  return new Map(rows.map((row) => [row.relname, row.comment]));
}

/** Issue #974: parent-scoped keys and the provider-assigned id kept global by decision; each entry says why it needs no tenant_id. */
const PERMANENT_EXCEPTIONS: { table: string; columns: string[]; reason: string }[] = [
  { table: "properties", columns: ["database_id", "key"], reason: "scoped by the server-generated database id" },
  { table: "relation_definitions", columns: ["property_id_a"], reason: "scoped by the server-generated property id" },
  { table: "relation_definitions", columns: ["property_id_b"], reason: "scoped by the server-generated property id" },
  { table: "items", columns: ["database_id", "id"], reason: "partition key of items, scoped by the database id" },
  {
    table: "item_relations",
    columns: ["relation_definition_id", "item_a", "item_b"],
    reason: "scoped by the relation definition id",
  },
  { table: "project_heartbeats", columns: ["project_item_id", "action_id"], reason: "scoped by the project item id" },
  {
    table: "rollup_dependencies",
    columns: ["rollup_property_id"],
    reason: "scoped by the server-generated property id",
  },
  { table: "views", columns: ["database_id"], reason: "scoped by the server-generated database id" },
  { table: "view_items", columns: ["view_id", "item_id"], reason: "scoped by the server-generated view id" },
  { table: "doc_snapshots", columns: ["doc_id"], reason: "scoped by the server-generated doc id" },
  { table: "doc_history_updates", columns: ["update_id"], reason: "scoped by the server-generated update id" },
  { table: "task_recurrence", columns: ["item_id"], reason: "scoped by the server-generated item id" },
  { table: "item_automation", columns: ["item_id"], reason: "scoped by the server-generated item id" },
  { table: "mail_account_sync_state", columns: ["item_id"], reason: "scoped by the server-generated item id" },
  { table: "mail_folder_sync_state", columns: ["item_id"], reason: "scoped by the server-generated item id" },
  { table: "mail_message_meta", columns: ["item_id"], reason: "scoped by the server-generated item id" },
  { table: "external_credentials", columns: ["item_id"], reason: "scoped by the server-generated item id" },
  { table: "item_search_index", columns: ["item_id"], reason: "scoped by the server-generated item id" },
  {
    table: "mail_message_meta",
    columns: ["message_id", "mailbox_item_id"],
    reason: "scoped by the server-generated mailbox item id",
  },
  {
    table: "mcp_tool_registrations",
    columns: ["mcp_server_item_id", "tool_name"],
    reason: "scoped by the server-generated MCP server item id",
  },
  {
    table: "project_mcp_grants",
    columns: ["project_item_id", "mcp_tool_registration_id"],
    reason: "scoped by the server-generated project item id",
  },
  {
    table: "project_agent_guidance",
    columns: ["project_item_id"],
    reason: "scoped by the server-generated project item id",
  },
  {
    table: "agent_guidance_drift_findings",
    columns: ["project_item_id", "fingerprint"],
    reason: "scoped by the server-generated project item id",
  },
  {
    table: "heartbeat_occurrences",
    columns: ["heartbeat_id", "scheduled_for"],
    reason: "scoped by the server-generated heartbeat id",
  },
  {
    table: "push_deliveries",
    columns: ["notification_id", "push_subscription_id"],
    reason: "scoped by the server-generated notification id",
  },
  {
    table: "mail_message_flag_sync_state",
    columns: ["message_item_id", "property_key"],
    reason: "scoped by the server-generated message item id",
  },
  {
    table: "mail_account_sync_state",
    columns: ["graph_subscription_id"],
    reason: "provider-assigned id that a router function resolves to its tenant (0041)",
  },
];

/** Legacy global keys kept beside their tenant-leading successors until #1065 drops them; #1065 empties this list. */
const LEGACY_GLOBAL_UNIQUES: { table: string; columns: string[] }[] = [
  { table: "idempotency_keys", columns: ["key"] },
  { table: "person_email_index", columns: ["email"] },
  { table: "mail_message_meta", columns: ["provider_message_id"] },
  { table: "blobs", columns: ["content_hash"] },
  { table: "notifications", columns: ["source_table", "source_id", "kind", "transition_instance"] },
  { table: "manifest_drift_findings", columns: ["kind", "dedupe_key"] },
  { table: "module_migrations", columns: ["module_id", "database_key", "from_version", "to_version"] },
  { table: "module_migration_progress", columns: ["module_id", "database_key", "from_version", "to_version"] },
  { table: "docs", columns: ["item_id"] },
  { table: "resource_grants", columns: ["resource_type", "resource_id", "grantee_user_id"] },
];

const NEW_UNIQUE_INDEXES: { name: string; table: string; columns: string[]; predicate: string | null }[] = [
  { name: "databases_key_unique", table: "databases", columns: ["tenant_id", "key"], predicate: null },
  {
    name: "databases_tenant_system_module_uq",
    table: "databases",
    columns: ["tenant_id", "owner_module_id"],
    predicate: "system",
  },
  { name: "idempotency_keys_tenant_key_uq", table: "idempotency_keys", columns: ["tenant_id", "key"], predicate: null },
  {
    name: "person_email_index_tenant_email_uq",
    table: "person_email_index",
    columns: ["tenant_id", "email"],
    predicate: null,
  },
  {
    name: "mail_message_meta_tenant_provider_msg_uq",
    table: "mail_message_meta",
    columns: ["tenant_id", "provider_message_id"],
    predicate: "provider_message_id IS NOT NULL",
  },
  {
    name: "blobs_tenant_content_hash_uq",
    table: "blobs",
    columns: ["tenant_id", "content_hash"],
    predicate: "content_hash IS NOT NULL",
  },
  {
    name: "notifications_tenant_dedupe_idx",
    table: "notifications",
    columns: ["tenant_id", "user_id", "source_table", "source_id", "kind", "transition_instance"],
    predicate: null,
  },
  {
    name: "manifest_drift_findings_tenant_active_idx",
    table: "manifest_drift_findings",
    columns: ["tenant_id", "kind", "dedupe_key"],
    predicate: "resolved_at IS NULL AND dedupe_key IS NOT NULL",
  },
  {
    name: "module_migrations_tenant_uq",
    table: "module_migrations",
    columns: ["tenant_id", "module_id", "database_key", "from_version", "to_version"],
    predicate: null,
  },
  {
    name: "module_migration_progress_tenant_uq",
    table: "module_migration_progress",
    columns: ["tenant_id", "module_id", "database_key", "from_version", "to_version"],
    predicate: null,
  },
  { name: "docs_tenant_item_id_uq", table: "docs", columns: ["tenant_id", "item_id"], predicate: null },
  {
    name: "resource_grants_tenant_uq",
    table: "resource_grants",
    columns: ["tenant_id", "resource_type", "resource_id", "grantee_user_id"],
    predicate: null,
  },
  ...[
    "databases",
    "properties",
    "relation_definitions",
    "agent_runs",
    "project_heartbeats",
    "views",
    "docs",
    "notifications",
    "mcp_tool_registrations",
    "mail_threads",
    "blobs",
  ].map((table) => ({ name: `${table}_tenant_id_id_uq`, table, columns: ["tenant_id", "id"], predicate: null })),
];

interface UniqueIndexRow {
  index_name: string;
  table_name: string;
  columns: string[];
  default_expr: string | null;
  predicate: string | null;
}

async function listUniqueIndexes(db: Queryable): Promise<UniqueIndexRow[]> {
  const { rows } = await db.query<UniqueIndexRow>(
    `SELECT ic.relname::text AS index_name, c.relname::text AS table_name,
            ARRAY(SELECT a.attname::text FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, ord)
                    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
                   ORDER BY k.ord) AS columns,
            (SELECT pg_get_expr(d.adbin, d.adrelid) FROM pg_attrdef d
              WHERE d.adrelid = c.oid AND d.adnum = i.indkey[0]) AS default_expr,
            pg_get_expr(i.indpred, i.indrelid) AS predicate
       FROM pg_index i
       JOIN pg_class ic ON ic.oid = i.indexrelid
       JOIN pg_class c ON c.oid = i.indrelid
      WHERE i.indisunique
        AND c.relnamespace = 'public'::regnamespace
        AND c.relkind IN ('r', 'p')
        AND NOT c.relispartition
        AND obj_description(c.oid, 'pg_class') = 'semprec:tenancy=tenant'
      ORDER BY c.relname, ic.relname`,
  );
  return rows;
}

function sameKey(row: UniqueIndexRow, entry: { table: string; columns: string[] }): boolean {
  return row.table_name === entry.table && row.columns.join(",") === entry.columns.join(",");
}

/** Names every unique index on a tenant table that neither leads with tenant_id nor is a surrogate key or a listed exception. */
async function listUniquenessViolations(db: Queryable): Promise<string[]> {
  const rows = await listUniqueIndexes(db);
  return rows
    .filter((row) => {
      if (row.columns[0] === "tenant_id") return false;
      const surrogate =
        row.columns.length === 1 &&
        row.default_expr !== null &&
        (row.default_expr.startsWith("gen_random_uuid()") || row.default_expr.startsWith("nextval("));
      if (surrogate) return false;
      if (PERMANENT_EXCEPTIONS.some((entry) => sameKey(row, entry))) return false;
      return !LEGACY_GLOBAL_UNIQUES.some((entry) => sameKey(row, entry));
    })
    .map((row) => `${row.index_name} on ${row.table_name} (${row.columns.join(", ")})`);
}

let pool: Pool;

describe("tenancy classification catalog", () => {
  beforeAll(() => {
    pool = getTestPool();
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("classifies every non-partition table in public", async () => {
    const offenders = await listUnclassifiedTables(pool);
    expect(
      offenders,
      `Tables without a tenancy classification: ${offenders.join(", ")}. ` +
        `Fix: add COMMENT ON TABLE <table> IS 'semprec:tenancy=tenant' (or 'semprec:tenancy=global') in the migration that creates it.`,
    ).toEqual([]);
  });

  it("names an unclassified table", async () => {
    const probe = `tenancy_catalog_probe_${randomBytes(4).toString("hex")}`;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      try {
        await client.query(`CREATE TABLE ${probe} (id int)`);
        expect(await listUnclassifiedTables(client)).toEqual([probe]);
      } finally {
        await client.query("ROLLBACK");
      }
    } finally {
      client.release();
    }
    expect(await listUnclassifiedTables(pool)).toEqual([]);
  });

  it("does not report items partitions", async () => {
    await resetDatabase(pool);
    const db = await createChokePoint(pool).createDatabase({ name: "Tenancy catalog partition" });
    const { rows } = await pool.query<{ relname: string }>(
      `SELECT relname FROM pg_class WHERE relname = $1 AND relispartition`,
      [`items_p_${db.id.replaceAll("-", "")}`],
    );
    expect(rows).toHaveLength(1);
    expect(await listUnclassifiedTables(pool)).toEqual([]);
  });

  it("pins the global tables", async () => {
    const comments = await readClassifications(pool, GLOBAL_TABLES);
    for (const table of GLOBAL_TABLES) {
      expect(comments.get(table), table).toBe("semprec:tenancy=global");
    }
  });

  it("pins the tenant tables", async () => {
    const comments = await readClassifications(pool, TENANT_TABLES);
    for (const table of TENANT_TABLES) {
      expect(comments.get(table), table).toBe("semprec:tenancy=tenant");
    }
  });

  /** Issue #972: `tenant_id uuid NOT NULL DEFAULT app_tenant_default()` referencing tenants(id). */
  it("gives every tenant table and items partition a defaulted, foreign-keyed tenant_id", async () => {
    await resetDatabase(pool);
    await createChokePoint(pool).createDatabase({ name: "Tenancy catalog tenant_id" });
    const { rows } = await pool.query<{
      relname: string;
      typname: string | null;
      attnotnull: boolean | null;
      default_expr: string | null;
      fk_targets: string[];
    }>(
      `SELECT c.relname, t.typname, a.attnotnull, pg_get_expr(d.adbin, d.adrelid) AS default_expr,
              COALESCE((SELECT array_agg(cf.relname::text)
                          FROM pg_constraint k
                          JOIN pg_class cf ON cf.oid = k.confrelid
                         WHERE k.conrelid = c.oid AND k.contype = 'f'
                           AND k.conkey = ARRAY[a.attnum] AND k.confkey = (
                             SELECT ARRAY[ta.attnum] FROM pg_attribute ta
                              WHERE ta.attrelid = cf.oid AND ta.attname = 'id')), '{}') AS fk_targets
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
         LEFT JOIN pg_type t ON t.oid = a.atttypid
         LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
        WHERE n.nspname = 'public'
          AND (obj_description(c.oid, 'pg_class') = 'semprec:tenancy=tenant'
               OR (c.relkind = 'r' AND c.relispartition AND c.relname LIKE 'items\\_p\\_%'))
        ORDER BY c.relname`,
    );
    const byTable = new Map(rows.map((row) => [row.relname, row]));
    for (const table of TENANT_TABLES) {
      expect(byTable.has(table), `${table} is missing from the catalog`).toBe(true);
    }
    expect(rows.filter((row) => row.relname.startsWith("items_p_")).length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.typname, `${row.relname}.tenant_id type`).toBe("uuid");
      expect(row.attnotnull, `${row.relname}.tenant_id NOT NULL`).toBe(true);
      expect(row.default_expr, `${row.relname}.tenant_id default`).toBe("app_tenant_default()");
      if (!row.relname.startsWith("items_p_")) {
        expect(row.fk_targets, `${row.relname}.tenant_id foreign key`).toEqual(["tenants"]);
      }
    }
  });

  /** Issue #973: RLS enabled and not forced, with exactly the restrictive and the permissive policy. */
  it("enables row-level security without forcing it on every tenant table", async () => {
    const { rows } = await pool.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1::text[])`,
      [TENANT_TABLES],
    );
    expect(rows.map((row) => row.relname).sort()).toEqual([...TENANT_TABLES].sort());
    for (const row of rows) {
      expect(row.relrowsecurity, `${row.relname} relrowsecurity`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname} relforcerowsecurity`).toBe(false);
    }
  });

  it("gives every tenant table exactly the tenant_isolation and tenant_rows policies", async () => {
    const { rows } = await pool.query<{
      tablename: string;
      policyname: string;
      permissive: string;
      roles: string[];
      cmd: string;
      qual: string | null;
      with_check: string | null;
    }>(
      `SELECT tablename::text, policyname::text, permissive, roles::text[] AS roles, cmd, qual, with_check
         FROM pg_policies
        WHERE schemaname = 'public'
        ORDER BY tablename, policyname`,
    );
    const byTable = new Map<string, typeof rows>();
    for (const row of rows) byTable.set(row.tablename, [...(byTable.get(row.tablename) ?? []), row]);
    expect([...byTable.keys()].sort(), "tables carrying policies").toEqual([...TENANT_TABLES].sort());
    for (const table of TENANT_TABLES) {
      const policies = byTable.get(table) ?? [];
      expect(
        policies.map((policy) => policy.policyname),
        `${table} policy names`,
      ).toEqual(["tenant_isolation", "tenant_rows"]);
      const [isolation, permissiveRows] = policies;
      expect(isolation?.permissive, `${table} tenant_isolation`).toBe("RESTRICTIVE");
      expect(isolation?.cmd).toBe("ALL");
      expect(isolation?.roles).toEqual(["public"]);
      expect(isolation?.qual).not.toBeNull();
      expect(isolation?.with_check, `${table} qual and with_check`).toBe(isolation?.qual);
      expect(isolation?.qual).toContain("tenant_id");
      expect(isolation?.qual).toContain("app_tenant_default()");
      expect(permissiveRows?.permissive, `${table} tenant_rows`).toBe("PERMISSIVE");
      expect(permissiveRows?.cmd).toBe("ALL");
      expect(permissiveRows?.roles).toEqual(["public"]);
      expect(permissiveRows?.qual).toBe("true");
      expect(permissiveRows?.with_check).toBe("true");
    }
  });

  it("keeps the runtime roles non-privileged, table-less owners with no grant on any items partition", async () => {
    await resetDatabase(pool);
    await createChokePoint(pool).createDatabase({ name: "Tenancy catalog runtime roles" });
    for (const role of ["semprec_data", "semprec_side"]) {
      const attrs = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1`,
        [role],
      );
      expect(attrs.rows, role).toEqual([{ rolsuper: false, rolbypassrls: false }]);

      const owned = await pool.query<{ relname: string }>(
        `SELECT c.relname FROM pg_class c
          WHERE c.relnamespace = 'public'::regnamespace AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = $1)`,
        [role],
      );
      expect(owned.rows, `${role} owned relations`).toEqual([]);

      const partitions = await pool.query<{ relname: string; granted: boolean }>(
        `SELECT c.relname,
                has_table_privilege($1, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS granted
           FROM pg_class c
          WHERE c.relnamespace = 'public'::regnamespace AND c.relispartition AND c.relname LIKE 'items\\_p\\_%'`,
        [role],
      );
      expect(partitions.rows.length, "items partitions exist").toBeGreaterThan(0);
      expect(
        partitions.rows.filter((row) => row.granted).map((row) => row.relname),
        `${role} privileges on items partitions`,
      ).toEqual([]);
    }
  });

  /** Issue #974: unique checks ignore RLS, so every unique key on a tenant table leads with tenant_id. */
  it("gives every unique index on a tenant table a tenant-leading, surrogate or listed shape", async () => {
    const offenders = await listUniquenessViolations(pool);
    expect(
      offenders,
      `Unique indexes on tenant tables without a leading tenant_id: ${offenders.join("; ")}. ` +
        `Fix: lead the index with tenant_id, or list it in PERMANENT_EXCEPTIONS with a reason.`,
    ).toEqual([]);
  });

  it("names a unique index that lacks tenant_id", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      try {
        await client.query("CREATE UNIQUE INDEX tenancy_catalog_probe_uq ON databases (id, key)");
        expect(await listUniquenessViolations(client)).toEqual(["tenancy_catalog_probe_uq on databases (id, key)"]);
      } finally {
        await client.query("ROLLBACK");
      }
    } finally {
      client.release();
    }
    expect(await listUniquenessViolations(pool)).toEqual([]);
  });

  it("creates the tenant-leading and parent unique indexes with the listed columns and predicate", async () => {
    await resetDatabase(pool);
    await seedSystem(pool);
    const rows = await listUniqueIndexes(pool);
    for (const expected of NEW_UNIQUE_INDEXES) {
      const row = rows.find((candidate) => candidate.index_name === expected.name);
      expect(row, `${expected.name} exists`).toBeDefined();
      expect(row?.table_name, `${expected.name} table`).toBe(expected.table);
      expect(row?.columns, `${expected.name} columns`).toEqual(expected.columns);
      // pg_get_expr parenthesizes a compound predicate but not a bare column, so compare without parentheses.
      expect(row?.predicate?.replaceAll(/[()]/g, "") ?? null, `${expected.name} predicate`).toBe(expected.predicate);
    }
    expect(NEW_UNIQUE_INDEXES).toHaveLength(23);
  });

  it("keeps the legacy global keys beside the new ones", async () => {
    const rows = await listUniqueIndexes(pool);
    for (const legacy of LEGACY_GLOBAL_UNIQUES) {
      expect(
        rows.some((row) => sameKey(row, legacy)),
        `${legacy.table} (${legacy.columns.join(", ")})`,
      ).toBe(true);
    }
  });

  it("rejects a second system database for one module in a tenant but accepts a second non-system one", async () => {
    await resetDatabase(pool);
    const chokePoint = createChokePoint(pool);
    await chokePoint.createDatabase({ name: "System one", ownerModuleId: "tenancyProbe", system: true });
    await chokePoint.createDatabase({ name: "Plain one", ownerModuleId: "tenancyProbe" });
    await chokePoint.createDatabase({ name: "Plain two", ownerModuleId: "tenancyProbe" });
    await expect(
      chokePoint.createDatabase({ name: "System two", ownerModuleId: "tenancyProbe", system: true }),
    ).rejects.toMatchObject({ code: "23505", constraint: "databases_tenant_system_module_uq" });
  });
});
