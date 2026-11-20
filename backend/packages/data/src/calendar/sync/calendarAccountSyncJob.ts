// One calendar sync pass of an internet account: read the account and its tracked calendars, decrypt the credential,
// fetch through the adapter of its sync mode with no transaction open, then apply everything in one transaction.
import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import type { Pool } from "pg";
import { z } from "zod";
import { getTenantUserId } from "../../auth/usersStore.js";
import { getItemById } from "../../chokePoint/itemsStore.js";
import { getDecryptedCredential } from "../../credentials/externalCredentialsStore.js";
import { getMailServerSettings } from "../../mail/mailServerSettingsStore.js";
import { withTransaction } from "../../db/pool.js";
import { NotFoundError, ConflictError } from "../../errors.js";
import type { CustomRouteResult, RouteParams } from "../../customRoute.js";
import { defaultSyncModeForProvider, getMailAccountGrant } from "../../mail/mailAccountSyncStateStore.js";
import { areCalendarsEnabled } from "../../mail/mailboxServiceHooks.js";
import { hasCalendarConsent } from "../../mail/oauthServiceScopes.js";
import { MailReauthorizationRequiredError } from "../../mail/providerTypes.js";
import { raiseProblem } from "../../semp/sempProblemsStore.js";
import { calendarProblemKey } from "../../semp/sourceProblemKeys.js";
import { getSystemTimezone } from "../../systemSettings.js";
import { forEachActiveTenant } from "../../tenancy/forEachActiveTenant.js";
import { assertValidTimezone } from "../../timezone.js";
import { logger } from "../logger.js";
import {
  CalendarSyncConsentRequiredError,
  CalendarSyncProviderError,
  CalendarSyncReauthorizationRequiredError,
  type CalendarSyncAdapterRegistry,
  type CalendarSyncWindow,
} from "./adapter.js";
import { CALENDAR_SYNC_ADAPTERS } from "./adapters/index.js";
import { CalendarAccountSyncBusyError, lockCalendarAccountSync } from "./calendarAccountSyncGuard.js";
import { enqueueCalendarAccountSync } from "./calendarAccountSyncEnqueue.js";
import {
  applyCalendarSync,
  parseCalendarChanges,
  parseRemoteCalendars,
  trackedCalendarsSnapshot,
  type CalendarSyncApplyResult,
  type FetchedCalendar,
} from "./calendarSyncApply.js";
import {
  listCalendarAccountsDueForSync,
  listSyncedAccountCalendars,
  recordCalendarSyncFailure,
  recordManualCalendarSyncRequest,
  resolveCalendarSyncIds,
  type CalendarSyncFailureStatus,
} from "./calendarSyncStore.js";

export { enqueueCalendarAccountSync, calendarAccountSyncJobKey } from "./calendarAccountSyncEnqueue.js";

/** The deadline of every adapter call of one pass together. */
const CALENDAR_SYNC_PASS_TIMEOUT_MS = 5 * 60_000;
/** How long the apply and the failure record wait for the account's guard before the pass is skipped. */
const CALENDAR_SYNC_GUARD_WAIT_MS = 5_000;
/** A pass that ended `ok` this long ago is due again; the sweep runs every five minutes. */
const CALENDAR_SYNC_DUE_AFTER_SECONDS = 4 * 60;
/** Manual sync requests of one account closer together than this queue one pass. */
export const MANUAL_CALENDAR_SYNC_DEBOUNCE_SECONDS = 60;

const payloadSchema = z.strictObject({ accountItemId: z.uuid() });

/** The first sync's days: one year back to two years ahead of today in the tenant's zone. */
function syncWindow(zone: string, at: Date): CalendarSyncWindow {
  const today = DateTime.fromJSDate(at, { zone }).startOf("day");
  return { start: today.minus({ years: 1 }).toISODate() ?? "", end: today.plus({ years: 2 }).toISODate() ?? "" };
}

interface FailureRecord {
  status: CalendarSyncFailureStatus;
  code: string;
}

/** The stored status and code of a failed pass; the code is a fixed identifier, never provider text. */
function failureRecordOf(error: unknown, signal: AbortSignal): FailureRecord {
  if (error instanceof CalendarSyncReauthorizationRequiredError || error instanceof MailReauthorizationRequiredError) {
    return { status: "needsReauthorization", code: "reauthorizationRequired" };
  }
  if (error instanceof CalendarSyncConsentRequiredError) return { status: "needsConsent", code: "consentRequired" };
  if (error instanceof CalendarSyncProviderError) return { status: "error", code: error.code };
  if (signal.aborted) return { status: "error", code: "timeout" };
  return { status: "error", code: "unexpected" };
}

export interface CalendarAccountSyncOptions {
  adapters?: CalendarSyncAdapterRegistry;
  /** graphile-worker's per-attempt job id, so a redelivered failure adds no Semp problem occurrence. */
  jobId?: string;
  passTimeoutMs?: number;
}

