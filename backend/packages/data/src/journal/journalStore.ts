import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getOrCreateDoc } from "../docs/docsStore.js";
import { ConflictError, NotFoundError } from "../errors.js";
import { JOURNAL_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { getSystemTimezone } from "../systemSettings.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { requireAffectedRows, requireSingleRow } from "../db/pool.js";
import { assertValidTimezone } from "../timezone.js";
import type { ItemRow } from "../types.js";
import {
  computeJournalPeriodKey,
  describeJournalPeriods,
  parseJournalPeriodKey,
  type JournalPeriodType,
} from "./journalPeriods.js";

export {
  computeJournalPeriodKey,
  describeJournalPeriods,
  JOURNAL_PERIOD_TYPES,
  parseJournalPeriodKey,
  weeksOfMonth,
  type JournalPeriodType,
} from "./journalPeriods.js";

/** One `idempotency_keys` row per Journal database, type and period. */
function journalPeriodReservationKey(journalDatabaseId: string, type: string, period: string): string {
  return `journal:${journalDatabaseId}:${type}:${period}`;
}

/**
 * Journal has no manual "+ New": the period item is created implicitly on first write. `allowedSystemKeys`
 * relaxes the ownership check for exactly `name`/`type`/`period` on this one owning process.
 *
 * Concurrent first writes share a deterministic per-period idempotency key, so the reservation table resolves the
 * race to one item without raising a Postgres error that would abort the caller's transaction. A trashed or
 * purged period item is not reused; the key is repointed at the fresh one.
 */
export async function getOrCreateJournalItem(
  client: PoolClient,
  journalDatabaseId: string,
  type: JournalPeriodType,
  referenceDate: Date,
  timezone: string,
): Promise<ItemRow> {
  // An unrecognized zone would otherwise turn `period` into the string "null".
  assertValidTimezone(timezone);
  const reference = DateTime.fromJSDate(referenceDate, { zone: timezone });
  const period = computeJournalPeriodKey(type, reference);

  return createItemWithClient(
    client,
    {
      databaseId: journalDatabaseId,
      properties: { name: `\u{1F4D3} ${period}`, type, period },
      idempotencyKey: journalPeriodReservationKey(journalDatabaseId, type, period),
    },
    { allowedSystemKeys: ["name", "type", "period"] },
  );
}

export async function ensureJournalPeriodDoc(
  client: PoolClient,
  type: JournalPeriodType,
  period: string,
): Promise<{ itemId: string; docId: string; period: string; range: { from: string; to: string } }> {
  const timezone = await getSystemTimezone(client);
  const parsed = parseJournalPeriodKey(type, period, timezone);
  const journal = await getDatabaseByModuleId(client, JOURNAL_MODULE_ID);
  if (!journal) throw new NotFoundError("Journal database not found");
  const item = await getOrCreateJournalItem(client, journal.id, type, parsed.reference.toJSDate(), timezone);
  const doc = await getOrCreateDoc(client, item.id, "page");
  const bounds = describeJournalPeriods(parsed.reference.toJSDate(), timezone)[type];
  return { itemId: item.id, docId: doc.id, period, range: { from: bounds.from, to: bounds.to } };
}

/**
 * Inside the restore's transaction: points the period reservation at the restored entry, or refuses with a 409
 * (`details.liveItemId`) when the period already has another live entry.
 *
 * The reservation row is taken first (inserted, or row-locked by a no-op `ON CONFLICT DO UPDATE`); every
 * cooperating writer of a period entry takes it before committing, so the live-peer check under it cannot miss a
 * concurrent one. No peer item row is locked: two restores of one period each hold their own row, and waiting for
 * the other's would close a cycle. Entries made live by paths that skip the reservation are not covered.
 */
export async function repointJournalPeriodReservation(
  client: PoolClient,
  input: { journalDatabaseId: string; type: string; period: string; itemId: string },
): Promise<void> {
  const key = journalPeriodReservationKey(input.journalDatabaseId, input.type, input.period);
  await takeJournalPeriodReservation(client, key, input.journalDatabaseId, input.itemId);
  const { rows: live } = await client.query<{ id: string }>(
    `SELECT id FROM items
     WHERE database_id = $1 AND id <> $2 AND deleted_at IS NULL
       AND properties->>'type' = $3 AND properties->>'period' = $4
     ORDER BY id LIMIT 1`,
    [input.journalDatabaseId, input.itemId, input.type, input.period],
  );
  const peer = live[0];
  if (peer) {
    throw new ConflictError("This Journal period already has a live entry", { liveItemId: peer.id });
  }
  await pointJournalPeriodReservation(client, key, input.journalDatabaseId, input.itemId);
}

/** Inserts the reservation for `itemId`, or row-locks the existing row without changing it. */
async function takeJournalPeriodReservation(
  client: PoolClient,
  key: string,
  journalDatabaseId: string,
  itemId: string,
): Promise<void> {
  const reserved = await client.query<{ database_id: string }>(
    `INSERT INTO idempotency_keys (key, database_id, item_id) VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, key) DO UPDATE SET item_id = idempotency_keys.item_id
     RETURNING database_id`,
    [key, journalDatabaseId, itemId],
  );
  if (requireSingleRow(reserved.rows, "journal period reservation").database_id !== journalDatabaseId) {
    throw new ConflictError(`Idempotency key '${key}' was already used for a different database`, { key });
  }
}

async function pointJournalPeriodReservation(
  client: PoolClient,
  key: string,
  journalDatabaseId: string,
  itemId: string,
): Promise<void> {
  const pointed = await client.query("UPDATE idempotency_keys SET item_id = $2 WHERE key = $1 AND database_id = $3", [
    key,
    itemId,
    journalDatabaseId,
  ]);
  requireAffectedRows(pointed, "journal period reservation");
}

/** Oldest first (ties by id), at most two. */
const OLDEST_LIVE_PERIOD_ENTRIES_SQL = `SELECT id FROM items
     WHERE database_id = $1 AND deleted_at IS NULL AND properties->>'type' = $2 AND properties->>'period' = $3
     ORDER BY created_at, id LIMIT 2`;
const OLDEST_LIVE_PERIOD_ENTRIES_FOR_UPDATE_SQL = `${OLDEST_LIVE_PERIOD_ENTRIES_SQL} FOR UPDATE`;

export interface JournalDuplicatePair {
  survivorId: string;
  duplicateId: string;
}

/** Unlocked read for the merge approval request; may be stale by the time a merge locks the pair. */
export async function findJournalDuplicatePair(
  client: PoolClient,
  input: { journalDatabaseId: string; type: JournalPeriodType; period: string },
): Promise<JournalDuplicatePair | null> {
  const { rows } = await client.query<{ id: string }>(OLDEST_LIVE_PERIOD_ENTRIES_SQL, [
    input.journalDatabaseId,
    input.type,
    input.period,
  ]);
  const [survivor, duplicate] = rows;
  return survivor && duplicate ? { survivorId: survivor.id, duplicateId: duplicate.id } : null;
}

/**
 * Holds the two oldest live entries of a period for a merge, or returns `null` with fewer than two.
 *
 * Lock order: the period reservation first (so `getOrCreateJournalItem`, restores and other merges wait), then the
 * entries re-read `FOR UPDATE`, since another transaction may have trashed or merged one meanwhile. The
 * reservation is then pointed at the survivor, so the next `getOrCreateJournalItem` returns it.
 */
export async function lockJournalDuplicatePair(
  client: PoolClient,
  input: { journalDatabaseId: string; type: JournalPeriodType; period: string },
): Promise<JournalDuplicatePair | null> {
  const period = [input.journalDatabaseId, input.type, input.period];
  const seen = await client.query<{ id: string }>(OLDEST_LIVE_PERIOD_ENTRIES_SQL, period);
  const [older, newer] = seen.rows;
  if (!older || !newer) return null;

  const key = journalPeriodReservationKey(input.journalDatabaseId, input.type, input.period);
  await takeJournalPeriodReservation(client, key, input.journalDatabaseId, older.id);
  const locked = await client.query<{ id: string }>(OLDEST_LIVE_PERIOD_ENTRIES_FOR_UPDATE_SQL, period);
  const [survivor, duplicate] = locked.rows;
  if (!survivor || !duplicate) return null;

  await pointJournalPeriodReservation(client, key, input.journalDatabaseId, survivor.id);
  return { survivorId: survivor.id, duplicateId: duplicate.id };
}
