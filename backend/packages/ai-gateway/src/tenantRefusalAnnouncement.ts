import type { Pool } from "pg";
import {
  enqueueAiBudgetReset,
  getAiWindowResetInstant,
  getSystemTimezone,
  publishSempStatusInvalidationAndWait,
} from "@alldots/data";
import { runInTenant } from "@alldots/shared";
import { AnnouncementLedger } from "./announcementLedger.js";
import { logger } from "./logger.js";

/**
 * The window a refusal that the tenant's own state caused belongs to: `noBudget` for a tenant without a
 * `tenant_ai_budgets` row, and otherwise the exhausted window of the budget summary, where
 * `monthly` wins over `daily` as it does for the Semp status.
 */
export type TenantRefusalWindow = "noBudget" | "daily" | "monthly";

/** What `assertWithinBudget` knows about a refusal caused by the tenant's own state. */
export interface TenantRefusalNotice {
  /** The tenant of the active scope that the refused call ran in. */
  tenantId: string;
  window: TenantRefusalWindow;
  /** The tenant's timezone when the refusal already read it, otherwise `null`. */
  timezone: string | null;
}

const ledger = new AnnouncementLedger();

/**
 * Announces once per tenant and window that a call was refused by the tenant's own budget state: one
 * Semp status invalidation, and for an exhausted cap window an `aiBudgetReset` job that repeats it
 * when the window resets. Runs after the refusal's transaction rolled back and never rejects: a
 * failure is logged (tenant id and error name) and the window is announced again on its next refusal.
 */
export async function announceTenantRefusal(pool: Pool, notice: TenantRefusalNotice): Promise<void> {
  try {
    await runInTenant(notice.tenantId, () => announceInScope(pool, notice));
  } catch (err) {
    logFailure(notice.tenantId, err, "AI gateway could not look up the budget window of a refused call");
  }
}

async function announceInScope(pool: Pool, notice: TenantRefusalNotice): Promise<void> {
  const timezone = notice.timezone ?? (await getSystemTimezone(pool));
  const key = `${notice.tenantId}|${notice.window}|${timezone}`;
  if (ledger.isAnnounced(key, Date.now())) return;

  const windowEndsAt = await getAiWindowResetInstant(pool, timezone, notice.window === "monthly" ? "monthly" : "daily");
  if (!ledger.claim(key, windowEndsAt.getTime(), Date.now())) return;

  const published = await attempt(notice.tenantId, "AI gateway could not publish the Semp status invalidation", () =>
    publishSempStatusInvalidationAndWait(),
  );
  // A missing budget row has no reset time: only an exhausted cap window schedules the job.
  const scheduled =
    notice.window === "noBudget" ||
    (await attempt(notice.tenantId, "AI gateway could not schedule the budget reset job", () =>
      enqueueAiBudgetReset(pool, windowEndsAt),
    ));
  if (!published || !scheduled) ledger.release(key);
}

/** Runs one announcement step; a failure is logged and reported as `false`, never thrown. */
async function attempt(tenantId: string, message: string, step: () => void | Promise<void>): Promise<boolean> {
  try {
    await step();
    return true;
  } catch (err) {
    logFailure(tenantId, err, message);
    return false;
  }
}

/** Logs the tenant id and the error's name only: a message or property of the error may carry content. */
function logFailure(tenantId: string, err: unknown, message: string): void {
  logger.error({ tenantId, errorName: err instanceof Error ? err.name : typeof err }, message);
}
