// The hourly download of the feeds of subscription calendars (issue gh-1960). The task `calendarSubscriptionSweep` runs
// for every active tenant in turn (`forEachActiveTenant`, docs/adr/2026-10-06-system-work-fans-out-per-tenant.md),
// requests the feed of each live subscription calendar once with the validators of the last feed a consumer took over
// from that address, and hands a changed feed to the registered consumer. Turning a feed into Events is a consumer's
// work (issue #2004); with none registered a downloaded feed is only recorded as fetched.
// Constrained by: docs/adr/2026-10-16-connect-time-outbound-address-checks.md,
// docs/adr/2026-09-27-ssrf-protection-for-stored-outbound-urls.md,
// docs/adr/2026-09-28-chunked-transactions-for-large-background-sweeps.md
import type { ReadableStreamDefaultReader, ReadableStreamReadResult } from "node:stream/web";
import type { Pool, PoolClient } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { withTransaction } from "../db/pool.js";
import { forEachActiveTenant } from "../tenancy/forEachActiveTenant.js";
import {
  createOutboundHttp,
  currentOutboundAddressPolicy,
  isOutboundAddressNotAllowed,
  type OutboundHttp,
} from "../net/outboundAddressPolicy.js";
import { isBaselineOutboundUrl } from "../net/storedOutboundUrl.js";
import { CALENDARS_MODULE_ID } from "../seed/calendarsKeys.js";
import { feedUrlHash, recordCalendarFeedFailure, recordCalendarFeedFetched } from "./calendarFeedState.js";
import { logger } from "./logger.js";

/** What a consumer gets of a changed feed: the calendar it belongs to, the feed text and the validators the server sent. */
export interface CalendarFeedInput {
  calendarItemId: string;
  body: string;
  etag: string | null;
  lastModified: string | null;
}

/**
 * Takes over a changed feed inside the transaction `client`, which is scoped to the calendar's tenant. The validators
 * of the feed are stored in that same transaction after the consumer returned, so a consumer that throws leaves the
 * stored validators as they were and the next run requests the feed in full again.
 */
export type CalendarFeedConsumer = (client: PoolClient, feed: CalendarFeedInput) => Promise<void>;

let registeredConsumer: CalendarFeedConsumer | null = null;

/**
 * Registers the consumer of downloaded feeds (issue #2004), or none with `null`. There is no consumer by default; the
 * sweep then records a downloaded feed as fetched and leaves the stored validators alone, so the feed is requested in
 * full again once a consumer exists.
 */
export function registerCalendarFeedConsumer(consumer: CalendarFeedConsumer | null): void {
  registeredConsumer = consumer;
}

/** The limits of one run. The defaults are those the issue decides; a test passes smaller ones. */
export interface CalendarFeedLimits {
  /** The time one feed may take, connection and body included. */
  requestTimeoutMs: number;
  /** The most bytes of a feed body; a larger body aborts the download. */
  maxBodyBytes: number;
  /** The most subscription calendars one tenant has requested in one run. */
  maxCalendarsPerTenant: number;
}

export const CALENDAR_FEED_LIMITS: CalendarFeedLimits = {
  requestTimeoutMs: 20_000,
  maxBodyBytes: 5 * 1024 * 1024,
  maxCalendarsPerTenant: 100,
};

/** The short codes a failed request is recorded with (`calendar_feed_state.last_error_code`). */
export type CalendarFeedErrorCode =
  | "urlNotAllowed"
  | "addressRefused"
  | "redirect"
  | "timeout"
  | "tooLarge"
  | "httpStatus"
  | "networkError"
  | "consumerFailed";

/**
 * A request that did not deliver a feed; `status` is the HTTP status when the server answered, and `cause` the class
 * name of the error behind a `networkError`, which the code alone does not tell apart (the log carries it).
 */
class CalendarFeedDownloadError extends Error {
  constructor(
    readonly code: CalendarFeedErrorCode,
    readonly status: number | null = null,
    readonly causeName: string | null = null,
  ) {
    super(code);
    this.name = "CalendarFeedDownloadError";
  }
}

/** Raised around what the consumer threw, so a failure of the consumer is told apart from a failure of the store. */
class CalendarFeedConsumerError extends Error {
  constructor(cause: unknown) {
    super("The calendar feed consumer failed", { cause });
    this.name = "CalendarFeedConsumerError";
  }
}

/**
 * One subscription calendar due for a request: the address it was listed with, and the validators stored for that
 * address (none when the stored ones came from another address).
 */
interface FeedTarget {
  calendarItemId: string;
  url: string;
  etag: string | null;
  lastModified: string | null;
}

