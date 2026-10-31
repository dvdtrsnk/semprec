import type { Pool } from "pg";
import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import { requireAffectedRows, withTransaction } from "../db/pool.js";
import { forEachActiveTenant } from "../tenancy/forEachActiveTenant.js";
import { buildMailPreview } from "./mailPlainText.js";

const PAGE_SIZE = 200;
const BACKFILL_JOB_KEY = "mail-message-preview-backfill";

/** Enqueues the one-off backfill under a fixed job key, so repeated deploys collapse into one job. */
export async function enqueueMailMessagePreviewBackfill(pool: Pool): Promise<void> {
  await enqueueJob(
    pool,
    CORE_TASK_NAMES.MAIL_MESSAGE_PREVIEW_BACKFILL,
    {},
    { jobKey: BACKFILL_JOB_KEY, maxAttempts: 3 },
  );
}

interface BackfillCandidate {
  item_id: string;
  updated_at: Date;
  body: string | null;
}

/**
 * Fills `ingested_at` (from `items.updated_at`) and `preview_text` (from the item's `body`
 * property) on rows that predate those columns. Per tenant it walks `item_id` keyset pages, one
 * transaction per page (docs/adr/2026-09-28-chunked-transactions-for-large-background-sweeps.md).
 * Each column is only written while still NULL, so a second run changes nothing. The page's rows are
 * locked (`FOR UPDATE OF m`) so a concurrent delete cannot make an update match zero rows.
 */
export async function handleMailMessagePreviewBackfillTask(pool: Pool): Promise<void> {
  await forEachActiveTenant(pool, async () => {
    let afterItemId: string | null = null;
    for (;;) {
      const lastItemId: string | null = await withTransaction(pool, async (client) => {
        const { rows } = await client.query<BackfillCandidate>(
          `SELECT m.item_id, i.updated_at, i.properties->>'body' AS body
             FROM mail_message_meta m
             JOIN items i ON i.id = m.item_id
            WHERE (m.preview_text IS NULL OR m.ingested_at IS NULL)
              AND ($1::uuid IS NULL OR m.item_id > $1)
            ORDER BY m.item_id
            LIMIT $2
              FOR UPDATE OF m`,
          [afterItemId, PAGE_SIZE],
        );
        for (const row of rows) {
          const result = await client.query(
            `UPDATE mail_message_meta
                SET preview_text = COALESCE(preview_text, $2),
                    ingested_at = COALESCE(ingested_at, $3)
              WHERE item_id = $1`,
            [row.item_id, buildMailPreview(row.body ?? ""), row.updated_at],
          );
          requireAffectedRows(result, `mail message preview backfill for item ${row.item_id}`);
        }
        return rows.length === PAGE_SIZE ? (rows[rows.length - 1]?.item_id ?? null) : null;
      });
      if (lastItemId === null) return;
      afterItemId = lastItemId;
    }
  });
}
