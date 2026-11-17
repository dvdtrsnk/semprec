// Hourly download of subscription calendar feeds, per active tenant. Each live subscription calendar's feed is
// requested once with the validators of the last feed taken over from that address; a changed feed goes to the
// registered consumer, or is only recorded as fetched when none is registered.
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

export interface CalendarFeedInput {
  calendarItemId: string;
  body: string;
  etag: string | null;
  lastModified: string | null;
}

/**
 * Runs in a transaction scoped to the calendar's tenant. Validators are stored in the same transaction after
 * the consumer returns, so a throwing consumer leaves them unchanged and the next run requests the full feed.
 */
export type CalendarFeedConsumer = (client: PoolClient, feed: CalendarFeedInput) => Promise<void>;

let registeredConsumer: CalendarFeedConsumer | null = null;

/**
 * None by default; the sweep then leaves stored validators alone so the full feed is requested once a consumer
 * exists.
 */
export function registerCalendarFeedConsumer(consumer: CalendarFeedConsumer | null): void {
  registeredConsumer = consumer;
}

/** Tests pass smaller limits. */
export interface CalendarFeedLimits {
  /** Connection and body included. */
  requestTimeoutMs: number;
  /** A larger body aborts the download. */
  maxBodyBytes: number;
  maxCalendarsPerTenant: number;
}

export const CALENDAR_FEED_LIMITS: CalendarFeedLimits = {
  requestTimeoutMs: 20_000,
  maxBodyBytes: 5 * 1024 * 1024,
  maxCalendarsPerTenant: 100,
};

/** Stored in `calendar_feed_state.last_error_code`. */
export type CalendarFeedErrorCode =
  | "urlNotAllowed"
  | "addressRefused"
  | "redirect"
  | "timeout"
  | "tooLarge"
  | "httpStatus"
  | "networkError"
  | "consumerFailed";

/** `cause` is the class name behind a `networkError`, which the code alone does not tell apart. */
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

/** Tells a consumer failure apart from a store failure. */
class CalendarFeedConsumerError extends Error {
  constructor(cause: unknown) {
    super("The calendar feed consumer failed", { cause });
    this.name = "CalendarFeedConsumerError";
  }
}

/** `validators` is empty when the stored ones came from another address. */
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

/** Names only: a message can hold an address. */
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

const UNDICI_REDIRECT_REFUSAL = "unexpected redirect";

/**
 * `createOutboundHttp` requests with `redirect: "error"` and `undici` has no typed error for it. The message must
 * match exactly: an error merely mentioning a redirect is a network failure.
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
 * No redirect followed; the whole request under `requestTimeoutMs` and the body under `maxBodyBytes`. 304 is
 * `notModified`, 200 is `changed`; anything else is a `CalendarFeedDownloadError`.
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
    // Frees the connection on every exit; aborting a finished request is a no-op.
    abort.abort();
  }
}

/** Longest-ago (or never) requested first. The bounded list holds ids, addresses and validators only. */
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
  // Validators go only to the address they came from.
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
 * Runs `work` under the calendar's row lock, only while it is still a live subscription calendar with the
 * address `target` was requested from. Listing and request happen outside any lock, so the address may have
 * changed since; an address change takes the same row lock, so the lock holds it for the rest of the transaction.
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

/** A throwing consumer rolls back both its writes and the validators, reported as `CalendarFeedConsumerError`. */
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

/** Own transaction, after the failed work rolled back; skipped when the address changed meanwhile. */
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
  // The feed and the address (its query string can hold a secret) stay out of the log.
  logger.warn(
    { calendarItemId: target.calendarItemId, errorCode: code, status, ...(causeName === null ? {} : { causeName }) },
    "Calendar feed request failed",
  );
}

/**
 * Download, address and consumer failures are recorded and end this calendar's work without an error; anything
 * else (store, database) propagates.
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
    // The stored validators stay: a 304 may carry none, and the consumer's feed is still current.
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
 * Task `calendarSubscriptionSweep` (crontab, `CORE_CRONTAB` in worker.ts).
 *
 * Each address is re-judged by `isBaselineOutboundUrl` (refused: `urlNotAllowed`); the client pins the resolved
 * address at connect time and refuses a non-public one (`addressRefused`). Only the test policy of
 * `allowLoopbackOutboundForTests` allows a local server, and skips the baseline.
 *
 * A tenant's calendars are listed once, bounded by the cap (instead of a chunked listing), and each is settled in
 * its own transactions, none spanning a request.
 *
 * A download or consumer failure is recorded and is not a task error. Other errors are collected per calendar and
 * thrown after the tenant's calendars; `forEachActiveTenant` collects per tenant.
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