type FeedAnswer =
  | { kind: "notModified"; etag: string | null; lastModified: string | null }
  | { kind: "changed"; body: string; etag: string | null; lastModified: string | null };

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

/** The class names of `err` and its `cause` chain, outermost first (names only: a message can hold an address). */
function errorNameChain(err: unknown): string {
  const names: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current !== undefined && !seen.has(current) && names.length < 5) {
    names.push(errorName(current));
    seen.add(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  return names.join(" <- ");
}

/** The message of the error `undici` raises for a redirect response when the request was made with `redirect: "error"`. */
const UNDICI_REDIRECT_REFUSAL = "unexpected redirect";

/**
 * Whether `err` or an error in its `cause` chain is the redirect refusal of the outbound client (`createOutboundHttp`
 * requests with `redirect: "error"`, and `undici` has no typed error for it). The message must equal the refusal's
 * exactly: an error that merely mentions a redirect, a host name for one, is a network failure.
 */
function isRedirectRefusal(err: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current instanceof Error && !seen.has(current)) {
    if (current.message === UNDICI_REDIRECT_REFUSAL) return true;
    seen.add(current);
    current = current.cause;
  }
  return false;
}

function classifyRequestFailure(err: unknown, timeout: AbortSignal): CalendarFeedDownloadError {
  if (err instanceof CalendarFeedDownloadError) return err;
  if (isOutboundAddressNotAllowed(err)) return new CalendarFeedDownloadError("addressRefused");
  if (timeout.aborted) return new CalendarFeedDownloadError("timeout");
  if (isRedirectRefusal(err)) return new CalendarFeedDownloadError("redirect");
  return new CalendarFeedDownloadError("networkError", null, errorNameChain(err));
}

