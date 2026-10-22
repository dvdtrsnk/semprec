import type { Pool, QueryResult } from "pg";
import { withTransaction } from "../db/pool.js";
import { forEachActiveTenant } from "../tenancy/forEachActiveTenant.js";
import { reencryptCredentialUnderTenantKey } from "./externalCredentialsStore.js";
import { logger } from "./logger.js";

const PAGE_SIZE = 100;
const MAX_PAGES_PER_RUN = 50;

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
 * and the job is retried. Once no `master` row remains the sweep is a no-op.
 */
export async function handleCredentialReencryptSweepTask(pool: Pool): Promise<void> {
  await forEachActiveTenant(pool, async (tenantId) => {
    let reencrypted = 0;
    let failed = 0;
    let after: string | null = null;
    for (let page = 0; page < MAX_PAGES_PER_RUN; page += 1) {
      const { rows }: QueryResult<{ item_id: string }> = await pool.query<{ item_id: string }>(
        `SELECT item_id FROM external_credentials
          WHERE scheme = 'master' AND tenant_id = app_tenant_default() AND ($1::uuid IS NULL OR item_id > $1)
          ORDER BY item_id LIMIT $2`,
        [after, PAGE_SIZE],
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
      if (last === undefined || rows.length < PAGE_SIZE) break;
      after = last;
    }
    logger.info({ tenantId, reencrypted }, "Credential re-encryption sweep finished for tenant");
    if (failed > 0) {
      throw new Error(`credentialReencryptSweep: ${failed} credential(s) failed to re-encrypt in this tenant`);
    }
  });
}
