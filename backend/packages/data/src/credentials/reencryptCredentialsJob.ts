import type { Pool, QueryResult } from "pg";
import { withTransaction } from "../db/pool.js";
import { forEachActiveTenant } from "../tenancy/forEachActiveTenant.js";
import { reencryptCredentialUnderTenantKey } from "./externalCredentialsStore.js";
import { logger } from "./logger.js";

/** Page size and per-run page cap of the sweep; the defaults are the issue's 100 and 50. */
export interface CredentialReencryptSweepLimits {
  pageSize: number;
  maxPagesPerRun: number;
}

const DEFAULT_LIMITS: CredentialReencryptSweepLimits = { pageSize: 100, maxPagesPerRun: 50 };

/**
 * The hourly `credentialReencryptSweep` (issue #1062), wired into `createCoreTaskList` (`worker.ts`)
 * and `CORE_CRONTAB`. For every active tenant, inside that tenant's scope, it reads keyset pages of
 * up to 100 `master` credential item ids (at most 50 pages per run) and re-seals each row under the
 * tenant's data key with `reencryptCredentialUnderTenantKey`, one transaction per row, so a row that
 * cannot be decrypted rolls back only itself. The keyset advances past a failed row, so this run
 * does not retry it.
 *
 * A failed row is logged with its item id and the error, and the sweep continues; the error comes
 * from decryption, key resolution or the database and carries no ciphertext or plaintext. After a
 * tenant's pages, a tenant with failed rows throws, so `forEachActiveTenant` aggregates the failure
 * and the job is retried. Once no `master` row remains the sweep is a no-op. Rows past the page cap
 * are left `master` for the next run, which continues from the first of them.
 *
 * `limits` exists for tests only, so the page cap can be reached with a handful of rows; the worker
 * always runs with the defaults.
 */
export async function handleCredentialReencryptSweepTask(
  pool: Pool,
  limits: CredentialReencryptSweepLimits = DEFAULT_LIMITS,
): Promise<void> {
  await forEachActiveTenant(pool, async (tenantId) => {
    let reencrypted = 0;
    let failed = 0;
    let after: string | null = null;
    for (let page = 0; page < limits.maxPagesPerRun; page += 1) {
      const { rows }: QueryResult<{ item_id: string }> = await pool.query<{ item_id: string }>(
        `SELECT item_id FROM external_credentials
          WHERE scheme = 'master' AND tenant_id = app_tenant_default() AND ($1::uuid IS NULL OR item_id > $1)
          ORDER BY item_id LIMIT $2`,
        [after, limits.pageSize],
      );
      for (const { item_id: itemId } of rows) {
        try {
          if (await withTransaction(pool, (client) => reencryptCredentialUnderTenantKey(client, itemId))) {
            reencrypted += 1;
          }
        } catch (err) {
          logger.error({ itemId, err }, "Re-encrypting a credential under its tenant key failed");
          failed += 1;
        }
      }
      const last: string | undefined = rows.at(-1)?.item_id;
      if (last === undefined || rows.length < limits.pageSize) break;
      after = last;
    }
    logger.info({ tenantId, reencrypted }, "Credential re-encryption sweep finished for tenant");
    if (failed > 0) {
      throw new Error(`credentialReencryptSweep: ${failed} credential(s) failed to re-encrypt in this tenant`);
    }
  });
}
