import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getOrCreateDoc } from "../docs/docsStore.js";
import { NotFoundError } from "../errors.js";
import { JOURNAL_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { getSystemTimezone } from "../systemSettings.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
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
      idempotencyKey: `journal:${journalDatabaseId}:${type}:${period}`,
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
