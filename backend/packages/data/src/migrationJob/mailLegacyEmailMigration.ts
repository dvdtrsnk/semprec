import type { Pool, PoolClient } from "pg";
import { simpleParser, type AddressObject, type StructuredHeader } from "mailparser";
import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import { withTransaction, type Queryable } from "../db/pool.js";
import { resolveThreadId } from "../mail/threading.js";
import { getMailMessageMetaByMessageId, upsertMailMessageMeta, type MailEnvelope, type MailEnvelopeAddress } from "../mail/mailMessageMetaStore.js";
import { isDeliveryStatusReport } from "../mail/dsn.js";

/**
 * Reads back raw MIME bytes for a legacy Emails item, when some earlier process captured
 * them — no ingest path persists raw MIME today (issue #26's adapters deliberately stream
 * only structure + bounded parts, never a whole-message buffer; see imapFlowClient.ts's
 * header note), so this defaults to "never available." Dependency-injected the same way
 * `LibraryMetadataFetcher`/`MailSyncAdapterFactory` are (issue #25/#26): a composition root
 * that *does* have a raw-MIME source for some legacy rows supplies its own fetcher; this
 * package has no such source built in.
 */
export type LegacyRawMimeFetcher = (itemId: string) => Promise<Buffer | null>;
export const noopLegacyRawMimeFetcher: LegacyRawMimeFetcher = async () => null;

function legacyMessageId(itemId: string): string {
  // The original Message-ID is unrecoverable without raw MIME — a synthetic id, unique per
  // item, keeps `mail_message_meta.message_id`'s UNIQUE constraint satisfied without ever
  // colliding with a real one (no real Message-ID uses this domain).
  return `<legacy-migration-${itemId}@semprec-migration>`;
}

/** `"Name <addr>"` or a bare address, the shape `formatAddress`/`formatAddressList` (mail/ingest.ts) produce into `sender`/`recipients`. */
function parseAddressText(value: string): MailEnvelopeAddress | undefined {
  const match = value.match(/^(.*)<([^<>]+)>$/);
  if (match) {
    const name = match[1].trim();
    const address = match[2].trim();
    return address ? { name: name || undefined, address } : undefined;
  }
  const trimmed = value.trim();
  return trimmed ? { address: trimmed } : undefined;
}

/**
 * `recipients` (mail/ingest.ts's `formatAddressList`) is a plain `", "`-joined list — splitting
 * on `,` mis-parses a display name that itself contains a comma. Accepted degradation: this is
 * the "as far as possible" reconstruction path the issue's Task text anticipates, not the
 * fully-faithful raw-MIME path below.
 */
function parseAddressListText(value: string): MailEnvelopeAddress[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(parseAddressText)
    .filter((a): a is MailEnvelopeAddress => Boolean(a));
}

/** mailparser types a repeated header (e.g. multiple `To:` occurrences) as `AddressObject[]`, a single occurrence as one `AddressObject` — same shape gmailRestClient.ts's `toList` already normalizes. */
function toEnvelopeAddressList(value: AddressObject | AddressObject[] | undefined): MailEnvelopeAddress[] {
  const objects = Array.isArray(value) ? value : value ? [value] : [];
  return objects
    .flatMap((o) => o.value)
    .filter((a): a is { name: string; address: string } => Boolean(a.address))
    .map((a) => ({ name: a.name || undefined, address: a.address }));
}

interface LegacyItemRow {
  id: string;
  properties: Record<string, unknown>;
}

/**
 * Migrates one legacy Emails item (no `mail_message_meta` row — every item ingested through
 * `ingestEmailMessage` since issue #26 always gets one, so its absence is exactly the "legacy"
 * signal). Raw MIME, when the injected fetcher actually has it, is parsed with `mailparser` for
 * a fully faithful `envelope`/`threadId`/`messageId` (`migrationStatus: 'done'`); otherwise
 * this reconstructs as far as possible from the item's own `sender`/`recipients`/`name` display
 * properties (`migrationStatus: 'partial'`) — no References/In-Reply-To/Cc/Bcc were ever
 * persisted for these rows before this migration, so there is nothing to "discard": the
 * reconstructed row carries the maximum information legacy storage ever held.
 */
