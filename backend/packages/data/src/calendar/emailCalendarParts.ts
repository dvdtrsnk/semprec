// Reads the `text/calendar` and `application/ics` attachments that mail ingest wrote to blob storage.
import type { Readable } from "node:stream";
import type { Queryable } from "../db/pool.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";
import { ICALENDAR_MAX_BYTES } from "./icalendarParser.js";
import { logger } from "./logger.js";

interface CalendarPartRow {
  storage_key: string;
}

/** Destroys the stream on every exit, so an oversize part is not read to its end. */
async function readCapped(stream: Readable, maxBytes: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  const source: AsyncIterable<unknown> = stream;
  try {
    for await (const chunk of source) {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      if (!Buffer.isBuffer(bytes)) throw new TypeError("A blob stream yielded neither text nor bytes");
      total += bytes.length;
      if (total > maxBytes) return null;
      chunks.push(bytes);
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks);
}

/**
 * Parts whose recorded `byte_size` is within `ICALENDAR_MAX_BYTES`, decoded as UTF-8. A part that turns out
 * larger is skipped with a log line naming only the email and a reason code. Reads the caller's tenant's rows
 * (RLS plus `tenant_id = app_tenant_default()`); a failed storage read rejects with its own error.
 */
export async function readCalendarPartsOfEmail(
  client: Queryable,
  storage: Pick<BlobStorageWriter, "readStream">,
  emailItemId: string,
): Promise<string[]> {
  const { rows } = await client.query<CalendarPartRow>(
    `SELECT b.storage_key
       FROM mail_attachments a
       JOIN blobs b ON b.id = a.blob_id AND b.tenant_id = app_tenant_default()
      WHERE a.tenant_id = app_tenant_default() AND a.message_item_id = $1
        AND lower(a.content_type) IN ('text/calendar', 'application/ics')
        AND a.byte_size <= $2
      ORDER BY a.id`,
    [emailItemId, ICALENDAR_MAX_BYTES],
  );
  const texts: string[] = [];
  for (const row of rows) {
    const bytes = await readCapped(storage.readStream(row.storage_key), ICALENDAR_MAX_BYTES);
    if (bytes === null) {
      logger.warn({ emailItemId, reason: "part_over_limit" }, "calendar part skipped");
      continue;
    }
    texts.push(bytes.toString("utf8"));
  }
  return texts;
}