/**
 * `null` when the pass did nothing: the account is gone, trashed or has Calendars off, its grant lacks calendar
 * access, or another apply held the account. Otherwise the apply's result, whose `added`, `changed` and `cancelled`
 * lists are where notifications of synced Events hook in.
 *
 * A failure is recorded under the account's guard in its own transaction (status, failure streak, the account's
 * Semp problem `calendarSyncError`) and leaves the calendars and Events as they were. A provider or unexpected
 * failure is rethrown so the queue retries it; a refused credential or a missing grant is not, since only the user
 * can change it.
 */
export async function handleCalendarAccountSyncTask(
  pool: Pool,
  payload: unknown,
  options: CalendarAccountSyncOptions = {},
): Promise<CalendarSyncApplyResult | null> {
  const { accountItemId } = payloadSchema.parse(payload);
  const adapters = options.adapters ?? CALENDAR_SYNC_ADAPTERS;
  const prologue = await withTransaction(pool, async (client) => {
    const ids = await resolveCalendarSyncIds(client);
    if (ids === null) return null;
    const account = await getItemById(client, ids.mailboxesDatabaseId, accountItemId);
    if (!account || account.deletedAt || !areCalendarsEnabled(account.properties)) return null;
    const provider = typeof account.properties.provider === "string" ? account.properties.provider : null;
    const grant = await getMailAccountGrant(client, accountItemId);
    const syncMode = grant?.syncMode ?? defaultSyncModeForProvider(provider ?? "");
    if (!hasCalendarConsent({ syncMode, grantedScopes: grant?.grantedScopes ?? null })) return null;
    const zone = await getSystemTimezone(client);
    assertValidTimezone(zone);
    const addresses = typeof account.properties.addresses === "string" ? account.properties.addresses : "";
    return {
      ids,
      provider,
      syncMode,
      primaryAddress:
        addresses
          .split(/[\n,\r]+/)
          .map((value) => value.trim())
          .find(Boolean) ?? null,
      tracked: await listSyncedAccountCalendars(client, ids, accountItemId),
      serverSettings: await getMailServerSettings(client, accountItemId),
      window: syncWindow(zone, new Date()),
    };
  });
  if (prologue === null) {
    logger.info({ accountItemId }, "Calendar sync skipped: the account has Calendars off, is gone or lacks consent");
    return null;
  }

  const signal = AbortSignal.timeout(options.passTimeoutMs ?? CALENDAR_SYNC_PASS_TIMEOUT_MS);
  try {
    const factory = adapters[prologue.syncMode];
    if (factory === undefined) throw new Error(`No calendar adapter configured for sync mode ${prologue.syncMode}`);
    // Uses `pool`: the access-log insert commits on its own, so a decrypt failure stays logged.
    const credential = await getDecryptedCredential(pool, {
      itemId: accountItemId,
      actorType: "sync_worker",
      purpose: "calendar_sync",
    });
    if (credential === null) throw new CalendarSyncReauthorizationRequiredError("The account has no stored credential");
    const adapter = factory({
      accountItemId,
      provider: prologue.provider,
      syncMode: prologue.syncMode,
      primaryAddress: prologue.primaryAddress,
      credential,
      serverSettings: prologue.serverSettings && {
        username: prologue.serverSettings.username,
        caldavUrl: prologue.serverSettings.caldavUrl,
      },
    });
    const cursors = new Map(prologue.tracked.map((calendar) => [calendar.remoteId, calendar]));
    const fetched: FetchedCalendar[] = [];
    for (const calendar of parseRemoteCalendars(await adapter.listCalendars(signal))) {
      const stored = cursors.get(calendar.remoteId);
      const cursor = stored ? { syncToken: stored.syncToken, ctag: stored.ctag } : null;
      const changes = parseCalendarChanges(
        await adapter.fetchChanges(calendar, cursor, { window: prologue.window, signal }),
      );
      fetched.push({ calendar, changes });
    }
    const result = await withTransaction(pool, (client) =>
      applyCalendarSync(client, {
        accountItemId,
        ids: prologue.ids,
        tracked: trackedCalendarsSnapshot(prologue.tracked),
        fetched,
        window: prologue.window,
        guardWaitMs: CALENDAR_SYNC_GUARD_WAIT_MS,
      }),
    );
    logger.info(
      {
        accountItemId,
        outcome: result.kind,
        ...(result.kind === "applied"
          ? {
              added: result.added.length,
              changed: result.changed.length,
              cancelled: result.cancelled.length,
              skippedEvents: result.skippedEvents,
            }
          : {}),
      },
      "Calendar sync pass finished",
    );
    return result;
  } catch (error) {
    // The running apply, a switch or a removal decides the account's state; this pass has nothing to record.
    if (error instanceof CalendarAccountSyncBusyError) {
      logger.info({ accountItemId }, "Calendar sync skipped: another pass or a switch holds the account");
      return null;
    }
    const failure = failureRecordOf(error, signal);
    // Provider errors can carry request details: only ids, the error's name and the fixed code are logged.
    logger.error(
      {
        accountItemId,
        syncMode: prologue.syncMode,
        errorName: error instanceof Error ? error.name : typeof error,
        ...failure,
      },
      "Calendar sync failed",
    );
    try {
      await recordFailure(pool, accountItemId, failure, options.jobId ?? randomUUID());
    } catch (recordError) {
      // The pass's own failure is what the caller must see.
      logger.error(
        { accountItemId, errorName: recordError instanceof Error ? recordError.name : typeof recordError },
        "Calendar sync could not record its failure",
      );
    }
    if (failure.status === "error") throw error;
    return null;
  }
}

