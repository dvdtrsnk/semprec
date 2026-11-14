// Owns the assembly of the profile screen's account summary: one read that calls the figure-owning function of each
// module and counts nothing itself. It does not own any of those figures (sessions, mail accounts, trash, Semp
// problems, AI spend), the route that serves it, or the invalidation of the summary.
import type { Pool } from "pg";
import { currentTenantScope } from "@semprec/shared";
import { getAiUsageSummary } from "../aiGateway/aiUsageSummary.js";
import { listActiveSessionsForUser } from "../auth/sessionsStore.js";
import { withTransaction } from "../db/pool.js";
import { getMailSummary } from "../mail/mailSummary.js";
import { getSempStatusSummary } from "../semp/sempStatusSummary.js";
import { countArchivedTrashDatabases, countTrashItemRoots } from "../trash/trashRouteHandlers.js";

/** What `GET /api/account/summary` answers (issue gh-1903). */
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
  /** The signed-in user, whose sessions are counted. It comes from the session, never from a request. */
  userId: string;
}

/**
 * The profile summary of the tenant in scope for `input.userId`. Every figure is the result of the function its
 * owner's own route calls (or, for the trash totals, of the statement the list reads its `totalCount` with). The
 * reads are independent, so they run concurrently, each on its own connection of `pool`; two figures may therefore be
 * read at slightly different moments, but the answer is one object: when any read fails, the call fails and no
 * partial summary is returned.
 *
 * It throws without a tenant scope, so an unscoped call can never look like an empty tenant.
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
