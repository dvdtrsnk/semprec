// One calendar sync pass of an internet account: read the account and its tracked calendars, decrypt the credential,
// fetch through the adapter of its sync mode with no transaction open, then apply in bounded transactions.
import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { getTenantUserId } from "../../auth/usersStore.js";
import { getItemById } from "../../chokePoint/itemsStore.js";
import { getDecryptedCredential } from "../../credentials/externalCredentialsStore.js";
import { getMailServerSettings, recordResolvedCalDavUrl } from "../../mail/mailServerSettingsStore.js";
import { requireSingleRow, withSavepoint, withTransaction } from "../../db/pool.js";
import { NotFoundError, ConflictError } from "../../errors.js";
import type { CustomRouteResult, RouteParams } from "../../customRoute.js";
import {
  defaultSyncModeForProvider,
  getMailAccountGrant,
  type SyncMode,
} from "../../mail/mailAccountSyncStateStore.js";
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
  type CalendarSyncAdapter,
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
  listEventRemoteRefs,
  listSyncedAccountCalendars,
  recordCalendarSyncFailure,
  recordManualCalendarSyncRequest,
  resolveCalendarSyncIds,
  type CalendarSyncFailureStatus,
  type CalendarSyncIds,
  type ManualCalendarSyncSchedule,
} from "./calendarSyncStore.js";

export { enqueueCalendarAccountSync, calendarAccountSyncJobKey } from "./calendarAccountSyncEnqueue.js";

/** The deadline of every adapter call of one pass together. */
const CALENDAR_SYNC_PASS_TIMEOUT_MS = 5 * 60_000;
/** How long each apply step and the failure record wait for the account's guard before the pass is skipped. */
const CALENDAR_SYNC_GUARD_WAIT_MS = 5_000;
/** A pass that ended `ok` this long ago is due again; the sweep runs every five minutes. */
const CALENDAR_SYNC_DUE_AFTER_SECONDS = 4 * 60;
/** Manual sync requests of one account closer together than this queue one pass. */
export const MANUAL_CALENDAR_SYNC_DEBOUNCE_SECONDS = 15;

const payloadSchema = z.strictObject({ accountItemId: z.uuid() });

/** The first sync's days: one year back to two years ahead of today in the tenant's zone. */
export function syncWindow(zone: string, at: Date): CalendarSyncWindow {
  const today = DateTime.fromJSDate(at, { zone }).startOf("day");
  return { start: today.minus({ years: 1 }).toISODate() ?? "", end: today.plus({ years: 2 }).toISODate() ?? "" };
}

export interface FailureRecord {
  status: CalendarSyncFailureStatus;
  code: string;
}

/** The stored status and code of a failed pass; the code is a fixed identifier, never provider text. */
export function failureRecordOf(error: unknown, signal: AbortSignal): FailureRecord {
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
  /** Event operations per apply batch. */
  batchEvents?: number;
  /** Called after each committed apply batch; tests end a pass between batches through it. */
  afterBatch?: (batch: number) => Promise<void> | void;
}