/** Reads the body of `response` as text, aborting through `abort` as soon as it is larger than `maxBytes`. */
async function readCappedBody(response: Response, maxBytes: number, abort: AbortController): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    abort.abort();
    throw new CalendarFeedDownloadError("tooLarge", response.status);
  }
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const result: ReadableStreamReadResult<Uint8Array> = await reader.read();
    if (result.done) break;
    const value = result.value;
    total += value.byteLength;
    if (total > maxBytes) {
      abort.abort();
      throw new CalendarFeedDownloadError("tooLarge", response.status);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * One request for the feed of `target`: `If-None-Match` and `If-Modified-Since` from its stored validators, no
 * redirect followed (the client refuses it), the whole request under `limits.requestTimeoutMs` and the body under
 * `limits.maxBodyBytes`. 304 is `notModified` and 200 is `changed` with the body; any other status, a redirect, a
 * refused address, a timeout, an oversized body and any other network failure is a `CalendarFeedDownloadError`.
 */
async function requestFeed(http: OutboundHttp, target: FeedTarget, limits: CalendarFeedLimits): Promise<FeedAnswer> {
  const timeout = AbortSignal.timeout(limits.requestTimeoutMs);
  const abort = new AbortController();
  const headers: Record<string, string> = { Accept: "text/calendar, text/plain;q=0.8, */*;q=0.1" };
  if (target.etag !== null) headers["If-None-Match"] = target.etag;
  if (target.lastModified !== null) headers["If-Modified-Since"] = target.lastModified;
  try {
    const response = await http.fetch(target.url, {
      method: "GET",
      headers,
      signal: AbortSignal.any([timeout, abort.signal]),
    });
    const etag = response.headers.get("etag");
    const lastModified = response.headers.get("last-modified");
    if (response.status === 304) return { kind: "notModified", etag, lastModified };
    if (response.status !== 200) throw new CalendarFeedDownloadError("httpStatus", response.status);
    return { kind: "changed", body: await readCappedBody(response, limits.maxBodyBytes, abort), etag, lastModified };
  } catch (err) {
    throw classifyRequestFailure(err, timeout);
  } finally {
    // Frees the connection on every path out, a body that was read to its end included; aborting a finished request is a no-op.
    abort.abort();
  }
}

/**
 * The live subscription calendars of the tenant in scope that have a feed address, the ones requested longest ago (or
 * never) first, at most `limit`, with the validators stored for each. The bounded list holds ids, addresses and
 * validators only.
 */
async function listFeedTargets(client: PoolClient, limit: number): Promise<FeedTarget[]> {
  const calendars = await getDatabaseByModuleId(client, CALENDARS_MODULE_ID);
  if (!calendars) return [];
  const { rows } = await client.query<{
    id: string;
    url: string;
    etag: string | null;
    last_modified: string | null;
    feed_url_hash: string | null;
  }>(
    `SELECT i.id, i.properties->>'subscriptionUrl' AS url, s.etag, s.last_modified, s.feed_url_hash
       FROM items i
       LEFT JOIN calendar_feed_state s ON s.tenant_id = i.tenant_id AND s.calendar_item_id = i.id
      WHERE i.database_id = $1
        AND i.deleted_at IS NULL
        AND i.properties->>'kind' = 'subscription'
        AND coalesce(i.properties->>'subscriptionUrl', '') <> ''
      ORDER BY s.last_fetched_at ASC NULLS FIRST, i.id
      LIMIT $2`,
    [calendars.id, limit],
  );
  // Validators go only to the address they came from: after the address changed the feed is requested in full.
  return rows.map((row) => {
    const sameAddress = row.feed_url_hash === feedUrlHash(row.url);
    return {
      calendarItemId: row.id,
      url: row.url,
      etag: sameAddress ? row.etag : null,
      lastModified: sameAddress ? row.last_modified : null,
    };
  });
}

/**
 * Runs `work` in a transaction of the tenant in scope that holds the calendar's row lock, and only while the calendar
 * is still a live subscription calendar whose address is the one `target` was requested from. The listing and the
 * request happened before this transaction, outside any lock, so the address can have been changed (or the calendar
 * trashed or purged) since; nothing is delivered or stored for a feed that no longer belongs to the calendar. The lock
 * holds the address for the rest of the transaction, since a change of it takes the same row lock. Returns whether
 * `work` ran.
 */
async function whileFeedIsCurrent(
  pool: Pool,
  target: FeedTarget,
  work: (client: PoolClient) => Promise<void>,
): Promise<boolean> {
  const current = await withTransaction(pool, async (client) => {
    const calendars = await getDatabaseByModuleId(client, CALENDARS_MODULE_ID);
    const calendar = calendars ? await itemsStore.lockItemById(client, calendars.id, target.calendarItemId) : null;
    if (
      calendar === null ||
      calendar.deletedAt !== null ||
      calendar.properties.kind !== "subscription" ||
      calendar.properties.subscriptionUrl !== target.url
    ) {
      return false;
    }
    await work(client);
    return true;
  });
  if (!current) {
    // The id only: the address and its query string stay out of the log.
    logger.info({ calendarItemId: target.calendarItemId }, "Calendar feed result dropped: the calendar changed");
  }
  return current;
}

/**
 * Hands a changed feed to the registered consumer and stores its validators with the address they came from, in one
 * transaction of the tenant in scope that holds the calendar's row lock (`whileFeedIsCurrent`). A consumer that throws
 * rolls the transaction back, so neither its writes nor the validators are stored, and the throw is reported as
 * `CalendarFeedConsumerError`. Without a consumer only the fetch is recorded. A calendar whose address changed since
 * the request gets neither the feed nor a state row for it.
 */
async function deliverFeed(
  pool: Pool,
  consumer: CalendarFeedConsumer | null,
  target: FeedTarget,
  answer: Extract<FeedAnswer, { kind: "changed" }>,
): Promise<void> {
  await whileFeedIsCurrent(pool, target, async (client) => {
    if (consumer === null) {
      await recordCalendarFeedFetched(client, target.calendarItemId, 200, null);
      return;
    }
    try {
      await consumer(client, {
        calendarItemId: target.calendarItemId,
        body: answer.body,
        etag: answer.etag,
        lastModified: answer.lastModified,
      });
    } catch (err) {
      throw new CalendarFeedConsumerError(err);
    }
    await recordCalendarFeedFetched(client, target.calendarItemId, 200, {
      etag: answer.etag,
      lastModified: answer.lastModified,
      feedUrlHash: feedUrlHash(target.url),
    });
  });
}

/**
 * Stores the failure of one calendar's request in a transaction of its own, after the failed work rolled back (and
 * nothing when the calendar's address changed meanwhile: the failure belongs to the old address). `causeName` is the
 * class chain of the error behind a `networkError`.
 */
async function recordFailure(
  pool: Pool,
  target: FeedTarget,
  code: CalendarFeedErrorCode,
  status: number | null,
  causeName: string | null = null,
): Promise<void> {
  const recorded = await whileFeedIsCurrent(pool, target, (client) =>
    recordCalendarFeedFailure(client, target.calendarItemId, code, status),
  );
  if (!recorded) return;
  // Ids, the code and error class names only: the feed and the address (its query string can hold a secret) stay out of the log.
  logger.warn(
    { calendarItemId: target.calendarItemId, errorCode: code, status, ...(causeName === null ? {} : { causeName }) },
    "Calendar feed request failed",
  );
}

/**
 * Requests one calendar's feed and settles its row. A failed request, a refused address and a failed consumer are
 * recorded (`recordFailure`) and end this calendar's work without an error. Whatever else throws (the store, the
 * database) is not an answer of this calendar and propagates.
 */
async function syncFeed(
  pool: Pool,
  http: OutboundHttp,
  target: FeedTarget,
  limits: CalendarFeedLimits,
  baselineApplies: boolean,
): Promise<void> {
  if (baselineApplies && !isBaselineOutboundUrl(target.url)) {
    await recordFailure(pool, target, "urlNotAllowed", null);
    return;
  }
  let answer: FeedAnswer;
  try {
    answer = await requestFeed(http, target, limits);
  } catch (err) {
    if (!(err instanceof CalendarFeedDownloadError)) throw err;
    await recordFailure(pool, target, err.code, err.status, err.causeName);
    return;
  }
  if (answer.kind === "notModified") {
    // The stored validators stay: a 304 may carry none, and the feed the consumer has is still the current one.
    await whileFeedIsCurrent(pool, target, (client) =>
      recordCalendarFeedFetched(client, target.calendarItemId, 304, null),
    );
    return;
  }
  try {
    await deliverFeed(pool, registeredConsumer, target, answer);
  } catch (err) {
    if (!(err instanceof CalendarFeedConsumerError)) throw err;
    logger.warn(
      { calendarItemId: target.calendarItemId, errorName: errorName(err.cause) },
      "Calendar feed consumer failed",
    );
    await recordFailure(pool, target, "consumerFailed", 200);
  }
}

/**
 * The task `calendarSubscriptionSweep` (crontab, `CORE_CRONTAB` in worker.ts): for every active tenant, requests the
 * feed of each live subscription calendar with a feed address once (at most `limits.maxCalendarsPerTenant`, the ones
 * requested longest ago first) and hands a changed feed to the registered consumer.
 *
 * Each address is judged again by `isBaselineOutboundUrl` before it is requested, and a refused one is recorded as
 * `urlNotAllowed` and not requested. The client pins the address a name resolves to at connect time and refuses a
 * non-public one, so a host that resolves to an internal address is recorded as `addressRefused`. Only the process-wide
 * test policy of `allowLoopbackOutboundForTests` lets a local server be requested, and under it the baseline is skipped.
 * The calendars of a tenant are listed once, bounded by the cap, and each is then settled in transactions of its own,
 * none of which spans a request (a bounded list of ids replaces the chunked listing of the ADR, which the cap makes
 * unnecessary).
 *
 * The validators stored for a calendar are sent only to the address they came from (`calendar_feed_state.feed_url_hash`),
 * and every write after the request (the consumer's, the validators, a 304, a failure) runs under the calendar's row lock
 * and only while the calendar is still live with the address it was requested from (`whileFeedIsCurrent`), so an address
 * changed during the run neither receives the old address's feed nor keeps its validators.
 *
 * One calendar's failure does not stop the others: a failed download or consumer is recorded in `calendar_feed_state`
 * and is not an error of the task, since the next run requests the feed again. An error outside that (the database)
 * is collected per calendar and thrown once the tenant's calendars are done; `forEachActiveTenant` collects it per
 * tenant and the task fails after every tenant ran.
 */
export async function handleCalendarSubscriptionSweepTask(
  pool: Pool,
  limits: CalendarFeedLimits = CALENDAR_FEED_LIMITS,
): Promise<void> {
  const policy = currentOutboundAddressPolicy();
  const http = createOutboundHttp(policy);
  try {
    await forEachActiveTenant(pool, async () => {
      const targets = await withTransaction(pool, (client) => listFeedTargets(client, limits.maxCalendarsPerTenant));
      const errors: unknown[] = [];
      for (const target of targets) {
        try {
          // Under the test policy the stored address is a local test server, which the baseline refuses.
          await syncFeed(pool, http, target, limits, !policy.isTestPolicy);
        } catch (err) {
          logger.error(
            { calendarItemId: target.calendarItemId, errorName: errorName(err) },
            "Calendar feed sweep failed for a calendar",
          );
          errors.push(err);
        }
      }
      if (errors.length > 0) throw new AggregateError(errors, `${errors.length} of ${targets.length} calendars failed`);
    });
  } finally {
    try {
      await http.close();
    } catch (err) {
      logger.warn({ errorName: errorName(err) }, "Closing the calendar feed client failed");
    }
  }
}
