// Assembles the profile screen's account summary by calling each figure's owning function; it counts
// nothing itself.
import type { Pool } from "pg";
import { currentTenantScope } from "@semprec/shared";
import { getAiUsageSummary } from "../aiGateway/aiUsageSummary.js";
import { listActiveSessionsForUser } from "../auth/sessionsStore.js";
import { withTransaction } from "../db/pool.js";
import { getMailSummary } from "../mail/mailSummary.js";
import { getSempStatusSummary } from "../semp/sempStatusSummary.js";
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
 * its `totalCount` with). The reads run concurrently on separate connections, so figures may be read at
 * slightly different moments; any failed read fails the call, never a partial summary.
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
  const [sessions, mail, trash, semp, aiUsage] = await Promise.all([
    listActiveSessionsForUser(pool, input.userId),
    withTransaction(pool, (client) => getMailSummary(client)),
    // One snapshot for both trash totals, as each trash list reads its own total in a REPEATABLE READ transaction.
    withTransaction(
      pool,
      async (client) => ({
        items: await countTrashItemRoots(client),
        databases: await countArchivedTrashDatabases(client),
      }),
      { isolation: "repeatable_read" },
    ),
    getSempStatusSummary(pool),
    withTransaction(pool, (client) => getAiUsageSummary(client)),
  ]);
  return {
    activeSessions: sessions.length,
    mailAccountCount: mail.accounts,
    mailAccountsNeedingReauth: mail.accountsNeedingReauth,
    trashItems: trash.items,
    trashDatabases: trash.databases,
    problemCount: semp.activeCount,
    aiCostMonthUsd: aiUsage.spentMonthUsd,
  };
}
