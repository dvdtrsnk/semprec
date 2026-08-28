import { DateTime } from "luxon";
import type { Queryable } from "../db/pool.js";
import { assertKnownValue } from "../dbRowValidation.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import type { ItemRow } from "../types.js";

export const JOURNAL_PERIOD_TYPES = ["year", "quarter", "month", "week", "day"] as const;
export type JournalPeriodType = (typeof JOURNAL_PERIOD_TYPES)[number];

/** The canonical period key, also stored verbatim in the `period` property — e.g. '2026', '2026-Q3', '2026-08', '2026-W35', '2026-08-28'. */
export function computeJournalPeriodKey(type: JournalPeriodType, reference: DateTime): string {
  assertKnownValue(JOURNAL_PERIOD_TYPES, type, "journal period type");
  switch (type) {
    case "year":
      return String(reference.year);
    case "quarter":
      return `${reference.year}-Q${reference.quarter}`;
    case "month":
      return reference.toFormat("yyyy-LL");
    case "week":
      return reference.toFormat("kkkk-'W'WW");
    case "day":
      return reference.toISODate() as string;
  }
}

async function findJournalItemByPeriod(
  client: Queryable,
  journalDatabaseId: string,
  type: JournalPeriodType,
  period: string,
): Promise<ItemRow | null> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM items WHERE database_id = $1 AND properties @> $2::jsonb AND deleted_at IS NULL LIMIT 1`,
    [journalDatabaseId, JSON.stringify({ type, period })],
  );
  if (!rows[0]) return null;
  return itemsStore.getItemById(client, journalDatabaseId, rows[0].id);
}

/**
 * Lazily creates the Journal item for a given period on first write (issue #24, point 10):
 * Journal has no manual "+ New" — an item for a date is created implicitly, whether from the
 * user or from automated processing. Mirrors docs/docsStore.ts's `getOrCreateDoc`.
 *
 * `name`/`type`/`period` are all `owner: 'system'` — the generic choke-point's `createItem`
 * would reject them (an owner:'system' key can never reach the generic write path), so this
 * function writes them directly via `itemsStore`, being itself the one owning process for
 * Journal's schema fields, matching the "single owner, single writer" rule.
 *
 * A concurrent first-write race for the same period is resolved by the partial unique index
 * `items_period_uq` (`ON CONFLICT ... DO NOTHING`) plus a re-read of the winner, the same
 * low-stakes-race tradeoff `getOrCreateDoc` documents for this single/two-user system.
 */
export async function getOrCreateJournalItem(
  client: Queryable,
  journalDatabaseId: string,
  type: JournalPeriodType,
  referenceDate: Date,
  timezone: string,
): Promise<ItemRow> {
  const reference = DateTime.fromJSDate(referenceDate, { zone: timezone });
  const period = computeJournalPeriodKey(type, reference);

  const existing = await findJournalItemByPeriod(client, journalDatabaseId, type, period);
  if (existing) return existing;

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO items (database_id, properties) VALUES ($1, $2::jsonb)
     ON CONFLICT (database_id, (properties ->> 'type'), (properties ->> 'period')) WHERE (properties ? 'period') DO NOTHING
     RETURNING id`,
    [journalDatabaseId, JSON.stringify({ name: `\u{1F4D3} ${period}`, type, period })],
  );
  if (rows[0]) {
    const created = await itemsStore.getItemById(client, journalDatabaseId, rows[0].id);
    if (created) return created;
  }

  const winner = await findJournalItemByPeriod(client, journalDatabaseId, type, period);
  if (!winner) throw new Error(`Journal item for period '${period}' disappeared immediately after a concurrent insert`);
  return winner;
}
