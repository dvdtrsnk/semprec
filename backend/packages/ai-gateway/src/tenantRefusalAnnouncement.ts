import type { Pool } from "pg";
import {
  enqueueAiBudgetReset,
  getAiWindowResetInstant,
  getSystemTimezone,
  publishSempStatusInvalidationAndWait,
} from "@semprec/data";
import { runInTenant } from "@semprec/shared";
import { AnnouncementLedger } from "./announcementLedger.js";
import { logger } from "./logger.js";

/**
 * The window a refusal that the tenant's own state caused belongs to: `noBudget` for a tenant without a
 * `tenant_ai_budgets` row, and otherwise the exhausted window of the budget summary (gh-1456), where
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
 * Announces, once per tenant and window, that a call was refused because of the tenant's own budget
 * state (docs/adr/2026-11-13-the-gateway-announces-a-tenants-first-budget-refusal-of-a-window.md): one
 * Semp status invalidation of the tenant, and for an exhausted cap window one `aiBudgetReset` job that
 * repeats the invalidation at the instant the window resets. It runs after the refusal's transaction has
 * rolled back and never rejects: a failure is logged with the tenant id and the error's name, and the
 * window is then announced again by its next refusal.
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
