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

/** The reservation a Journal period's entry is found by: one `idempotency_keys` row per Journal database, type and period. */
function journalPeriodReservationKey(journalDatabaseId: string, type: string, period: string): string {
  return `journal:${journalDatabaseId}:${type}:${period}`;
}

/**
 * Lazily creates the Journal item for a given period on first write (issue #24, point 10):
 * Journal has no manual "+ New" — an item for a date is created implicitly, whether from the
 * user or from automated processing. Mirrors docs/docsStore.ts's `getOrCreateDoc`.
 *
 * `name`/`type`/`period` are all `owner: 'system'`, so this calls `createItemWithClient` with
 * `allowedSystemKeys: ['name', 'type', 'period']` — this function is Journal's declared owning
 * process for exactly those fields, the one narrow, per-key, code-defined exception the
 * choke-point grants (see chokePoint.ts's `AssertWritablePropertiesOptions`). The write still
 * goes through the same single write path as every other item creation (idempotency handling,
 * onItemEvent heartbeat triggering), it just has the ownership check relaxed for these three
 * keys, on this one trusted caller — not a blanket bypass for any system-owned field anywhere.
 *
 * Concurrency-safe via a deterministic per-period idempotency key, not a DB constraint: two
 * concurrent first-writes for the same period both attempt the same key, and `insertItem`'s
 * existing reservation-table mechanism (see chokePoint/itemsStore.ts) resolves the race to a
 * single winning item without ever raising a Postgres error that would abort the caller's
 * transaction. A period item that was later trashed or purged is not reused: the next write for
 * that period is handed a fresh item, and its idempotency key now points at that new one.
 */
export async function getOrCreateJournalItem(
  client: PoolClient,
  journalDatabaseId: string,
  type: JournalPeriodType,
  referenceDate: Date,
  timezone: string,
): Promise<ItemRow> {
  // Without this, an unrecognized zone would silently make `computeJournalPeriodKey`'s
  // `toISODate()` return null, and `period` would become the string "null".
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

/** Creates or reuses the period item and its page within the caller's transaction. */
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
 * Points the period reservation of a restored Journal entry at it (issue #1666), inside the restore's transaction, or
 * refuses the restore when the period already has another live entry.
 *
 * 1. The reservation row `journal:<journalDatabaseId>:<type>:<period>` is taken first: inserted for `itemId` when it
 *    is missing, otherwise row-locked by the same statement (`ON CONFLICT ... DO UPDATE` that changes nothing), so a
 *    reservation that `getOrCreateJournalItem` releases and re-creates concurrently is waited for rather than missed.
 * 2. Holding it, a plain read looks for another live entry of the database with the same `type` and `period`. Every
 *    cooperating writer of a period entry, `getOrCreateJournalItem` and this function, takes the reservation inside
 *    the transaction that makes the entry live and before that transaction commits. The restore itself clears
 *    `deleted_at` before this hook takes the reservation; what the reservation serializes is the live-peer decision and
 *    the commit: an entry another cooperating writer made live and committed before this lock was taken is visible
 *    here, and one whose transaction takes the reservation after it waits for this transaction to end. A live peer
 *    throws `ConflictError` (409) naming it in `details.liveItemId`; the caller's restore rolls back, and so does the
 *    reservation insert.
 * 3. Otherwise the reservation is pointed at `itemId`, so the next `getOrCreateJournalItem` for the period returns it.
 *
 * No peer item row is locked: two restores of entries of one period each already hold their own restored row, and
 * waiting for the other's would close a cycle. The serialization holds only between writers that take the
 * reservation; an entry made live by any other path is not covered. See
 * docs/adr/2026-11-08-journal-restore-serializes-on-its-period-reservation.md.
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

/**
 * Takes the reservation row `key` for the rest of the transaction: inserts it for `itemId` when it is missing,
 * otherwise waits for and row-locks the current row without changing a value. A row that belongs to another database
 * is a `ConflictError`.
 */
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

/** Points the reservation row `key`, which the transaction already holds, at `itemId`. */
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

/** The live entries of one Journal period, the entry created first leading (ties by id), cut to the first two. */
const OLDEST_LIVE_PERIOD_ENTRIES_SQL = `SELECT id FROM items
     WHERE database_id = $1 AND deleted_at IS NULL AND properties->>'type' = $2 AND properties->>'period' = $3
     ORDER BY created_at, id LIMIT 2`;
/** The same read, row-locking what it returns. Both statements are constants; the period is bound as parameters. */
const OLDEST_LIVE_PERIOD_ENTRIES_FOR_UPDATE_SQL = `${OLDEST_LIVE_PERIOD_ENTRIES_SQL} FOR UPDATE`;

/** The two entries one merge of a duplicated Journal period works on. */
export interface JournalDuplicatePair {
  /** The live entry of the period that was created first. */
  survivorId: string;
  /** The live entry of the period that was created next. */
  duplicateId: string;
}

/**
 * Finds the two live entries of a Journal period that were created first and holds them for a merge (issue #1726),
 * or returns `null` when the period has fewer than two.
 *
 * 1. A plain read looks for them. With fewer than two, nothing is locked and nothing is written.
 * 2. The period reservation is taken with the statement `repointJournalPeriodReservation` uses, inserted for the older
 *    entry of step 1 when it is missing. A transaction that takes the reservation later (`getOrCreateJournalItem`, a
 *    restore of an entry of the period, another merge) waits for this one to end.
 * 3. Holding it, the read of step 1 runs again with `FOR UPDATE`. The rows it returns are live entries of the period as
 *    committed at that moment, and they stay row-locked. With fewer than two (another transaction trashed or merged
 *    one in between) the result is `null`; the reservation keeps the entry it pointed at, or the entry step 2 inserted
 *    it for.
 * 4. The reservation is pointed at the older entry, so the next `getOrCreateJournalItem` for the period returns it
 *    once the newer one is in the Trash.
 *
 * See docs/adr/2026-11-10-journal-duplicate-merge-locks-the-reservation-before-both-entries.md.
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