async function migrateLegacyItem(client: PoolClient, item: LegacyItemRow, fetchRawMime: LegacyRawMimeFetcher): Promise<void> {
  const rawMime = await fetchRawMime(item.id);

  if (rawMime) {
    const parsed = await simpleParser(rawMime);
    const references = Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [];
    const recoveredMessageId = parsed.messageId ?? null;
    // `upsertMailMessageMeta`'s `ON CONFLICT (message_id)` never changes `item_id` — if the
    // recovered Message-ID already belongs to a *different* item (a live-synced duplicate of
    // this same physical email, entirely possible for pre-#26 legacy rows with no dedup), a
    // blind upsert would silently update that other item's row and leave this legacy item with
    // no `mail_message_meta` of its own, which would then re-select (and re-fail) forever under
    // this job's `LEFT JOIN ... WHERE item_id IS NULL` idempotency check. Falling back to this
    // item's own synthetic id keeps every row's meta 1:1 with its item, at the cost of full
    // (`'done'`) fidelity for this one collision case.
    const existing = recoveredMessageId ? await getMailMessageMetaByMessageId(client, recoveredMessageId) : null;
    const collided = existing !== null && existing.itemId !== item.id;
    const messageId = recoveredMessageId && !collided ? recoveredMessageId : legacyMessageId(item.id);
    const envelope: MailEnvelope = {
      from: parsed.from?.value[0]?.address ? { name: parsed.from.value[0].name || undefined, address: parsed.from.value[0].address } : undefined,
      to: toEnvelopeAddressList(parsed.to),
      cc: toEnvelopeAddressList(parsed.cc),
      bcc: toEnvelopeAddressList(parsed.bcc),
    };
    // Same DSN/bounce classification ingest.ts applies at normal sync time — raw MIME gives
    // this migration the same Content-Type mailparser already parsed, so there is no reason
    // this path should leave every migrated DSN misclassified as an ordinary message.
    const contentType = parsed.headers.get("content-type") as StructuredHeader | undefined;
    const isDsn = isDeliveryStatusReport(contentType?.value, contentType?.params);
    const dsnOriginalMessageId = isDsn ? (parsed.inReplyTo ?? references[references.length - 1] ?? null) : null;
    // Ancestor linkage (references/inReplyTo point at *other* messages' ids, never this one's
    // own) stays intact even on a collision — only this message's own identifier needs to
    // change to avoid stealing the other item's row.
    const threadId = await resolveThreadId(client, {
      messageId,
      inReplyTo: parsed.inReplyTo,
      references,
      subjectHint: parsed.subject,
    });
    await upsertMailMessageMeta(client, {
      itemId: item.id,
      messageId,
      inReplyTo: parsed.inReplyTo ?? null,
      references,
      threadId,
      envelope,
      messageKind: isDsn ? "dsn" : "message",
      dsnOriginalMessageId,
      migrationStatus: collided ? "partial" : "done",
    });
    return;
  }

  const subject = typeof item.properties.name === "string" ? item.properties.name : undefined;
  const senderText = typeof item.properties.sender === "string" ? item.properties.sender : undefined;
  const recipientsText = typeof item.properties.recipients === "string" ? item.properties.recipients : undefined;
  const messageId = legacyMessageId(item.id);
  const envelope: MailEnvelope = {
    from: senderText ? parseAddressText(senderText) : undefined,
    to: recipientsText ? parseAddressListText(recipientsText) : [],
  };
  // No References/In-Reply-To ever existed for this row — resolveThreadId correctly gives it
  // a fresh thread of its own rather than guessing an ancestor.
  const threadId = await resolveThreadId(client, { messageId, subjectHint: subject });
  await upsertMailMessageMeta(client, {
    itemId: item.id,
    messageId,
    threadId,
    envelope,
    migrationStatus: "partial",
  });
}

export function mailLegacyEmailMigrationJobKey(emailsDatabaseId: string): string {
  return `mail-legacy-email-migration:${emailsDatabaseId}`;
}

export async function enqueueMailLegacyEmailMigration(client: Queryable, emailsDatabaseId: string): Promise<void> {
  await enqueueJob(
    client,
    CORE_TASK_NAMES.MAIL_LEGACY_EMAIL_MIGRATION,
    { emailsDatabaseId },
    { jobKey: mailLegacyEmailMigrationJobKey(emailsDatabaseId), maxAttempts: 3 },
  );
}

/**
 * Pages through every Emails item still missing a `mail_message_meta` row and backfills one.
 * Resumable the same way `propertyTypeMigration.ts`'s job is: a retry replays from the start
 * (no persisted cursor), but the `LEFT JOIN ... WHERE mm.item_id IS NULL` filter is itself the
 * idempotency check — an item this job already migrated now has a meta row and is skipped, so
 * a crash-and-retry can never double-process or duplicate one.
 */
export async function runMailLegacyEmailMigrationJob(
  pool: Pool,
  emailsDatabaseId: string,
  fetchRawMime: LegacyRawMimeFetcher = noopLegacyRawMimeFetcher,
): Promise<void> {
  const pageSize = 500;
  for (;;) {
    const listClient: PoolClient = await pool.connect();
    let rows: LegacyItemRow[] = [];
    try {
      const result = await listClient.query<LegacyItemRow>(
        `SELECT i.id, i.properties
         FROM items i
         LEFT JOIN mail_message_meta m ON m.item_id = i.id
         WHERE i.database_id = $1 AND i.deleted_at IS NULL AND m.item_id IS NULL
         ORDER BY i.id ASC
         LIMIT $2`,
        [emailsDatabaseId, pageSize],
      );
      rows = result.rows;
    } finally {
      listClient.release();
    }

    // Each item gets its own transaction: `migrateLegacyItem` can write both a `mail_threads`
    // row (via resolveThreadId) and the `mail_message_meta` row that references it — on a
    // shared auto-commit client, a failure in the second write would leave the first
    // committed and orphaned. Per-item (not one transaction for the whole page) so one bad
    // row can't roll back everything a page already migrated successfully.
    for (const row of rows) {
      await withTransaction(pool, (client) => migrateLegacyItem(client, row, fetchRawMime));
    }
    if (rows.length < pageSize) break;
  }
}

export async function handleMailLegacyEmailMigrationTask(
  pool: Pool,
  payload: { emailsDatabaseId: string },
  fetchRawMime?: LegacyRawMimeFetcher,
): Promise<void> {
  await runMailLegacyEmailMigrationJob(pool, payload.emailsDatabaseId, fetchRawMime);
}
