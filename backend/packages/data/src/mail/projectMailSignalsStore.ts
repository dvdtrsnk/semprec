import type { PoolClient } from "pg";
import { z } from "zod";
import { requireSingleRow, type Queryable } from "../db/pool.js";

/** A project's own mail signals, normalized: lower-case hosts and addresses, trimmed keywords, no duplicates. */
export interface MailSignalSet {
  domains: string[];
  addresses: string[];
  keywords: string[];
}

export interface StoredMailSignals extends MailSignalSet {
  updatedAt: string;
}

const storedRow = z.object({
  project_item_id: z.uuid(),
  domains: z.array(z.string()),
  addresses: z.array(z.string()),
  keywords: z.array(z.string()),
  updated_at: z.date(),
});

function mapRow(row: z.infer<typeof storedRow>): StoredMailSignals {
  return {
    domains: row.domains,
    addresses: row.addresses,
    keywords: row.keywords,
    updatedAt: row.updated_at.toISOString(),
  };
}

/** `share` holds the row against a concurrent replace until the transaction ends. */
export async function readProjectMailSignals(
  client: Queryable,
  projectItemId: string,
  lock: "none" | "share" = "none",
): Promise<StoredMailSignals | null> {
  // The lock clause is one of two fixed fragments chosen by the typed `lock`.
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT project_item_id, domains, addresses, keywords, updated_at FROM project_mail_signals
      WHERE tenant_id = app_tenant_default() AND project_item_id = $1${lock === "share" ? " FOR SHARE" : ""}`,
    [projectItemId],
  );
  return rows[0] ? mapRow(storedRow.parse(rows[0])) : null;
}

/** The signal rows of the given projects; a project without a row is absent. */
export async function listProjectMailSignals(
  client: Queryable,
  projectItemIds: readonly string[],
): Promise<Map<string, StoredMailSignals>> {
  if (projectItemIds.length === 0) return new Map();
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT project_item_id, domains, addresses, keywords, updated_at FROM project_mail_signals
      WHERE tenant_id = app_tenant_default() AND project_item_id = ANY($1::uuid[])`,
    [projectItemIds],
  );
  return new Map(
    rows.map((raw) => {
      const row = storedRow.parse(raw);
      return [row.project_item_id, mapRow(row)] as const;
    }),
  );
}

/**
 * The one writer of `project_mail_signals`: replaces the project's signals with an already normalized set. The caller
 * has checked that the project is a live Projects item and holds it locked.
 */
export async function replaceProjectMailSignals(
  client: PoolClient,
  projectItemId: string,
  signals: MailSignalSet,
): Promise<StoredMailSignals> {
  const { rows } = await client.query<Record<string, unknown>>(
    `INSERT INTO project_mail_signals (project_item_id, domains, addresses, keywords, updated_at)
     VALUES ($1, $2::text[], $3::text[], $4::text[], now())
     ON CONFLICT (tenant_id, project_item_id) DO UPDATE SET
       domains = EXCLUDED.domains, addresses = EXCLUDED.addresses, keywords = EXCLUDED.keywords, updated_at = now()
     RETURNING project_item_id, domains, addresses, keywords, updated_at`,
    [projectItemId, signals.domains, signals.addresses, signals.keywords],
  );
  return mapRow(storedRow.parse(requireSingleRow(rows, "project_mail_signals row")));
}
