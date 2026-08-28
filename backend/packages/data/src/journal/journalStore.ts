import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { assertKnownValue } from "../dbRowValidation.js";
import { createItemWithClient } from "../chokePoint/chokePoint.js";
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
 * transaction.
 */
export async function getOrCreateJournalItem(
  client: PoolClient,
  journalDatabaseId: string,
  type: JournalPeriodType,
  referenceDate: Date,
  timezone: string,
): Promise<ItemRow> {
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