/**
 * `null` when the pass did nothing more: the account is gone, trashed or has Calendars off, its grant lacks calendar
 * access, or another apply step held the account's guard. Otherwise the apply's result, whose `added`, `changed` and
 * `cancelled` lists are where notifications of synced Events hook in.
 *
 * A failure is recorded under the account's guard in its own transaction (status, failure streak, the account's
 * Semp problem `calendarSyncError`). A failed fetch leaves the calendars and Events as they were; a failure between
 * apply batches keeps the committed batches and the old cursors, so the next pass applies the rest. A provider or
 * unexpected failure is rethrown so the queue retries it; a refused credential or a missing grant is not, since only
 * the user can change it.
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
    const account = await readCalendarSyncAccount(client, ids, accountItemId);
    if (account === null) return null;
    const tracked = await listSyncedAccountCalendars(client, ids, accountItemId);
    return {
      ids,
      account,
      syncMode: account.syncMode,
      tracked,
      known: await listEventRemoteRefs(
        client,
        tracked.map((calendar) => calendar.calendarItemId),
      ),
      window: syncWindow(account.tenantTimeZone, new Date()),
    };
  });
  if (prologue === null) {
    logger.info({ accountItemId }, "Calendar sync skipped: the account has Calendars off, is gone or lacks consent");
    return null;
  }

  const signal = AbortSignal.timeout(options.passTimeoutMs ?? CALENDAR_SYNC_PASS_TIMEOUT_MS);
  try {
    const adapter = await openCalendarSyncAdapter(pool, prologue.account, adapters);
    const cursors = new Map(prologue.tracked.map((calendar) => [calendar.remoteId, calendar]));
    const fetched: FetchedCalendar[] = [];
    const calendars = parseRemoteCalendars(await adapter.listCalendars(signal));
    const delegatedServerUrl = adapter.delegatedServerUrl?.() ?? null;
    if (delegatedServerUrl !== null) {
      // Stored before the Events, whose addresses are on that server: every later pass and push starts there.
      await withTransaction(pool, (client) => recordResolvedCalDavUrl(client, accountItemId, delegatedServerUrl));
    }
    for (const calendar of calendars) {
      const stored = cursors.get(calendar.remoteId);
      const cursor = stored ? { syncToken: stored.syncToken, ctag: stored.ctag } : null;
      const known = stored ? (prologue.known.get(stored.calendarItemId) ?? []) : [];
      const changes = parseCalendarChanges(
        await adapter.fetchChanges(calendar, cursor, { window: prologue.window, signal, known }),
      );
      fetched.push({ calendar, changes });
    }
    const result = await applyCalendarSync(pool, {
      accountItemId,
      ids: prologue.ids,
      tracked: trackedCalendarsSnapshot(prologue.tracked),
      fetched,
      window: prologue.window,
      guardWaitMs: CALENDAR_SYNC_GUARD_WAIT_MS,
      ...(options.batchEvents === undefined ? {} : { batchEvents: options.batchEvents }),
      ...(options.afterBatch === undefined ? {} : { afterBatch: options.afterBatch }),
    });
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
      await recordCalendarAccountFailure(pool, accountItemId, failure, options.jobId ?? randomUUID());
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

/** What opening an account's calendar adapter needs, read in a tenant transaction. */
export interface CalendarSyncAccountContext {
  accountItemId: string;
  provider: string | null;
  syncMode: SyncMode;
  primaryAddress: string | null;
  serverSettings: { username: string; caldavUrl: string | null } | null;
  tenantTimeZone: string;
}

/** `null` when the account is gone, trashed, has Calendars off, or its OAuth grant lacks the calendar scope. */
export async function readCalendarSyncAccount(
  client: PoolClient,
  ids: CalendarSyncIds,
  accountItemId: string,
): Promise<CalendarSyncAccountContext | null> {
  const account = await getItemById(client, ids.mailboxesDatabaseId, accountItemId);
  if (!account || account.deletedAt || !areCalendarsEnabled(account.properties)) return null;
  const provider = typeof account.properties.provider === "string" ? account.properties.provider : null;
  const grant = await getMailAccountGrant(client, accountItemId);
  const syncMode = grant?.syncMode ?? defaultSyncModeForProvider(provider ?? "");
  if (!hasCalendarConsent({ syncMode, grantedScopes: grant?.grantedScopes ?? null })) return null;
  const zone = await getSystemTimezone(client);
  assertValidTimezone(zone);
  const addresses = typeof account.properties.addresses === "string" ? account.properties.addresses : "";
  const serverSettings = await getMailServerSettings(client, accountItemId);
  return {
    accountItemId,
    provider,
    syncMode,
    primaryAddress:
      addresses
        .split(/[\n,\r]+/)
        .map((value) => value.trim())
        .find(Boolean) ?? null,
    serverSettings: serverSettings && { username: serverSettings.username, caldavUrl: serverSettings.caldavUrl },
    tenantTimeZone: zone,
  };
}

/**
 * Decrypts the account's credential (`calendar_sync` in `credential_access_log`) and builds the adapter of its sync
 * mode; call it with no transaction open. No stored credential is `CalendarSyncReauthorizationRequiredError`.
 */
export async function openCalendarSyncAdapter(
  pool: Pool,
  account: CalendarSyncAccountContext,
  adapters: CalendarSyncAdapterRegistry,
): Promise<CalendarSyncAdapter> {
  const factory = adapters[account.syncMode];
  if (factory === undefined) throw new Error(`No calendar adapter configured for sync mode ${account.syncMode}`);
  // Uses `pool`: the access-log insert commits on its own, so a decrypt failure stays logged.
  const credential = await getDecryptedCredential(pool, {
    itemId: account.accountItemId,
    actorType: "sync_worker",
    purpose: "calendar_sync",
  });
  if (credential === null) throw new CalendarSyncReauthorizationRequiredError("The account has no stored credential");
  return factory({ ...account, credential });
}

