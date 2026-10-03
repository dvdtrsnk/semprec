import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";

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
});
