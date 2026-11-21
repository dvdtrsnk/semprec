// The lock an account's calendar sync apply, its cleanup chunks, the Calendars switch and the account's removal take
// before any row lock, so that none of them runs while another does.
import type { PoolClient } from "pg";
import { lockTenantAdvisoryGuard } from "../../db/tenantAdvisoryGuard.js";
import { ChokePointError } from "../../errors.js";

/** The database has aborted the caller's transaction, so it must roll back; the request can be repeated. */
export class CalendarAccountSyncBusyError extends ChokePointError {
  constructor() {
    super(409, "calendar_sync_busy", "The account's calendars are being synchronized; try again shortly");
    this.name = "CalendarAccountSyncBusyError";
  }
}

const CALENDAR_ACCOUNT_SYNC_GUARD = {
  label: "calendar account sync",
  namespace: "calendar-account-sync:v1",
  busy: () => new CalendarAccountSyncBusyError(),
};

/**
 * Held until the caller's transaction ends; requires a READ COMMITTED tenant transaction. A wait longer than
 * `maxWaitMs` aborts the transaction with `CalendarAccountSyncBusyError`; without it only the statement timeout
 * bounds the wait.
 */
export async function lockCalendarAccountSync(
  client: PoolClient,
  accountItemId: string,
  options: { maxWaitMs?: number } = {},
): Promise<void> {
  await lockTenantAdvisoryGuard(client, CALENDAR_ACCOUNT_SYNC_GUARD, accountItemId, options);
}