/**
 * Under the account's guard, so it cannot recreate the state of an account whose Calendars were switched off or
 * which was removed meanwhile: then nothing is written. A held guard skips the record.
 */
export async function recordCalendarAccountFailure(
  pool: Pool,
  accountItemId: string,
  failure: FailureRecord,
  occurrenceKey: string,
): Promise<void> {
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
      occurrenceKey,
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

/** `lock_not_available`, raised when `lock_timeout` ends a wait. */
const LOCK_NOT_AVAILABLE = "55P03";
/** How long the manual request waits for the account row or its state row before it queues without recording. */
const MANUAL_SYNC_LOCK_WAIT_MS = 50;

function isLockNotAvailable(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === LOCK_NOT_AVAILABLE;
}

/** Unknown, foreign and trashed ids are the same 404; Calendars off is 409 `calendars_disabled`. */
async function readEnabledAccount(
  client: PoolClient,
  ids: CalendarSyncIds,
  accountItemId: string,
  lock: "FOR SHARE" | "",
) {
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT properties FROM items WHERE database_id = $1 AND id = $2 AND deleted_at IS NULL ${lock}`,
    [ids.mailboxesDatabaseId, accountItemId],
  );
  if (rows[0] === undefined) throw new NotFoundError("Account not found");
  if (!areCalendarsEnabled(accountRowSchema.parse(rows[0]).properties)) {
    throw new ConflictError(
      "Calendars are switched off for this account",
      { accountId: accountItemId },
      "calendars_disabled",
    );
  }
}

/**
 * `POST /api/accounts/:id/calendars/sync`: queues a pass and answers 202 with when it runs. A request within the
 * debounce window of the last one is coalesced into one pass at the window's end (`recordManualCalendarSyncRequest`),
 * never dropped. The account row is read `FOR SHARE`, so a Calendars switch commits before or after the request,
 * never between its check and its record. Neither that lock nor the state row's waits longer than
 * `MANUAL_SYNC_LOCK_WAIT_MS`: while a pass step, a switch or another writer holds one, the request checks the account
 * without the lock and queues the pass now without recording itself (the job key keeps one waiting job). Unknown,
 * malformed, foreign and trashed ids answer the same 404; Calendars off answers 409 `calendars_disabled`.
 */
export function createCalendarAccountSyncRouteHandler(pool: Pool) {
  return async (ctx: RouteParams): Promise<CustomRouteResult<{ id: string; queued: true; runAt: string }>> => {
    const parsed = accountIdSchema.safeParse(ctx.params.id);
    if (!parsed.success) throw new NotFoundError("Account not found");
    const accountItemId = parsed.data;
    const runAt = await withTransaction(pool, async (client) => {
      const ids = await resolveCalendarSyncIds(client);
      if (ids === null) throw new NotFoundError("Account not found");
      let schedule: ManualCalendarSyncSchedule;
      try {
        schedule = await withSavepoint(client, async () => {
          const { rows } = await client.query<{ previous: string }>(
            "SELECT current_setting('lock_timeout') AS previous",
          );
          await client.query("SELECT set_config('lock_timeout', $1, true)", [`${MANUAL_SYNC_LOCK_WAIT_MS}ms`]);
          await readEnabledAccount(client, ids, accountItemId, "FOR SHARE");
          const result = await recordManualCalendarSyncRequest(
            client,
            accountItemId,
            MANUAL_CALENDAR_SYNC_DEBOUNCE_SECONDS,
          );
          await client.query("SELECT set_config('lock_timeout', $1, true)", [
            requireSingleRow(rows, "lock_timeout").previous,
          ]);
          return result;
        });
      } catch (error) {
        if (!isLockNotAvailable(error)) throw error;
        await readEnabledAccount(client, ids, accountItemId, "");
        const { rows } = await client.query<{ now: Date }>("SELECT now() AS now");
        schedule = { runAt: requireSingleRow(rows, "now").now, deferred: false };
      }
      await enqueueCalendarAccountSync(client, accountItemId, schedule.deferred ? schedule.runAt : undefined);
      return schedule.runAt;
    });
    return { status: 202, body: { id: accountItemId, queued: true, runAt: runAt.toISOString() } };
  };
}
