import { DateTime } from "luxon";
import * as Y from "yjs";
import { readPageBlocks, serializeBlocks } from "@semprec/block-model";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { getItemsByIds } from "../chokePoint/itemsStore.js";
import type { ItemRow } from "../types.js";
import { ensureJournalPeriodDoc } from "./journalStore.js";
import type { JournalPeriodType } from "./journalPeriods.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { readPageStatesForItems, type PageStateRead } from "../docs/docsStore.js";
import { withTransaction } from "../db/pool.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { JOURNAL_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { getSystemTimezone } from "../systemSettings.js";
import { describeJournalPeriods, JOURNAL_PERIOD_TYPES, parseJournalPeriodKey, weeksOfMonth } from "./journalPeriods.js";

interface JournalPeriodEntry {
  item: ItemRow;
  docId: string | null;
}

/** Resolves a set of period keys together, preferring the live reservation target when present. */
async function findJournalPeriodEntries(
  client: PoolClient,
  journalDatabaseId: string,
  type: JournalPeriodType,
  periods: string[],
): Promise<Map<string, JournalPeriodEntry>> {
  if (periods.length === 0) return new Map();
  const { rows } = await client.query<{ period: string; item_id: string; doc_id: string | null }>(
    `SELECT DISTINCT ON (i.properties ->> 'period') i.properties ->> 'period' AS period,
            i.id AS item_id, d.id AS doc_id
     FROM items i
     LEFT JOIN idempotency_keys k ON k.key = 'journal:' || $1::uuid::text || ':' || $2::text || ':' || (i.properties ->> 'period')
       AND k.database_id = i.database_id AND k.item_id = i.id
     LEFT JOIN docs d ON d.item_id = i.id AND d.kind = 'page'
     WHERE i.database_id = $1::uuid AND i.deleted_at IS NULL AND i.properties ->> 'type' = $2
       AND i.properties ->> 'period' = ANY($3::text[])
     ORDER BY i.properties ->> 'period', (k.item_id IS NOT NULL) DESC, i.id`,
    [journalDatabaseId, type, periods],
  );
  const items = await getItemsByIds(
    client,
    rows.map((row) => row.item_id),
  );
  const byId = new Map(items.map((item) => [item.id, item]));
  const result = new Map<string, JournalPeriodEntry>();
  for (const row of rows) {
    const item = byId.get(row.item_id);
    if (item) result.set(row.period, { item, docId: row.doc_id });
  }
  return result;
}

function pageMarkdown(page: PageStateRead): string {
  const doc = new Y.Doc();
  doc.gc = false;
  let result: string | undefined;
  let failure: { error: unknown } | undefined;
  let cleanupFailure: { error: unknown } | undefined;
  try {
    if (page.snapshot) Y.applyUpdate(doc, page.snapshot);
    for (const update of page.updates) Y.applyUpdate(doc, update);
    result = serializeBlocks(readPageBlocks(doc));
  } catch (error) {
    failure = { error };
  } finally {
    try {
      doc.destroy();
    } catch (error) {
      cleanupFailure = { error };
    }
  }
  if (failure && cleanupFailure) {
    throw new AggregateError([failure.error, cleanupFailure.error], "Page serialization and cleanup failed", {
      cause: failure.error,
    });
  }
  if (cleanupFailure) throw cleanupFailure.error;
  if (failure) throw failure.error;
  if (result === undefined) throw new Error("Page serialization returned no result");
  return result;
}

const periodType = z.enum(JOURNAL_PERIOD_TYPES);
interface Context {
  params: Record<string, string>;
}

export function createJournalPeriodReadRouteHandler(pool: Pool) {
  return async (ctx: Context): Promise<{ status: number; body: unknown }> => {
    const type = periodType.safeParse(ctx.params.type);
    if (!type.success) throw new ValidationError("Invalid journal period type", { field: "type" });
    const key = ctx.params.period;
    if (key === undefined) throw new ValidationError("Missing journal period", { field: "period" });
    return withTransaction(pool, async (client) => {
      const timezone = await getSystemTimezone(client);
      const parsed = parseJournalPeriodKey(type.data, key, timezone);
      const journal = await getDatabaseByModuleId(client, JOURNAL_MODULE_ID);
      if (!journal) throw new NotFoundError("Journal database not found");
      const path = describeJournalPeriods(parsed.reference.toJSDate(), timezone);
      const range = (value: { from: string; to: string }) => ({ from: value.from, to: value.to });
      const entry = (await findJournalPeriodEntries(client, journal.id, type.data, [key])).get(key);
      const weeks = type.data === "day" ? [path.week] : type.data === "month" ? weeksOfMonth(key) : [];
      const weekEntries = await findJournalPeriodEntries(
        client,
        journal.id,
        "week",
        weeks.map((week) => week.period),
      );
      const itemIds = [entry?.item.id, ...[...weekEntries.values()].map((value) => value.item.id)].filter(
        (id): id is string => id !== undefined,
      );
      const pages = new Map(
        (await readPageStatesForItems(client, itemIds)).map((page) => [page.itemId, pageMarkdown(page)]),
      );
      const markdown = (value: JournalPeriodEntry | undefined) => (value ? (pages.get(value.item.id) ?? null) : null);
      const result: Record<string, unknown> = {
        type: type.data,
        period: key,
        range: range(path[type.data]),
        path: Object.fromEntries(
          JOURNAL_PERIOD_TYPES.map((name) => [name, { period: path[name].period, range: range(path[name]) }]),
        ),
        today: DateTime.now().setZone(timezone).toISODate(),
        item: entry?.item ?? null,
        docId: entry?.docId ?? null,
        markdown: markdown(entry),
      };
      const weekBody = (week: { period: string; from: string; to: string }) => {
        const weekEntry = weekEntries.get(week.period);
        return {
          period: week.period,
          range: range(week),
          itemId: weekEntry?.item.id ?? null,
          docId: weekEntry?.docId ?? null,
          markdown: markdown(weekEntry),
        };
      };
      if (type.data === "day") {
        result.week = weekBody(path.week);
        const inbox = entry?.item.computed.inboxItems;
        result.inbox = Array.isArray(inbox) ? inbox : [];
      }
      if (type.data === "month") result.weeks = weeks.map(weekBody);
      return { status: 200, body: result };
    });
  };
}

export function createJournalPeriodEnsureRouteHandler(pool: Pool) {
  return async (ctx: Context): Promise<{ status: number; body: unknown }> => {
    const type = periodType.safeParse(ctx.params.type);
    if (!type.success) throw new ValidationError("Invalid journal period type", { field: "type" });
    const key = ctx.params.period;
    if (key === undefined) throw new ValidationError("Missing journal period", { field: "period" });
    const body = await withTransaction(pool, (client) => ensureJournalPeriodDoc(client, type.data, key));
    return { status: 200, body };
  };
}