/**
 * Under the account's guard, so it cannot recreate the state of an account whose Calendars were switched off or
 * which was removed meanwhile: then nothing is written. A held guard skips the record.
 */
async function recordFailure(pool: Pool, accountItemId: string, failure: FailureRecord, jobId: string): Promise<void> {
  await withTransaction(pool, async (client) => {
    try {
      await lockCalendarAccountSync(client, accountItemId, { maxWaitMs: CALENDAR_SYNC_GUARD_WAIT_MS });
    } catch (error) {
      if (error instanceof CalendarAccountSyncBusyError) return;
      throw error;
    }
    const ids = await resolveCalendarSyncIds(client);
    if (ids === null) return;
    const account = await getItemById(client, ids.mailboxesDatabaseId, accountItemId);
    if (!account || account.deletedAt || !areCalendarsEnabled(account.properties)) return;
    const failingSince = await recordCalendarSyncFailure(client, accountItemId, failure.status, failure.code);
    const userId = await getTenantUserId(client);
    if (!userId) return;
    await raiseProblem(client, {
      userId,
      category: "mail",
      kind: "calendarSyncError",
      severity: failure.status === "error" ? "warning" : "critical",
      sourceTable: "calendar_account_sync_state",
      sourceId: accountItemId,
      dedupeKey: calendarProblemKey(accountItemId),
      since: failingSince,
      occurrenceKey: jobId,
    });
  });
}

/** Enqueues a pass for every due account of every active tenant, each tenant in its own scope. */
export async function handleCalendarAccountSyncSweepTask(pool: Pool): Promise<void> {
  await forEachActiveTenant(pool, async () => {
    const due = await withTransaction(pool, (client) =>
      listCalendarAccountsDueForSync(client, CALENDAR_SYNC_DUE_AFTER_SECONDS),
    );
    for (const accountItemId of due) await enqueueCalendarAccountSync(pool, accountItemId);
  });
}

const accountIdSchema = z.uuid();
const accountRowSchema = z.object({ properties: z.record(z.string(), z.unknown()) });

/**
 * `POST /api/accounts/:id/calendars/sync`: queues a pass unless one was requested within the debounce window, and
 * answers 202 with whether this request queued it. The account row is read `FOR SHARE`, so a Calendars switch
 * commits before or after the request, never between its check and its record. Unknown, malformed, foreign and
 * trashed ids answer the same 404; Calendars off answers 409 `calendars_disabled`.
 */
export function createCalendarAccountSyncRouteHandler(pool: Pool) {
  return async (ctx: RouteParams): Promise<CustomRouteResult<{ id: string; queued: boolean }>> => {
    const parsed = accountIdSchema.safeParse(ctx.params.id);
    if (!parsed.success) throw new NotFoundError("Account not found");
    const accountItemId = parsed.data;
    const queued = await withTransaction(pool, async (client) => {
      const ids = await resolveCalendarSyncIds(client);
      if (ids === null) throw new NotFoundError("Account not found");
      const { rows } = await client.query<Record<string, unknown>>(
        "SELECT properties FROM items WHERE database_id = $1 AND id = $2 AND deleted_at IS NULL FOR SHARE",
        [ids.mailboxesDatabaseId, accountItemId],
      );
      if (rows[0] === undefined) throw new NotFoundError("Account not found");
      const account = accountRowSchema.parse(rows[0]);
      if (!areCalendarsEnabled(account.properties)) {
        throw new ConflictError(
          "Calendars are switched off for this account",
          { accountId: accountItemId },
          "calendars_disabled",
        );
      }
      const recorded = await recordManualCalendarSyncRequest(
        client,
        accountItemId,
        MANUAL_CALENDAR_SYNC_DEBOUNCE_SECONDS,
      );
      if (recorded) await enqueueCalendarAccountSync(client, accountItemId);
      return recorded;
    });
    return { status: 202, body: { id: accountItemId, queued } };
  };
}
