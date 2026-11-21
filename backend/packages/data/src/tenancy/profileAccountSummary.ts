// Assembles the profile screen's account summary by calling each figure's owning function; it counts
// nothing itself.
import type { Pool } from "pg";
import { currentTenantScope } from "@semprec/shared";
import { getAiUsageSummary } from "../aiGateway/aiUsageSummary.js";
import { listActiveSessionsForUser } from "../auth/sessionsStore.js";
import { withTransaction } from "../db/pool.js";
import { getMailAccountsSummary } from "../mail/mailSummary.js";
import { readSempStatusSummary } from "../semp/sempStatusSummary.js";
import { countArchivedTrashDatabases, countTrashItemRoots } from "../trash/trashRouteHandlers.js";

/** `GET /api/account/summary`. */
export interface ProfileAccountSummary {
  /** The caller's own unrevoked, unexpired sessions: the length of `GET /api/auth/sessions`. */
  activeSessions: number;
  /** `accounts` of `GET /api/mail/summary`. */
  mailAccountCount: number;
  /** `accountsNeedingReauth` of `GET /api/mail/summary`. */
  mailAccountsNeedingReauth: Array<{ id: string; name: string }>;
  /** `totalCount` of `GET /api/trash/items`. */
  trashItems: number;
  /** `totalCount` of `GET /api/trash/databases`. */
  trashDatabases: number;
  /** `activeCount` of `GET /api/semp-status/summary`. */
  problemCount: number;
  /** `spentMonthUsd` of `GET /api/ai-usage/summary`. */
  aiCostMonthUsd: number;
}

export interface ProfileAccountSummaryInput {
  /** From the session, never from a request. */
  userId: string;
}

/**
 * Every figure comes from the function its owner's route calls (for trash, the statement the list reads
 * its `totalCount` with). One REPEATABLE READ transaction on one connection reads them all, so every figure,
 * like the two trash totals each trash list reads together, comes from the same snapshot; any failed read fails
 * the call, never a partial summary.
 *
 * Throws without a tenant scope, so an unscoped call never looks like an empty tenant.
 */
export async function getProfileAccountSummary(
  pool: Pool,
  input: ProfileAccountSummaryInput,
): Promise<ProfileAccountSummary> {
  if (currentTenantScope()?.kind !== "tenant") {
    throw new Error("getProfileAccountSummary requires an active tenant scope");
  }
  return withTransaction(
    pool,
    async (client) => {
      const sessions = await listActiveSessionsForUser(client, input.userId);
      const mail = await getMailAccountsSummary(client);
      const trashItems = await countTrashItemRoots(client);
      const trashDatabases = await countArchivedTrashDatabases(client);
      const semp = await readSempStatusSummary(client);
      const aiUsage = await getAiUsageSummary(client);
      return {
        activeSessions: sessions.length,
        mailAccountCount: mail.accounts,
        mailAccountsNeedingReauth: mail.accountsNeedingReauth,
        trashItems,
        trashDatabases,
        problemCount: semp.activeCount,
        aiCostMonthUsd: aiUsage.spentMonthUsd,
      };
    },
    { isolation: "repeatable_read" },
  );
}
