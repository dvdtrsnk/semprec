import type { Pool } from "pg";
import { z } from "zod";
import { runAsSystem } from "@semprec/shared";

const verdictSchema = z.object({ covered: z.boolean(), consistent: z.boolean() }).strict();

/** Checks snapshot tombstones and contradictions against an already validated replay ledger. */
export async function validateRestoreLedger(pool: Pool, tenantIds: readonly string[]): Promise<void> {
  const result = await runAsSystem("restoreLedgerValidation", () =>
    pool.query<Record<string, unknown>>(
      `SELECT NOT EXISTS (
         SELECT 1 FROM public.tenant_deletions d WHERE NOT (d.tenant_id = ANY($1::uuid[]))
       ) AS covered,
       NOT EXISTS (
         SELECT 1 FROM public.tenant_deletions d JOIN public.tenants t ON t.id = d.tenant_id
       ) AS consistent`,
      [tenantIds],
    ),
  );
  if (result.rows.length !== 1) throw new Error("Restore ledger validation failed");
  const verdict = verdictSchema.parse(result.rows[0]);
  if (!verdict.covered || !verdict.consistent) throw new Error("Restore ledger validation failed");
}
