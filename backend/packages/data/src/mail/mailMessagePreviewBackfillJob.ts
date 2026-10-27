import type { Pool, PoolClient } from "pg";
import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import { withTransaction, requireAffectedRows } from "../db/pool.js";
import { forEachActiveTenant } from "../tenancy/forEachActiveTenant.js";
import { htmlToPlainText, buildMailPreview } from "./mailPlainText.js";

const PAGE_SIZE = 100;

/** Deploy enqueues system work after Graphile's schema and grants exist. */
export async function enqueueMailMessagePreviewBackfill(client: Pool | PoolClient): Promise<void> {
  await enqueueJob(
    client,
    CORE_TASK_NAMES.MAIL_MESSAGE_PREVIEW_BACKFILL,
    {},
    {
      jobKey: "mail-message-preview-backfill",
      maxAttempts: 3,
    },
  );
}

/** Each tenant's keyset page commits independently; a retry selects only remaining null fields. */
export async function handleMailMessagePreviewBackfillTask(pool: Pool): Promise<void> {
  await forEachActiveTenant(pool, async () => {
    let afterId: string | null = null;
    for (;;) {
      const page = await withTransaction(pool, async (client) => {
        const { rows } = await client.query<{ item_id: string; body: unknown; updated_at: Date }>(
          `SELECT m.item_id, i.properties -> 'body' AS body, i.updated_at
           FROM mail_message_meta m JOIN items i ON i.id = m.item_id AND i.tenant_id = m.tenant_id
           WHERE (m.preview_text IS NULL OR m.ingested_at IS NULL)
             AND ($1::uuid IS NULL OR m.item_id > $1)
           ORDER BY m.item_id LIMIT $2 FOR UPDATE OF i, m`,
          [afterId, PAGE_SIZE],
        );
        for (const row of rows) {
          const result = await client.query(
            `UPDATE mail_message_meta
             SET preview_text = COALESCE(preview_text, $2), ingested_at = COALESCE(ingested_at, $3)
             WHERE item_id = $1`,
            [
              row.item_id,
              buildMailPreview(htmlToPlainText(typeof row.body === "string" ? row.body : "")),
              row.updated_at,
            ],
          );
          requireAffectedRows(result, "mail message preview backfill");
        }
        return rows;
      });
      const last = page.at(-1);
      if (page.length < PAGE_SIZE || !last) break;
      afterId = last.item_id;
    }
  });
}
